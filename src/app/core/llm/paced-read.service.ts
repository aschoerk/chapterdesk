/**
 * Paced reading of ALREADY-WRITTEN text — the reveal pump at arbitrary times.
 *
 * The streaming reveal (`StreamReveal` / `RevealQueue`) only runs while an LLM
 * is filling a fresh answer. This service reuses the SAME pump for existing
 * content: a list of text items (chapters / reader documents) is revealed one
 * unit (char or word) at a time at the configured reveal speed, then the next
 * item follows automatically. Nothing is persisted or mutated — callers render
 * the revealed slice while {@link isCurrent} matches their item.
 *
 * Consumers:
 *  - `ChatNodeComponent` — "Read" reveals the clicked chapter and all
 *    following chapters on the active path (growth + follow scroll).
 *  - `ChatReaderComponent` — reveals the open document and the following
 *    documents, advancing the reader's pages automatically.
 *
 * Because the pump only ever advances one unit at a time (clamped to the
 * buffer), every word is shown — the text never jumps to the end. `pause()`
 * freezes it exactly where it is; `resume()` continues from there.
 */
import { Injectable, inject, signal } from '@angular/core';
import { ChatViewPrefsService } from '../chat/chat-view-prefs.service';
import { StreamReveal, type StreamRevealPrefs } from './stream-reveal';
import {
  DEFAULT_PACED_WORDS_PER_SECOND,
  PACED_CHARS_PER_WORD,
  effectivePacedRate
} from './reading-time';

/** One piece of existing text (a chapter / reader node), in reading order. */
export interface PacedReadItem {
  /** Stable identity of the text (today: the ChatNode id). */
  key: string;
  /** The full text to reveal. */
  text: string;
}

/** Re-exported so consumers can import the pace defaults from the service. */
export { DEFAULT_PACED_WORDS_PER_SECOND, PACED_CHARS_PER_WORD };

@Injectable({ providedIn: 'root' })
export class PacedReadService {
  private readonly viewPrefs = inject(ChatViewPrefsService);

  /** True while a queue is being revealed. */
  readonly active = signal(false);
  /** True while the reveal is frozen (user pause). */
  readonly paused = signal(false);
  /** Key (node id) of the item currently being revealed. */
  readonly currentKey = signal<string | null>(null);
  /** Zero-based index of the current item in the queue. */
  readonly currentIndex = signal(0);
  /** Number of queued items. */
  readonly total = signal(0);
  /** The revealed slice of the CURRENT item — grows one unit at a time. */
  readonly revealedText = signal('');
  /**
   * Incremented on every MANUAL skip. Views that auto-scroll while paced
   * reading observe it to re-enable following after the user pressed an
   * arrow key (they had possibly scrolled up before).
   */
  readonly followTick = signal(0);

  private items: PacedReadItem[] = [];
  private index = 0;
  private reveal: StreamReveal | null = null;
  /** Generation token: `stop()`/`start()` invalidate an in-flight loop. */
  private run = 0;
  private resumeWaiters: Array<() => void> = [];

  /** True when `key` is the item being revealed right now. */
  isCurrent(key: string): boolean {
    return this.active() && this.currentKey() === key;
  }

  /**
   * Display override for a view that owns `key`:
   *  - `null` when paced reading is not running (render normally),
   *  - the revealed slice for the CURRENT item,
   *  - the full text for every other item (already-read and queued ones).
   */
  displayText(key: string, full: string): string | null {
    if (!this.active()) return null;
    return this.currentKey() === key ? this.revealedText() : full;
  }

  /**
   * The pace actually used when the slider is 0 ("instant"), expressed in the
   * currently selected unit. Used by the UI to show the real reading pace.
   */
  defaultRate(): number {
    return effectivePacedRate(0, this.viewPrefs.streamSpeedUnit());
  }

  /**
   * Reveal `items` in order at the configured pace. Restarts (stops) any run
   * already in progress. Items with empty text are skipped.
   */
  async start(items: PacedReadItem[]): Promise<void> {
    const list = (items ?? []).filter(i => !!i && typeof i.text === 'string' && i.text.length > 0);
    this.stop();
    if (!list.length) return;

    const token = ++this.run;
    this.items = list;
    this.index = 0;
    this.total.set(list.length);
    this.currentIndex.set(0);
    this.active.set(true);
    this.paused.set(false);
    // The first item becomes current SYNCHRONOUSLY so a view can swap to the
    // revealed slice right away (otherwise the full text flashes for a tick).
    this.currentKey.set(list[0].key);
    this.revealedText.set('');
    try {
      for (; this.index < list.length; this.index++) {
        if (token !== this.run) return;
        await this.waitWhilePaused();
        if (token !== this.run) return;
        const item = list[this.index];
        this.currentIndex.set(this.index);
        this.currentKey.set(item.key);
        this.revealedText.set('');
        await this.playItem(item, token);
      }
    } finally {
      if (token === this.run) this.reset();
    }
  }

  /** Freeze the reveal where it is (safe to call when not reading). */
  pause(): void {
    if (!this.active() || this.paused()) return;
    this.paused.set(true);
    this.reveal?.pause();
  }

  /** Resume a paused reveal from the frozen position. */
  resume(): void {
    if (!this.active() || !this.paused()) return;
    this.paused.set(false);
    this.reveal?.resume();
    this.flushResumeWaiters();
  }

  toggle(): void {
    if (this.paused()) this.resume();
    else this.pause();
  }

  /**
   * One second's worth of reveal units in the currently selected unit
   * (chars/s in char mode, words/s in word mode). This is the "pensum" the
   * arrow keys skip forward and repeat backward.
   */
  secondUnits(): number {
    return this.pacingPrefs().streamSpeed();
  }

  /**
   * Skip the reveal head by `seconds` seconds worth of text: `+1` jumps one
   * second's pensum forward (skipping ahead), `-1` rewinds one second's
   * pensum so that part is revealed again ("repeat").
   */
  skipSeconds(seconds: number): void {
    const reveal = this.reveal;
    if (!reveal || !this.active() || !seconds) return;
    reveal.skipUnits(seconds * this.secondUnits());
    this.followTick.update(t => t + 1);
  }

  /** Move the reveal head by whole lines (`+1` = down/forward, `-1` = up/back). */
  skipLines(lines: number): void {
    const reveal = this.reveal;
    if (!reveal || !this.active() || !lines) return;
    reveal.skipLines(lines);
    this.followTick.update(t => t + 1);
  }

  /** Stop the reveal and clear all state (revealed text falls back to full). */
  stop(): void {
    this.run++;
    const reveal = this.reveal;
    this.reveal = null;
    if (reveal) {
      reveal.flush();
      reveal.destroy();
    }
    this.flushResumeWaiters();
    this.reset();
  }

  // ------------------------------------------------------------------ pump

  private playItem(item: PacedReadItem, token: number): Promise<void> {
    return new Promise<void>(resolve => {
      const reveal = new StreamReveal(this.pacingPrefs(), content => {
        if (token === this.run) this.revealedText.set(content);
      });
      this.reveal = reveal;
      if (this.paused()) reveal.pause();
      // The whole text is already known: buffer it, then "finish" (which keeps
      // pacing the leftover because paceAfterComplete is forced on).
      reveal.update(item.text, '');
      reveal.finish(item.text, '').then(() => {
        reveal.destroy();
        if (this.reveal === reveal) this.reveal = null;
        resolve();
      });
    });
  }

  private pacingPrefs(): StreamRevealPrefs {
    const unit = this.viewPrefs.streamSpeedUnit();
    return {
      streamSpeedUnit: () => unit,
      // 0 would mean "instant" and defeat the whole point of paced reading.
      streamSpeed: () => effectivePacedRate(this.viewPrefs.streamSpeed(), unit),
      paceAfterComplete: () => true
    };
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused()) return Promise.resolve();
    return new Promise<void>(resolve => this.resumeWaiters.push(resolve));
  }

  private flushResumeWaiters(): void {
    const waiters = this.resumeWaiters.splice(0);
    for (const w of waiters) w();
  }

  private reset(): void {
    this.active.set(false);
    this.paused.set(false);
    this.currentKey.set(null);
    this.currentIndex.set(0);
    this.total.set(0);
    this.revealedText.set('');
    this.items = [];
    this.index = 0;
  }
}

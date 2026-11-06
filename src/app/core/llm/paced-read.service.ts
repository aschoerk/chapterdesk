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
import { Router } from '@angular/router';
import { ChatService } from '../chat/chat.service';
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

/** Which view hosts a paced read. */
export type PacedReadView = 'chat' | 'reader';

/**
 * Where the user was reading when they INTERRUPTED the pacing.
 *
 * Pausing is meant to be used: the user scrolls around, edits something,
 * opens settings, switches chats — and Resume must bring them back to exactly
 * this place. The point is captured by the view on {@link PacedReadService}
 * `pause()` and replayed by {@link PacedReadService} `resume()`.
 */
export interface PacedReadResumePoint {
  view: PacedReadView;
  /** Chat the reading belongs to (re-selected on resume). */
  chatId: string | null;
  /** Item (ChatNode id) that was being revealed. */
  nodeId: string | null;
  /** Reader: which document was open. */
  docIndex?: number;
  /** Reader: which page was shown. */
  page?: number;
  /** Chat tree: scroll offset of the message scroller. */
  scrollTop?: number;
}

/**
 * A view that can host a paced read: reports where it currently is and can be
 * put back there. Registered while the view is mounted, so the service can
 * restore the position even after the user navigated away and came back.
 */
export interface PacedReadHost {
  view: PacedReadView;
  capture(): PacedReadResumePoint | null;
  restore(point: PacedReadResumePoint): void;
}

/** Re-exported so consumers can import the pace defaults from the service. */
export { DEFAULT_PACED_WORDS_PER_SECOND, PACED_CHARS_PER_WORD };

@Injectable({ providedIn: 'root' })
export class PacedReadService {
  private readonly viewPrefs = inject(ChatViewPrefsService);
  private readonly chatService = inject(ChatService);
  private readonly router = inject(Router);

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

  /**
   * Where the user was when the pacing was INTERRUPTED — captured on `pause()`
   * and replayed on `resume()`. Lets the user wander off (scroll, edit, open
   * settings, switch chats) and still come back to the same place.
   */
  readonly resumePoint = signal<PacedReadResumePoint | null>(null);
  /** True while a reading view (chat page or reader) is mounted. */
  readonly viewLinked = signal(false);
  /**
   * Where the NEXT paced read must begin — set from a chapter's right-click
   * menu ("set next read position at the cursor"). Consumed by the next
   * {@link start}: the queue begins at that chapter, revealing from that
   * character offset on.
   */
  readonly pendingStart = signal<{ nodeId: string; offset: number } | null>(null);

  private items: PacedReadItem[] = [];
  private index = 0;
  private reveal: StreamReveal | null = null;
  /** Generation token: `stop()`/`start()` invalidate an in-flight loop. */
  private run = 0;
  private resumeWaiters: Array<() => void> = [];
  /** Mounted view that can capture/restore the reading position. */
  private host: PacedReadHost | null = null;
  /** A point whose view is not mounted yet (resume from another page). */
  private pendingRestore: PacedReadResumePoint | null = null;

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
   * Remember where the next paced read should start (chapter + character
   * offset, e.g. from the right-click menu at the cursor).
   */
  setNextReadPosition(nodeId: string, offset: number): void {
    this.pendingStart.set({ nodeId, offset: Math.max(0, Math.round(offset || 0)) });
  }

  /** Forget a pending read position (the next read starts at the beginning). */
  clearNextReadPosition(): void {
    this.pendingStart.set(null);
  }

  /** True when a pending read position points at `nodeId`. */
  hasNextReadPositionAt(nodeId: string): boolean {
    return this.pendingStart()?.nodeId === nodeId;
  }

  /**
   * Reveal `items` in order at the configured pace. Restarts (stops) any run
   * already in progress. Items with empty text are skipped.
   *
   * A pending "next read position" (see {@link setNextReadPosition}) is
   * CONSUMED here: the queue starts at that chapter and its first item begins
   * revealing from the recorded character offset.
   */
  async start(items: PacedReadItem[]): Promise<void> {
    let list = (items ?? []).filter(i => !!i && typeof i.text === 'string' && i.text.length > 0);
    this.stop();
    if (!list.length) return;

    const pending = this.pendingStart();
    let startAt = 0;
    if (pending) {
      const at = list.findIndex(i => i.key === pending.nodeId);
      if (at >= 0) {
        list = list.slice(at);
        startAt = Math.min(pending.offset, Math.max(0, list[0].text.length - 1));
      }
      // One-shot: the next run after this one starts normally again.
      this.pendingStart.set(null);
    }

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
    this.revealedText.set(startAt > 0 ? list[0].text.slice(0, startAt) : '');
    try {
      for (; this.index < list.length; this.index++) {
        if (token !== this.run) return;
        await this.waitWhilePaused();
        if (token !== this.run) return;
        const item = list[this.index];
        this.currentIndex.set(this.index);
        this.currentKey.set(item.key);
        const offset = this.index === 0 ? startAt : 0;
        this.revealedText.set(offset > 0 ? item.text.slice(0, offset) : '');
        await this.playItem(item, token, offset);
      }
    } finally {
      if (token === this.run) this.reset();
    }
  }

  /**
   * Move the CURRENT session to `nodeId` / `offset` of `items` right away,
   * keeping the paused state.
   *
   * Used by "set next read position" while the reading is paused: the user
   * wants the CONTINUATION to start at that spot, so it must take effect
   * immediately (a pending position would only apply to the next fresh start).
   */
  async relocate(items: PacedReadItem[], nodeId: string, offset: number): Promise<void> {
    const wasPaused = this.active() && this.paused();
    this.setNextReadPosition(nodeId, offset);
    // `start()` consumes the pending position and rebuilds the queue from it.
    const run = this.start(items);
    if (wasPaused) {
      // start() clears the pause — freeze again at the new spot.
      this.paused.set(true);
      // A later Resume must return HERE, not to the pre-relocation place.
      this.resumePoint.set(this.capturePoint());
    }
    await run;
  }

  /**
   * Freeze the reveal where it is (safe to call when not reading) and
   * remember the reading position, so `resume()` can return there after the
   * user used the pause to do something else.
   */
  pause(): void {
    if (!this.active() || this.paused()) return;
    this.paused.set(true);
    this.reveal?.pause();
    this.resumePoint.set(this.capturePoint());
  }

  /**
   * Resume a paused reveal from the frozen position AND return to the place
   * the user was reading: re-opens the chat, scrolls the chapter back into
   * view (or re-opens the reader's document/page) when they wandered off.
   */
  resume(): void {
    if (!this.active() || !this.paused()) return;
    this.paused.set(false);
    this.reveal?.resume();
    this.flushResumeWaiters();
    // Re-arm the view's follow-scroll: the user may have scrolled around
    // while paused, so the reading position must be found again.
    this.followTick.update(t => t + 1);
    void this.restoreView(this.resumePoint());
  }

  /**
   * Register the mounted reading view so pausing can capture its position and
   * resuming can put it back (called from the chat / reader constructors).
   */
  registerHost(host: PacedReadHost): void {
    this.host = host;
    this.viewLinked.set(true);
    const pending = this.pendingRestore;
    if (pending && pending.view === host.view) {
      this.pendingRestore = null;
      // The view was just created — let it render its content first.
      queueMicrotask(() => host.restore(pending));
    }
  }

  /**
   * The reading view is going away (route change / dialog page). Behaviour:
   * if a reveal is still RUNNING it is frozen and the position remembered —
   * otherwise the text would keep revealing invisibly behind another page and
   * a later Resume would land in the wrong place.
   */
  unregisterHost(host: PacedReadHost): void {
    if (this.host !== host) return;
    if (this.active() && !this.paused()) {
      // Capture BEFORE dropping the host: the elements are still rendered here.
      const point = host.capture();
      this.paused.set(true);
      this.reveal?.pause();
      if (point) this.resumePoint.set(point);
    }
    this.host = null;
    this.viewLinked.set(false);
  }

  /** Where the reading currently is, as a restorable point. */
  private capturePoint(): PacedReadResumePoint {
    const captured = this.host?.capture();
    if (captured) return captured;
    return {
      view: 'chat',
      chatId: this.chatService.currentChatId(),
      nodeId: this.currentKey()
    };
  }

  /** Re-open the chat/reader and put the view back on the paused position. */
  private async restoreView(point: PacedReadResumePoint | null): Promise<void> {
    if (!point) return;
    // Resume must return to the CHAT that was being read, even when the user
    // used the pause to look at another story.
    if (point.chatId && this.chatService.currentChatId() !== point.chatId) {
      try {
        await this.chatService.selectChat(point.chatId);
      } catch {
        /* best-effort — keep the reading going in whatever chat is open */
      }
    }
    const host = this.host;
    if (host && host.view === point.view) {
      host.restore(point);
      return;
    }
    // Reading view is not mounted (settings/dialogs/another page): remember
    // the point; `registerHost` replays it once the view is created.
    this.pendingRestore = point;
    const path = point.view === 'reader' ? '/read' : '/chat';
    if (this.router.url.split('?')[0] === path) return;
    try {
      await this.router.navigate([path]);
    } catch {
      /* best-effort */
    }
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
    this.resumePoint.set(null);
    this.pendingRestore = null;
    this.reset();
  }

  // ------------------------------------------------------------------ pump

  private playItem(item: PacedReadItem, token: number, startAt = 0): Promise<void> {
    return new Promise<void>(resolve => {
      const reveal = new StreamReveal(this.pacingPrefs(), content => {
        if (token === this.run) this.revealedText.set(content);
      }, { startAt });
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

/**
 * View-layer pacing for a streaming answer — the "reveal pump".
 *
 * The SSE stream accumulates text in a buffer; on every `onChunk` the caller
 * feeds the whole buffer here and we only PAINT the part the user is allowed
 * to see, paced at `streamSpeed` units per second (chars/s or words/s). When
 * `paceAfterComplete` is on, leftover text keeps revealing after the LLM
 * finished at the same speed instead of jumping to the end.
 *
 * This is the exact behaviour of the legacy `LlmService.streamAnswer` pump,
 * ported 1:1 after streaming moved into the orchestration flows — the only
 * difference is that painting is delegated to a callback, so the char/word
 * speed sliders keep working no matter which path streams the answer
 * (`streamAnswerNode` in flows/text-send.ts, `streamAppendOrchestrated` in
 * chat-node, …).
 *
 * The pump never owns the authoritative text — it only decides how much of
 * the accumulated buffer is revealed at any moment. `flush()` (instant reveal,
 * abort, error) and `finish()` (end of stream, optional pacing-after-complete)
 * are idempotent, and `destroy()` stops all scheduling.
 */

export interface StreamRevealPrefs {
  /** Units per second. 0 = instant reveal (show everything as it arrives). */
  streamSpeed(): number;
  streamSpeedUnit(): 'char' | 'word';
  /** After the LLM finishes, keep revealing the leftover at `streamSpeed`. */
  paceAfterComplete(): boolean;
}

/** Paints the currently revealed portion. Called from rAF ticks. */
export type StreamRevealPaint = (content: string, thinking: string) => void;

/** Leading whitespace + the (possibly still growing) next word, for word mode. */
const WORD_REVEAL_TAIL = /^[ \t\r\n]*[^ \t\r\n]*/;
/** One complete word unit = optional leading whitespace + word + trailing whitespace. */
const WORD_NEXT_UNIT = /^[ \t\r\n]*[^ \t\r\n]+[ \t\r\n]+/;

/** Safety net for a background tab that produced a huge dt between ticks. */
const MAX_CARRY = 8;

export class StreamReveal {
  private content = '';
  private thinking = '';
  private committed = 0;
  private carrying = 0;
  private lastTs = 0;
  private raf = 0;
  private pumpRunning = false;
  private llmFinished = false;
  private closed = false;
  /** When held, `update()` only buffers — nothing is painted until `activate()`. */
  private hold = false;
  /** User pause: the pump freezes mid-reveal (no progress, no painting). */
  private paused = false;
  /** Pending `finish()` resolution, used to settle it on flush/destroy. */
  private drainResolve: (() => void) | null = null;
  /** Pending drain watcher — re-armed by `resume()`. */
  private drainWatch: (() => void) | null = null;

  private readonly prefs: StreamRevealPrefs;
  private readonly paint: StreamRevealPaint;

  constructor(prefs: StreamRevealPrefs, paint: StreamRevealPaint, opts: { hold?: boolean } = {}) {
    this.prefs = prefs;
    this.paint = paint;
    this.hold = !!opts.hold;
  }

  /**
   * Un-pause a HELD pump: the buffered content starts revealing at the
   * configured pace from the current `committed` position (0 for a stream
   * that was never painted). A live (non-held) pump is unaffected.
   */
  activate(): void {
    if (this.closed) return;
    this.hold = false;
    this.paused = false;
    if (this.prefs.streamSpeed() <= 0) {
      this.flush();
      return;
    }
    this.pumpRunning = true;
    this.lastTs = 0;
    this.scheduleFrame(this.tick);
  }

  /**
   * Freeze the reveal where it is (used by the paced reader, which paces
   * ALREADY-WRITTEN text at arbitrary times). The pump keeps its buffer and
   * its carry; {@link resume} continues from the same position. Painting
   * stops immediately, so nothing advances behind the user's back.
   */
  pause(): void {
    if (this.closed) return;
    this.paused = true;
    this.haltPump();
  }

  /** Continue a paused reveal from the frozen position. */
  resume(): void {
    if (this.closed || !this.paused) return;
    this.paused = false;
    if (this.hold) return;
    if (this.prefs.streamSpeed() <= 0) {
      this.flush();
      return;
    }
    this.lastTs = 0;
    this.pumpRunning = true;
    this.scheduleFrame(this.tick);
    // A paused `finish()` left its watcher un-scheduled; re-arm it so the
    // promise settles when the reveal catches up.
    if (this.drainWatch) this.scheduleFrame(this.drainWatch);
  }

  /**
   * Swap the accumulated buffer to a (possibly different) final text — e.g.
   * the content actually persisted on the answer node after the evaluator
   * cleaned it up — and clamp `committed` so the reveal continues from where
   * it was. Paints the now-visible slice immediately (used right after a
   * versioned finalize so the node does not flash its full text).
   */
  rebase(content: string, thinking: string): void {
    if (this.closed) return;
    this.content = content;
    this.thinking = thinking;
    if (this.committed > content.length) this.committed = content.length;
    this.paintSafe();
  }

  /** How much of the buffer is currently revealed (useful for tests). */
  get revealed(): number {
    return Math.min(this.committed, this.content.length);
  }

  /** Full accumulated buffer (useful for tests / callers). */
  get full(): string {
    return this.content;
  }

  /**
   * Manually move the reveal head by `units` reveal units (chars in char
   * mode, words in word mode). Positive = forward (skip ahead), negative =
   * backward (re-show text that was already revealed — "repeat").
   *
   * The pump keeps running: after a forward jump it continues from the new
   * position; after a backward jump the text is re-revealed from there at the
   * same pace. Pacing stays frozen when the pump is paused.
   */
  skipUnits(units: number): void {
    if (this.closed || !Number.isFinite(units) || units === 0) return;
    this.moveTo(this.committed + units);
  }

  /**
   * Manually move the reveal head by whole source lines. Positive = reveal
   * through the next line break(s); negative = back to the start of the
   * previous line. Repeated presses advance/rewind one line at a time.
   */
  skipLines(lines: number): void {
    if (this.closed || !Number.isFinite(lines) || lines === 0) return;
    let pos = this.committed;
    const text = this.content;
    if (lines > 0) {
      for (let i = 0; i < lines && pos < text.length; i++) {
        const nl = text.indexOf('\n', pos);
        pos = nl >= 0 ? nl + 1 : text.length;
      }
    } else {
      for (let i = 0; i < -lines && pos > 0; i++) {
        // When sitting right after a line break, step over it first so one
        // press always moves a full line back.
        let from = pos - 1;
        while (from >= 0 && text[from] === '\n') from--;
        const nl = text.lastIndexOf('\n', from);
        pos = nl >= 0 ? nl + 1 : 0;
      }
    }
    this.moveTo(pos);
  }

  /** True when the whole buffer has been revealed. */
  get complete(): boolean {
    return this.committed >= this.content.length;
  }

  /** Set the reveal head to an absolute position and repaint. */
  private moveTo(position: number): void {
    const n = this.content.length;
    const next = Math.max(0, Math.min(n, Math.round(position)));
    this.committed = next;
    this.carrying = 0;
    this.paintSafe();
    if (next >= n) {
      this.haltPump();
      return;
    }
    // A forward jump from the very end (or a backward jump while the pump had
    // stopped) must restart pacing; a running pump just keeps going.
    if (!this.hold && !this.paused) this.kickPump();
  }

  /** Feed new streamed text; the pump reveals it at the configured speed. */
  update(content: string, thinking: string): void {
    if (this.closed) return;
    this.content = content;
    this.thinking = thinking;
    // A HELD pump only buffers — the background stream of the NEXT prepared
    // content accumulates here without painting until it becomes the front
    // item (`activate()`), so one bubble paints at a time.
    if (this.hold) return;
    this.kickPump();
  }

  /**
   * End of the SSE stream. Marks the stream finished and — when
   * `paceAfterComplete` is on — keeps revealing the leftover buffer at the
   * same speed. Resolves once the reveal caught up (or pacing is off).
   * Rejects never; an aborted signal or `destroy()` short-circuits it.
   */
  finish(content: string, thinking: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.content = content;
    this.thinking = thinking;
    this.llmFinished = true;
    return this.drainReveal(opts.signal);
  }

  /**
   * Reveal the whole buffer at once (instant speed, abort, error). Paints the
   * full content exactly once and stops the pump. Idempotent.
   */
  flush(): void {
    this.haltPump();
    this.llmFinished = true;
    this.committed = this.content.length;
    this.paintSafe();
    // Settle a pending `finish()` so an awaiting caller is never left hanging.
    const resolve = this.drainResolve;
    this.drainResolve = null;
    this.drainWatch = null;
    resolve?.();
  }

  /** Stop the pump and forget scheduled frames. No further painting. */
  destroy(): void {
    this.closed = true;
    this.haltPump();
    const resolve = this.drainResolve;
    this.drainResolve = null;
    this.drainWatch = null;
    resolve?.();
  }

  // ------------------------------------------------------------------ pump

  private visibleEnd(): number {
    const n = this.content.length;
    const rate = this.prefs.streamSpeed();
    if (rate <= 0 || this.committed >= n) return n;
    if (this.prefs.streamSpeedUnit() === 'char') return this.committed;
    // Word mode: reveal leading whitespace + the word being typed so the
    // current word grows letter by letter until its trailing space commits it.
    const tail = this.content.slice(this.committed).match(WORD_REVEAL_TAIL);
    return this.committed + (tail ? tail[0].length : 0);
  }

  private endOfNextUnit(from: number): number {
    if (from >= this.content.length) return from;
    if (this.prefs.streamSpeedUnit() === 'char') return from + 1;
    const m = this.content.slice(from).match(WORD_NEXT_UNIT);
    if (m) return from + m[0].length;
    // Last word has no trailing space until the model answers it — only
    // reveal it once the stream really finished (or when the buffer ends).
    return this.llmFinished ? this.content.length : from;
  }

  private haltPump(): void {
    this.pumpRunning = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private paintSafe(): void {
    if (this.closed) return;
    if (this.committed >= this.content.length) {
      this.paint(this.content, this.thinking);
    } else {
      this.paint(this.content.slice(0, this.visibleEnd()), this.thinking);
    }
  }

  /** Schedule on the frame loop; without one (tests/builds) reveal instantly. */
  private scheduleFrame(cb: FrameRequestCallback): void {
    if (this.closed) return;
    const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
      .requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(cb);
    } else {
      this.flush();
    }
  }

  private readonly tick = (ts: number): void => {
    if (!this.pumpRunning || this.closed || this.paused) return;
    const rate = this.prefs.streamSpeed();
    if (rate <= 0) {
      this.flush();
      return;
    }

    if (!this.lastTs) this.lastTs = ts;
    this.carrying += ((ts - this.lastTs) / 1000) * rate;
    this.lastTs = ts;
    if (this.carrying > MAX_CARRY) this.carrying = MAX_CARRY; // tab was in background

    while (this.carrying >= 1 && this.committed < this.content.length) {
      const next = this.endOfNextUnit(this.committed);
      if (next <= this.committed) break; // partial word; keep the carry
      this.committed = next;
      this.carrying -= 1;
    }

    this.paintSafe();

    if (this.pumpRunning) {
      if (this.committed < this.content.length) {
        this.raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
          .requestAnimationFrame?.(this.tick) ?? 0;
      } else {
        this.haltPump();
      }
    }
  };

  private kickPump(): void {
    if (this.closed || this.paused) return;
    if (this.prefs.streamSpeed() <= 0) {
      this.flush();
      return;
    }
    if (this.pumpRunning) {
      this.paintSafe();
      return;
    }
    this.pumpRunning = true;
    this.lastTs = 0;
    this.scheduleFrame(this.tick);
  }

  /** The old `drainReveal`: keep pacing the leftover after the stream ended. */
  private drainReveal(signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        this.drainResolve = null;
        this.drainWatch = null;
        // A HELD pump resolves without painting — it is still buffering for a
        // later promotion; only a live pump flushes to the full text.
        if (!this.hold) this.flush();
        resolve();
      };
      if (
        this.closed
        || signal?.aborted
        || this.hold
        || !this.prefs.paceAfterComplete()
        || this.prefs.streamSpeed() <= 0
        || this.committed >= this.content.length
      ) {
        finish();
        return;
      }
      const watch = () => {
        if (
          this.closed
          || signal?.aborted
          || this.hold
          || this.committed >= this.content.length
          || this.prefs.streamSpeed() <= 0
          || !this.prefs.paceAfterComplete()
        ) {
          finish();
          return;
        }
        // Paused: stop polling; `resume()` re-arms the watcher.
        if (this.paused) return;
        this.kickPump();
        this.scheduleFrame(watch);
      };
      this.drainResolve = finish;
      this.drainWatch = watch;
      this.kickPump();
      this.scheduleFrame(watch);
    });
  }
}
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

  private readonly prefs: StreamRevealPrefs;
  private readonly paint: StreamRevealPaint;

  constructor(prefs: StreamRevealPrefs, paint: StreamRevealPaint) {
    this.prefs = prefs;
    this.paint = paint;
  }

  /** How much of the buffer is currently revealed (useful for tests). */
  get revealed(): number {
    return Math.min(this.committed, this.content.length);
  }

  /** Full accumulated buffer (useful for tests / callers). */
  get full(): string {
    return this.content;
  }

  /** Feed new streamed text; the pump reveals it at the configured speed. */
  update(content: string, thinking: string): void {
    if (this.closed) return;
    this.content = content;
    this.thinking = thinking;
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
  }

  /** Stop the pump and forget scheduled frames. No further painting. */
  destroy(): void {
    this.closed = true;
    this.haltPump();
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
    if (!this.pumpRunning || this.closed) return;
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
    if (this.closed) return;
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
        this.flush();
        resolve();
      };
      if (
        this.closed
        || signal?.aborted
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
          || this.committed >= this.content.length
          || this.prefs.streamSpeed() <= 0
          || !this.prefs.paceAfterComplete()
        ) {
          finish();
          return;
        }
        this.kickPump();
        this.scheduleFrame(watch);
      };
      this.kickPump();
      this.scheduleFrame(watch);
    });
  }
}
import { StreamReveal, type StreamRevealPrefs } from './stream-reveal';

/**
 * Generic PRESENTER queue — decouples presenting (the paced reveal) from
 * generation (the LLM streaming that fills the buffers).
 *
 * Design: every generated item is a {@link RevealQueueSlot} with its own
 * reveal pump. Only the HEAD slot of the queue is ever presented (painted);
 * all slots behind it are BACKGROUND buffers — generation (`update`) fills
 * them without painting. When the head's reveal has fully drained (its
 * `finish` resolved), the queue advances and the next buffered slot becomes
 * the head automatically: this is the "conveyor belt" that lets a batch keep
 * pacing the current item's tail after the LLM stops while the next prepared
 * content's LLM call runs in the background.
 *
 * The special "presenting buffer is the one being filled" case (the LIVE head):
 * the presenter only ever reveals what the producer has made available — the
 * reveal advance is clamped to the accumulated buffer length, so it naturally
 * SLOWS DOWN to the input speed (stalls at the availability boundary when the
 * model is slower than the configured pace, and never jumps ahead).
 *
 * Because the queue owns only the ORDER of presentation, ANY batch/streaming
 * producer can use it out of the box: create a queue, `enqueue` a slot per
 * item, feed it from `onChunk`, and `finish` it once the reveal should drain.
 * Single items work too (a queue with one live head).
 */
export interface RevealQueueSlot {
  /** Stable slot id (e.g. the placeholder node id). */
  readonly id: string;
  /** Paint target (e.g. the node id) — swap to the versioned id after finalize. */
  targetId: string;
  /** True while this slot is the one currently presented. */
  readonly isFront: boolean;
  /** Feed new available content (from `onChunk`). Buffers when not front. */
  update(content: string, thinking: string): void;
  /**
   * The producer (LLM) has stopped and the final text is known. For the HEAD
   * slot this activates (if it was held) and keeps pacing the leftover tail at
   * the configured speed until fully revealed, then lets the queue advance to
   * the next buffered slot. Resolves once THIS slot's reveal drained. For a
   * background slot it resolves immediately (it is not presented yet).
   */
  finish(content: string, thinking: string, signal?: AbortSignal): Promise<void>;
  /** Swap to the authoritative persisted text + clamp (post-finalize display).
   *  Only paints while this slot is the head (background slots stay invisible). */
  rebase(content: string, thinking: string): void;
  /** Reveal the whole buffer instantly (error/abort). */
  flush(): void;
  /** Stop + evict this slot. No promotion happens (abort tears the batch down). */
  destroy(): void;
}

export type RevealQueuePaint = (slot: RevealQueueSlot, content: string, thinking: string) => void;

interface InternalSlot extends RevealQueueSlot {
  readonly id: string;
  targetId: string;
  reveal: StreamReveal;
}

/** Fired whenever the PRESENTED (head) slot changes, so the caller can keep
 *  follow-streaming / the thinking spinner on the node actually being painted
 *  (independent of which background buffer is generating). `null` = queue empty. */
export type RevealQueueHeadChange = (slotId: string | null) => void;

export class RevealQueue {
  private readonly prefs: StreamRevealPrefs;
  private readonly paint: RevealQueuePaint;
  private readonly onHeadChange?: RevealQueueHeadChange;
  private readonly slots: InternalSlot[] = [];

  constructor(prefs: StreamRevealPrefs, paint: RevealQueuePaint, opts: { onHeadChange?: RevealQueueHeadChange } = {}) {
    this.prefs = prefs;
    this.paint = paint;
    this.onHeadChange = opts.onHeadChange;
  }

  /** Number of slots currently enqueued. */
  get size(): number {
    return this.slots.length;
  }

  /** The currently-presented (head) slot, or null. */
  current(): RevealQueueSlot | null {
    return this.slots[0] ?? null;
  }

  isFront(slot: RevealQueueSlot): boolean {
    return this.slots[0] === slot;
  }

  /**
   * Enqueue a new slot. The head (queue was empty) is presented live unless
   * `held` is explicitly given; later slots are background buffers.
   */
  enqueue(id: string, opts: { held?: boolean } = {}): RevealQueueSlot {
    const held = opts.held ?? (this.slots.length > 0);
    const slot = new QueueSlot(this);
    slot.id = id;
    slot.targetId = id;
    slot.reveal = new StreamReveal(this.prefs, (content: string, thinking: string) => {
      // Only the head may paint — anything the reveal pump draws for a
      // background slot (e.g. a rebase clamp) stays invisible until promoted.
      if (this.isFront(slot)) this.paint(slot, content, thinking);
    }, { hold: held });
    this.slots.push(slot);
    if (this.slots.length === 1) this.onHeadChange?.(slot.id);
    return slot;
  }

  /** Remove a slot (abort/destroy). Never promotes the next one. */
  evict(slot: InternalSlot): void {
    const wasHead = this.slots[0] === slot;
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    if (wasHead) this.onHeadChange?.(this.slots[0]?.id ?? null);
  }

  /** The head slot revealed fully → drop it and start presenting the next. */
  advance(slot: InternalSlot): void {
    if (this.slots[0] !== slot) return;
    this.slots.shift();
    const next = this.slots[0];
    if (next) next.reveal.activate();
    this.onHeadChange?.(next?.id ?? null);
  }
}

/** Per-slot wiring: thin delegate from the public slot API to the reveal pump,
 *  applying the queue rules (head-only paint / head-only advance). */
class QueueSlot implements InternalSlot {
  id = '';
  targetId = '';
  reveal!: StreamReveal;

  constructor(private readonly queue: RevealQueue) {}

  get isFront(): boolean {
    return this.queue.isFront(this);
  }

  update(content: string, thinking: string): void {
    this.reveal.update(content, thinking);
  }

  finish(content: string, thinking: string, signal?: AbortSignal): Promise<void> {
    // Only the head can drain — a background slot is promoted first by the
    // queue before its finish is ever called (once it becomes the current item).
    if (!this.queue.isFront(this)) return Promise.resolve();
    // The head may have been created held (a buffered front) — start revealing.
    this.reveal.activate();
    this.reveal.rebase(content, thinking);
    return this.reveal.finish(content, thinking, { signal }).then(() => this.queue.advance(this));
  }

  rebase(content: string, thinking: string): void {
    if (this.queue.isFront(this)) this.reveal.rebase(content, thinking);
  }

  flush(): void {
    this.reveal.flush();
  }

  destroy(): void {
    this.reveal.destroy();
    this.queue.evict(this);
  }
}

import type { NodeAttachment } from '../../models/chat';
import type { LlmChunk } from './llm-sse';
import type { LlmImagePart } from './llm-message';
import type { EvalSlots } from './orchestration/types';
import type { ParsedUsage } from './usage';
import type { LlmLogEntry } from './llm-log.service';
import { type StreamRevealPrefs } from './stream-reveal';
import { RevealQueue, type RevealQueueSlot } from './reveal-queue';

/**
 * Two-phase streaming of ONE answer, shared by every sequential flow
 * (elaborate chapters, Continue/Switch-character batches, …).
 *
 * Presenting is DECOUPLED from generation through a {@link RevealQueue}:
 * every answer is a queue SLOT. Generation (`onChunk`) fills its buffer;
 * the queue presents only the HEAD slot at pace (slowing down to the input
 * speed when the head is the one being filled), buffers every later slot in
 * the background, and auto-promotes the next prepared item once the current
 * head has fully revealed — a seamless "conveyor belt" from one chapter to
 * the next that works for ANY batch producer, out of the box.
 *
 * Lifecycle (driven by the caller):
 *  - `startHeldAnswerStream(...)` creates the placeholder node and issues the
 *    LLM call into a queue slot. A slot that is the queue's head reveals live
 *    as chunks arrive; a background slot only buffers.
 *  - `streamDone` resolves the moment the SSE stream ends.
 *  - `finalize(signal)` persists the FULL answer (versioned editAssistant) —
 *    the data model is complete from here on, so the NEXT step's context is
 *    correct even though the tail is still revealing.
 *  - `drain(signal)` paces the reveal of the leftover to the full text on the
 *    (versioned) node; resolves when the reveal caught up (and the queue has
 *    advanced to the next prepared item, if any).
 *  - `abort()` flush + destroy (error / hard stop).
 */
export interface HeldAnswerStream {
  /** The placeholder assistant node the stream paints into (pre-finalize). */
  readonly placeholderNodeId: string;
  /** Resolves when the SSE stream ends (with the raw evaluator slots). */
  readonly streamDone: Promise<EvalSlots>;
  /** The finalized (versioned) answer node id, once `finalize` ran. */
  readonly answerNodeId: string | null;
  /** Full accumulated stream text (for the NEXT step's context if needed). */
  fullContent(): string;
  fullThinking(): string;
  fullImages(): LlmImagePart[];
  /** The FULL text persisted on the answer node (post-finalize). The next
   *  step's context must read THIS (via `historyOverrides`), not the node's
   *  clamped display slice, while the tail is still revealing. */
  finalContent(): string;
  /**
   * Persist the full answer (versioned editAssistant) the moment the stream
   * ends. Returns the versioned answer node id. Idempotent.
   */
  finalize(signal?: AbortSignal): Promise<string>;
  /**
   * Pace-reveal the leftover buffer to the full text on the (versioned) node.
   * Resolves when the reveal caught up (or pacing is off / instant).
   * Idempotent.
   */
  drain(signal?: AbortSignal): Promise<void>;
  /** Abort/error cleanup: flush + destroy the pump. */
  abort(): void;
  /**
   * The step never became the CURRENT one (a Stop / "Finish & stop" ended
   * the run while it was still being prepared, or while the previous node's
   * tail was revealing): abort its request, stop its reveal WITHOUT painting
   * and undo the nodes it created — as if that step had never been started.
   * Idempotent; a no-op once the answer was finalized.
   */
  discard(): Promise<void>;
}

/** Site-specific operations a held stream needs (flow env vs chat-node). */
export interface HeldAnswerStreamDeps {
  /** The reveal pacing prefs (streamSpeed / unit / paceAfterComplete). */
  readonly prefs: StreamRevealPrefs;
  /** Create the placeholder assistant node; returns its id. */
  createPlaceholderNode(): Promise<string>;
  /** Point the active path at a node (placeholder + finalized answer). */
  setActiveChild(parentId: string | null, childId: string): void;
  /** Start the single-answer generation (spinner + per-stream abort signal). */
  startGeneration(nodeId: string): AbortSignal;
  /** Paint a revealed slice onto a node (target may change after finalize). */
  paint(nodeId: string, content: string, thinking: string): void;
  /** Issue the LLM completion; MUST forward `onChunk` to the given callback. */
  runCompletion(opts: {
    nodeId: string;
    signal: AbortSignal;
    onChunk: (chunk: LlmChunk) => void;
  }): Promise<EvalSlots>;
  /**
   * Persist the FULL answer (versioned editAssistant), compute the final
   * chapter content (image-only answers filled with the direction) + the
   * attachments, re-parent adoptNodeIds and point the active path at the
   * versioned node. Returns the versioned answer node id AND the exact text
   * that was persisted (the next step's context override).
   */
  finalizeAnswer(opts: {
    placeholderId: string;
    finalContent: string;
    finalThinking: string;
    finalImages: LlmImagePart[];
    usage?: ParsedUsage;
    logEntry?: LlmLogEntry;
    adoptNodeIds?: string[];
    preserveAttachments?: NodeAttachment[];
  }): Promise<{ id: string; content: string }>;
  /** Flip one-shot excluded nodes (e.g. the lore guard) after a send. */
  markSentOnceExcluded(): Promise<void>;
  /** Re-point a log entry's nodeId to the versioned answer. */
  retargetLog(entry: LlmLogEntry, nodeId: string): void;
  /** Undo the placeholder answer node of a DISCARDED step (see
   *  {@link HeldAnswerStream.discard}). The caller undoes its own question /
   *  lore nodes. */
  discardAnswer?(opts: { placeholderId: string }): Promise<void>;
}

/**
 * Combine abort signals into one (the first abort wins). Used to tie the
 * per-stream controller (`startGeneration`) and the step's own DISCARD
 * controller to the CHAT operation signal, so a Stop also kills a stream that
 * is started right after the abort (the batch loops check the guard between
 * steps — a step that was already in its preparation awaits would otherwise
 * issue a FRESH request with a fresh controller and run to completion).
 * Falls back to a manual bridge when `AbortSignal.any` is unavailable.
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  if (list.length === 0) return new AbortController().signal;
  if (list.length === 1) return list[0];
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, list);
  const already = list.find(s => s.aborted);
  if (already) return already;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of list) s.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/** Start a two-phase streamed answer (see {@link HeldAnswerStream}). */
export async function startHeldAnswerStream(
  deps: HeldAnswerStreamDeps,
  opts: {
    hold?: boolean;
    queue?: RevealQueue;
    /**
     * The CHAT OPERATION signal (hard Stop). It aborts the LLM call of THIS
     * stream in addition to the per-stream controller, so a Stop that lands
     * while the step is still being prepared (placeholder/question creation)
     * never lets the request run on afterwards.
     */
    signal?: AbortSignal;
    /** Fired when the PRESENTED head of this (or the shared) queue changes —
     *  the private single-item queue path uses this; a caller-supplied shared
     *  queue already has its own onHeadChange wired at creation. */
    onHeadChange?: (nodeId: string | null) => void;
    adoptNodeIds?: string[];
    preserveAttachments?: NodeAttachment[];
  } = {}
): Promise<HeldAnswerStream> {
  const placeholderNodeId = await deps.createPlaceholderNode();

  // Presenting vs generation: the answer registers as a slot in a presenter
  // queue. A caller-provided queue is SHARED across a batch (later slots are
  // background-buffered and only revealed once promoted to the head); without
  // one, a private one-item queue is created (the single-stream case).
  const ownQueue = !opts.queue;
  const queue = opts.queue ?? new RevealQueue(
    deps.prefs,
    (slot, content, thinking) => deps.paint(slot.targetId, content, thinking),
    { onHeadChange: opts.onHeadChange ? id => opts.onHeadChange!(id) : undefined }
  );
  // The queue derives front/background from order; an explicitly-held first
  // slot (or a private single item) keeps the caller's `hold` intent.
  const slot: RevealQueueSlot = queue.enqueue(placeholderNodeId, {
    held: ownQueue ? !!opts.hold : undefined
  });

  const streamSignal = deps.startGeneration(placeholderNodeId);
  // The step's OWN abort controller: `discard()` uses it to kill a request
  // whose result must never reach the story.
  const discardAbort = new AbortController();
  // Tie the per-stream controller and the discard controller to the chat
  // operation signal: a hard Stop must kill this request even when it was
  // started right after the abort.
  const runSignal = combineAbortSignals(streamSignal, opts.signal, discardAbort.signal);

  let accContent = '';
  let accThinking = '';
  let accImages: LlmImagePart[] = [];
  let finalizedId: string | null = null;
  let finalContentValue = '';
  let slotsValue: EvalSlots | null = null;
  let finalized = false;
  let drained = false;
  let discarded = false;

  let resolveDone!: (slots: EvalSlots) => void;
  let rejectDone!: (err: unknown) => void;
  const streamDone = new Promise<EvalSlots>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  // Fire the LLM call; generation feeds the slot (background slots buffer,
  // the head reveals live at pace clamped to what has arrived).
  deps.runCompletion({
    nodeId: placeholderNodeId,
    signal: runSignal,
    onChunk: chunk => {
      if (chunk.content) accContent += chunk.content;
      if (chunk.thinking) accThinking += chunk.thinking;
      if (chunk.images?.length) accImages.push(...chunk.images);
      slot.update(accContent, accThinking);
    }
  }).then(
    slots => {
      slotsValue = slots;
      resolveDone(slots);
    },
    err => rejectDone(err)
  );

  return {
    placeholderNodeId,
    streamDone,
    get answerNodeId() {
      return finalizedId;
    },
    fullContent: () => accContent,
    fullThinking: () => accThinking,
    fullImages: () => accImages,
    finalContent: () => finalContentValue,
    async finalize(signal?: AbortSignal): Promise<string> {
      if (finalized) return finalizedId!;
      if (discarded) return placeholderNodeId;
      const slots = await streamDone;
      slotsValue = slots;
      const finalContent = slots.text?.value ?? accContent;
      const finalThinking = slots.thinking?.value ?? accThinking;
      const finalImages = slots.images?.value ?? accImages;
      const result = await deps.finalizeAnswer({
        placeholderId: placeholderNodeId,
        finalContent,
        finalThinking,
        finalImages,
        usage: slots.usage?.value ?? undefined,
        logEntry: slots.logEntry,
        adoptNodeIds: opts.adoptNodeIds,
        preserveAttachments: opts.preserveAttachments
      });
      finalizedId = result.id;
      finalContentValue = result.content;
      slot.targetId = result.id;
      if (slots.logEntry && result.id !== placeholderNodeId) {
        deps.retargetLog(slots.logEntry, result.id);
      }
      // The direction has now been sent — flip one-shot excluded nodes (the
      // chat-lore guard) so they document but never re-ship.
      await deps.markSentOnceExcluded();
      // Clamp the (versioned) node's display to the currently revealed slice
      // so the tail keeps pacing instead of flashing the full text.
      slot.rebase(result.content, finalThinking);
      finalized = true;
      return result.id;
    },
    async drain(signal?: AbortSignal): Promise<void> {
      if (drained || discarded) return;
      const slots = slotsValue;
      // Reveal the PERSISTED text (post-finalize) — for an image-only answer
      // that is the direction text, not the (empty) evaluator text.
      const finalContent = finalContentValue || (slots?.text?.value ?? accContent);
      const finalThinking = slots?.thinking?.value ?? accThinking;
      await slot.finish(finalContent, finalThinking, signal);
      drained = true;
    },
    abort(): void {
      slot.flush();
      slot.destroy();
    },
    async discard(): Promise<void> {
      if (discarded || finalized) return;
      discarded = true;
      // Kill the request FIRST (its result must not be persisted), then stop
      // the reveal without painting — the step never reached the screen.
      discardAbort.abort();
      slot.destroy();
      await streamDone.catch(() => undefined);
      await deps.discardAnswer?.({ placeholderId: placeholderNodeId });
    }
  };
}
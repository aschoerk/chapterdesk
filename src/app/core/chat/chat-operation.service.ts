import { Injectable, signal } from '@angular/core';

/**
 * Generation + multi-call operation lifecycle for the chat runner — fully
 * self-contained (pure signals + AbortControllers), extracted from
 * `ChatService`. It owns:
 *  - the answer-generation state (`generatingNodeIds` = ALL active streams —
 *    a batch pipelines several LLM streams concurrently, each with its OWN
 *    controller; `generatingNodeId` = the most recently started one for the
 *    toolbar/Stop; `presentedNodeId` = the node whose reveal is currently
 *    being PAINTED — the queue head, independent of who is generating),
 *  - the multi-call operation state (`operationLabel`, `operationAbort`,
 *    `isIllustrating`, `batchProgress`, graceful-stop flag, `beginOperation`/
 *    `endOperation`/`stopGeneration`).
 *
 * `ChatService` exposes the SAME signal instances and delegates the methods,
 * so all existing consumers keep working unchanged.
 */
/** What a multi-step progress counts: batched Continue / Multiple Characters
 *  repetitions, or the chapters of an elaborate chain. */
export type OperationProgressUnit = 'repetition' | 'chapter';

/** Progress of a running multi-step operation, or null when none is active.
 *  `current`/`total` are the numbers shown to the user — for chapters these
 *  are the CHAPTER numbers, so `total` is the destination chapter. */
export interface OperationProgress {
  current: number;
  total: number;
  unit: OperationProgressUnit;
}

@Injectable({ providedIn: 'root' })
export class ChatOperationService {
  /** The most recently STARTED generation node id (toolbar Stop / busy). */
  readonly generatingNodeId = signal<string | null>(null);

  /** ALL node ids with an active LLM stream (head + background buffers). */
  readonly generatingNodeIds = signal<Set<string>>(new Set());

  /**
   * The node whose reveal is currently being PRESENTED (painted) — the head
   * of a RevealQueue (or the single live stream). Follow-streaming and the
   * thinking/waiting spinner follow THIS node, NOT the newest generation, so
   * a background buffer filling in parallel never steals the reveal UI.
   */
  readonly presentedNodeId = signal<string | null>(null);

  private generationControllers = new Map<string, AbortController>();

  /** Label of a running multi-call operation
   *  ('title' | 'overview' | 'headings' | 'elaborate' | 'illustrate'), or null. */
  readonly operationLabel = signal<string | null>(null);

  /** True while an illustration STORYBOARD use case (planned-enblock /
   *  planned-scenes / storyboard-direct) is running — surfaces the Stop
   *  button in the chat toolbar, mirroring the elaborate flow. */
  readonly isIllustrating = signal(false);

  /** Progress of a batched Continue / Multiple Characters run (unit
   *  `repetition`) or of an elaborate chapter chain (unit `chapter`), or null
   *  when no such run is active. Rendered in the chat toolbar: the current
   *  repetition / chapter number plus the destination. */
  readonly batchProgress = signal<OperationProgress | null>(null);

  /**
   * True once the user asked to “stop after the current stream / step
   * completes”. The in-flight generation is deliberately NOT aborted (its
   * results are preserved and saved), but everything that would otherwise run
   * AFTER it (the next batch iteration, a further elaborate chapter, the next
   * headings call, …) stops. Lifecycle: set by requestGracefulStop(), cleared
   * when the next multi-call operation begins or the current one ends. Never
   * cleared by clearGeneration() — a batch finishes its current send through
   * clearGeneration() and must STILL see the flag on the next
   * shouldStopAfterCurrentStep() check.
   */
  readonly gracefulStop = signal(false);

  private operationAbort: AbortController | null = null;

  /**
   * Per-chat operation guard. A chat may run at most ONE streaming or batch
   * operation at a time — a second batch/streaming in the same chat would
   * mangle the message list / reveal queue. Different chats may run in
   * parallel; their own guard is independent.
   */
  private readonly activeChats = new Map<string, { label: string; controller: AbortController }>();

  /** Begin a multi-call operation (structure generation / elaborate).
   *  Returns an AbortSignal that aborts the WHOLE remaining process when the
   *  user presses Stop — not just the current in-flight LLM call. Any
   *  previously requested graceful stop belongs to an older operation and is
   *  dropped. */
  beginOperation(label: string): AbortSignal {
    this.operationAbort?.abort();
    this.operationLabel.set(label);
    this.gracefulStop.set(false);
    this.operationAbort = new AbortController();
    return this.operationAbort.signal;
  }

  /** Finish a multi-call operation (success / error / completion). */
  endOperation(): void {
    this.operationAbort = null;
    this.operationLabel.set(null);
    this.gracefulStop.set(false);
  }

  /** True when a chat already has a streaming or batch operation running. */
  isChatBusy(chatId: string): boolean {
    return this.activeChats.has(chatId);
  }

  /** Label of the running chat operation, or null. */
  chatBusyLabel(chatId: string): string | null {
    return this.activeChats.get(chatId)?.label ?? null;
  }

  /**
   * Begin a chat-scoped operation. Returns null when the chat is already busy
   * — a streaming answer or a batch is running — so the caller must NOT start
   * a second overlapping operation. The returned signal aborts the whole
   * chat-scoped operation when the user presses Stop.
   */
  beginChatOperation(chatId: string, label: string): AbortSignal | null {
    if (this.activeChats.has(chatId)) return null;
    const controller = new AbortController();
    this.activeChats.set(chatId, { label, controller });
    this.operationLabel.set(label);
    this.gracefulStop.set(false);
    this.operationAbort = controller;
    return controller.signal;
  }

  /** Finish a chat-scoped operation. */
  endChatOperation(chatId: string): void {
    const entry = this.activeChats.get(chatId);
    if (!entry) return;
    this.activeChats.delete(chatId);
    if (this.operationAbort === entry.controller) {
      this.operationAbort = null;
      this.operationLabel.set(null);
      this.gracefulStop.set(false);
    }
  }

  /** Stop the operation running in one chat (toolbar Stop for that chat). */
  stopChatOperation(chatId: string): void {
    const entry = this.activeChats.get(chatId);
    if (!entry) return;
    entry.controller.abort();
    this.activeChats.delete(chatId);
    if (this.operationAbort === entry.controller) {
      this.operationAbort = null;
      this.operationLabel.set(null);
      this.gracefulStop.set(false);
    }
  }

  /** True if the running multi-call operation was HARD-cancelled by the user
   *  (Stop). A graceful stop does NOT satisfy this — callers that would
   *  DISCARD an in-progress result on cancellation must keep using this. */
  isOperationCancelled(): boolean {
    return !!this.operationAbort?.signal.aborted;
  }

  /** Between-step guard for multi-call loops: true when the CURRENT step
   *  should be the last one executed — either the user pressed Stop (abort
   *  immediately) or asked to finish the current step first
   *  (requestGracefulStop). Loops check this BETWEEN transactions, so the
   *  currently running one always completes and its results are kept. */
  shouldStopAfterCurrentStep(): boolean {
    return this.gracefulStop() || !!this.operationAbort?.signal.aborted;
  }

  /**
   * Graceful stop: let the CURRENT stream / transaction run to completion —
   * the answer being created is preserved and saved — then stop whatever
   * would have followed it (further batch iterations, elaborate chapters,
   * headings, storyboard scenes). Unlike stopGeneration() this does NOT abort
   * the in-flight LLM call: the operation loops consult
   * shouldStopAfterCurrentStep() BETWEEN steps, so the current one always
   * finishes first.
   */
  requestGracefulStop(): void {
    this.gracefulStop.set(true);
  }

  /** Set the node currently being presented (painted) by a reveal queue, or
   *  null when nothing is being revealed. */
  setPresentedNode(nodeId: string | null): void {
    this.presentedNodeId.set(nodeId);
  }

  /** Cancel in-flight generation(s). With no arg, all active streams are
   *  aborted (used when an answer finishes / batch finally); with `nodeId` only
   *  that stream is aborted. Does NOT cancel a running multi-call operation. */
  clearGeneration(nodeId?: string): void {
    if (nodeId) {
      const c = this.generationControllers.get(nodeId);
      if (c) c.abort();
      this.generationControllers.delete(nodeId);
      this.generatingNodeIds.update(s => {
        const ns = new Set(s);
        ns.delete(nodeId);
        return ns;
      });
      if (this.generatingNodeId() === nodeId) this.generatingNodeId.set(null);
      return;
    }
    for (const c of this.generationControllers.values()) c.abort();
    this.generationControllers.clear();
    this.generatingNodeIds.set(new Set());
    this.generatingNodeId.set(null);
  }

  /**
   * Register an active LLM stream for a node and return its OWN abort signal.
   * Unlike the legacy single-slot behaviour, this does NOT cancel any other
   * in-flight stream — a batch pipelines several streams concurrently (the
   * head being revealed + background buffers), each keeping its own abort
   * controller.
   */
  startGeneration(nodeId: string): AbortSignal {
    const controller = new AbortController();
    this.generationControllers.set(nodeId, controller);
    this.generatingNodeId.set(nodeId); // primary = most recently started
    this.generatingNodeIds.update(s => new Set(s).add(nodeId));
    return controller.signal;
  }

  /** User-facing STOP: cancels ALL active answer generations AND any running
   *  multi-call operation (headings / elaborate / title / summary). */
  stopGeneration(): void {
    this.clearGeneration();
    this.operationAbort?.abort();
  }

  isGenerating(nodeId: string): boolean {
    return this.generatingNodeIds().has(nodeId);
  }
}
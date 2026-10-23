import { Injectable, signal } from '@angular/core';

/**
 * Generation + multi-call operation lifecycle for the chat runner — fully
 * self-contained (pure signals + AbortControllers), extracted from
 * `ChatService`. It owns:
 *  - the single-answer generation state (`generatingNodeId`, its abort
 *    controller, `clearGeneration`/`startGeneration`/`isGenerating`),
 *  - the multi-call operation state (`operationLabel`, `operationAbort`,
 *    `isIllustrating`, `batchProgress`, graceful-stop flag, `beginOperation`/
 *    `endOperation`/`stopGeneration`).
 *
 * `ChatService` exposes the SAME signal instances and delegates the methods,
 * so all existing consumers keep working unchanged.
 */
@Injectable({ providedIn: 'root' })
export class ChatOperationService {
  // Currently generating answer
  readonly generatingNodeId = signal<string | null>(null);

  /** Label of a running multi-call operation
   *  ('title' | 'overview' | 'headings' | 'elaborate' | 'illustrate'), or null. */
  readonly operationLabel = signal<string | null>(null);

  /** True while an illustration STORYBOARD use case (planned-enblock /
   *  planned-scenes / storyboard-direct) is running — surfaces the Stop
   *  button in the chat toolbar, mirroring the elaborate flow. */
  readonly isIllustrating = signal(false);

  /** Progress of a batched Continue / Switch characters run, or null. The
   *  current repetition index is shown below the answer node's spinner. */
  readonly batchProgress = signal<{ current: number; total: number } | null>(null);

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

  private currentAbortController: AbortController | null = null;
  private operationAbort: AbortController | null = null;

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

  /** Cancel any in-flight single-answer generation. Used between generations
   *  and when an answer finishes — it does NOT cancel a running multi-call
   *  operation. */
  clearGeneration(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.generatingNodeId.set(null);
  }

  startGeneration(nodeId: string): AbortSignal {
    this.clearGeneration(); // cancel any previous single-answer generation
    this.currentAbortController = new AbortController();
    this.generatingNodeId.set(nodeId);
    return this.currentAbortController.signal;
  }

  /** User-facing STOP: cancels the current answer generation AND any running
   *  multi-call operation (headings / elaborate / title / summary). */
  stopGeneration(): void {
    this.clearGeneration();
    this.operationAbort?.abort();
  }

  isGenerating(nodeId: string): boolean {
    return this.generatingNodeId() === nodeId;
  }
}
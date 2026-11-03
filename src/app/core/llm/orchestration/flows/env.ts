import type { EvalSlots, UsecaseContext } from '../types';
import { UsecaseContextFactory, type ModelRef } from '../context';
import { LlmOrchestratorService, type PrimitiveOptions } from '../orchestrator';
import { ChatService } from '../../../chat/chat.service';
import { LlmLogService } from '../../llm-log.service';
import type { RevealQueue } from '../../reveal-queue';

/** Runtime environment for structural flows. */
export interface FlowEnv {
  readonly cx: UsecaseContext;
  readonly factory: UsecaseContextFactory;
  readonly orch: LlmOrchestratorService;
  readonly write: ModelRef;
  readonly textExtras: Record<string, unknown>;
  readonly chatService: ChatService;
  readonly llmLog: LlmLogService;
  readonly signal?: AbortSignal;
  readonly onChunk?: PrimitiveOptions['onChunk'];
  /** The shared presenter queue for a sequential (batched) run. When set,
   *  each answer registers as a queue slot: the first is the live head,
   *  the rest are background-buffered and revealed in order. */
  readonly queue?: RevealQueue;
}

export type FlowController = (env: FlowEnv) => Promise<EvalSlots>;

/**
 * Handle for a HELD flow run (sequential flows — elaborate chapters, Continue
 * batches): the LLM call starts immediately (buffering when held), the caller
 * finalizes each answer the moment its stream ends (data complete → the next
 * step's context is correct) and drains its tail at pace while the next
 * prepared content streams in the background.
 */
export interface HeldRun {
  /** The user question node this step's answer streams under. */
  readonly questionNodeId: string;
  /** The placeholder assistant node the stream paints into (pre-finalize). */
  readonly placeholderNodeId: string;
  /** Resolves when the SSE stream ends (with the raw evaluator slots). */
  readonly streamDone: Promise<EvalSlots>;
  /** The finalized (versioned) answer node id, once `finalize` ran. */
  readonly answerNodeId: string | null;
  /** The FULL text persisted on the answer node (post-finalize) — the next
   *  step's context override while this tail is still revealing. */
  finalContent(): string;
  /** Persist the full answer (versioned) — returns the final EvalSlots. */
  finalize(signal?: AbortSignal): Promise<EvalSlots>;
  /** Pace-reveal the leftover tail to the full text on the (versioned) node. */
  drain(signal?: AbortSignal): Promise<void>;
  /** Abort/error cleanup: flush + destroy the reveal pump. */
  abort(): void;
}
import type { ChatMessage } from '../../../../models/chat';
import type { EvalSlots, ImageScene, UsecaseContext } from '../types';
import { UsecaseContextFactory, type ModelRef } from '../context';
import { LlmOrchestratorService, type PrimitiveOptions } from '../orchestrator';

/**
 * Runtime environment handed to every use-case controller: the static
 * context, the resolved models, the shared primitives, and pre-resolved
 * request extras (a controller should do no parameter resolution itself).
 */
export interface UsecaseEnv {
  readonly cx: UsecaseContext;
  readonly factory: UsecaseContextFactory;
  readonly orch: LlmOrchestratorService;
  readonly render: ModelRef;
  readonly plan: ModelRef;
  /** Drawing instruction with optional style applied. */
  readonly instruction: string;
  /** Context messages up to the current node (text-only for planning). */
  readonly contextMessages: ChatMessage[];
  /** The exact anchor prompt (instruction + node text). */
  readonly anchor: string;
  /** Pre-resolved IMAGE request extras (stream:false, no temp/thinking). */
  readonly imageExtras: Record<string, unknown>;
  /** Writing model for `append` (plain text send). */
  readonly write?: ModelRef;
  /** Pre-resolved TEXT request extras (keeps temp/thinking/stream). */
  readonly textExtras?: Record<string, unknown>;
  /** FULL chat up to (and including) the current node for `append`. */
  readonly sendMessages?: ChatMessage[];
  /** Node the final answer is persisted to (e.g. the streamed assistant
   *  answer node), for log attribution. Falls back to `cx.node.id`. */
  readonly nodeId?: string;
  /** Signals/callbacks forwarded from the caller. */
  readonly signal?: AbortSignal;
  readonly onChunk?: PrimitiveOptions['onChunk'];
  /** Progressive callback — fired as soon as scenes are ready while a
   *  storyboard use case (planned-enblock / planned-scenes / storyboard-
   *  direct) renders them one at a time, so a caller can paint the pictures
   *  on the chapter IMMEDIATELY instead of waiting for the whole run. Each
   *  call delivers the scenes rendered SO FAR (grows monotonically; scenes
   *  not yet attempted are omitted). */
  readonly onImages?: (scenes: ImageScene[]) => void;
}

/** Shared primitives a controller is allowed to call. */
export type UsecaseController = (env: UsecaseEnv) => Promise<EvalSlots>;
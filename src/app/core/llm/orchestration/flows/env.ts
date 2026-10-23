import type { EvalSlots, UsecaseContext } from '../types';
import { UsecaseContextFactory, type ModelRef } from '../context';
import { LlmOrchestratorService, type PrimitiveOptions } from '../orchestrator';
import { ChatService } from '../../../chat/chat.service';
import { LlmLogService } from '../../llm-log.service';

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
}

export type FlowController = (env: FlowEnv) => Promise<EvalSlots>;
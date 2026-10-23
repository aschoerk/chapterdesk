import { Injectable, inject } from '@angular/core';
import { ChatService } from '../../../chat/chat.service';
import { LlmLogService } from '../../llm-log.service';
import { UsecaseContextFactory, type BuildContext } from '../context';
import { LlmOrchestratorService, type PrimitiveOptions } from '../orchestrator';
import type { EvalSlots, UsecaseKind } from '../types';
import { makeSlot } from '../slots';
import type { FlowEnv, FlowController } from './env';
import {
  sendBranch,
  sendInsert,
  sendRegenerate,
  sendRewrite,
  sendPrepend,
  sendElaborate,
  sendChapterDescriptions
} from './sends';
import {
  structureTitle,
  structureOverview,
  structureHeading,
  structureHeadings,
  languageCheck,
  rewriteSelection
} from './structure';

const FLOW_CONTROLLERS: Partial<Record<UsecaseKind, FlowController>> = {
  'send-branch': sendBranch,
  'send-insert': sendInsert,
  'send-regenerate': sendRegenerate,
  'send-rewrite': sendRewrite,
  'send-prepend': sendPrepend,
  'send-elaborate': sendElaborate,
  'send-chapter-descriptions': sendChapterDescriptions,
  'structure-title': structureTitle,
  'structure-overview': structureOverview,
  'structure-heading': structureHeading,
  'structure-headings': structureHeadings,
  'language-check': languageCheck,
  'rewrite-selection': rewriteSelection
};

export function isFlowUsecase(usecase: UsecaseKind): boolean {
  return !!FLOW_CONTROLLERS[usecase];
}

export function flowControllerFor(usecase: UsecaseKind): FlowController {
  const c = FLOW_CONTROLLERS[usecase];
  if (!c) throw new Error(`No flow controller for ${usecase}`);
  return c;
}

/** Top-level entry for structural text-send flows. */
@Injectable({ providedIn: 'root' })
export class LlmFlowRunner {
  private readonly factory = inject(UsecaseContextFactory);
  private readonly orch = inject(LlmOrchestratorService);
  private readonly chatService = inject(ChatService);
  private readonly llmLog = inject(LlmLogService);

  async run(build: BuildContext, opts: { signal?: AbortSignal; onChunk?: PrimitiveOptions['onChunk'] } = {}): Promise<EvalSlots> {
    const cx = this.factory.buildContext(build);
    // Topic-scoped prompt versions apply to the request's chat.
    this.factory.setPromptTopic(this.factory.topicIdForChat(cx.chat));
    // An explicit model override (e.g. a model chosen in a dialog) wins over
    // the node's own model — see `send-elaborate`.
    const write = this.factory.resolveWriteModel(cx.node, build.vars.modelId, build.vars.providerId);
    if (!write || !this.factory.providerFor(write.model)) {
      return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
    }
    const textExtras = await this.factory.resolveTextExtras(write.model, cx.chat);
    const env: FlowEnv = {
      cx,
      factory: this.factory,
      orch: this.orch,
      write,
      textExtras,
      signal: opts.signal,
      onChunk: opts.onChunk,
      chatService: this.chatService,
      llmLog: this.llmLog
    };
    return flowControllerFor(cx.usecase)(env);
  }
}
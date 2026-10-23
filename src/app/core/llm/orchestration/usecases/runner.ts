import { Injectable, inject } from '@angular/core';
import type { EvalSlots, ImageScene, UsecaseKind, UsecaseVars } from '../types';
import { UsecaseContextFactory, type BuildContext } from '../context';
import { LlmOrchestratorService, type PrimitiveOptions } from '../orchestrator';
import { makeSlot } from '../slots';
import { isFlowUsecase, LlmFlowRunner } from '../flows';
import { ChatService } from '../../../chat/chat.service';
import type { UsecaseEnv, UsecaseController } from './env';
import { storyboardDirect, plannedEnblock, plannedScenes } from './storyboard';
import { renderFull, renderWindow, renderNode, imageGeneration, imageSend } from './renders';
import { append, appendWithImages } from './append';

// ---------------------------------------------------------------------------
// Dispatch — a plain if-chain, not a table.
// ---------------------------------------------------------------------------
export function pickUsecase(vars: UsecaseVars): UsecaseKind {
  const count = vars.count ?? 1;
  // Pure picture mode ALWAYS plans (regardless of count): the image model may
  // only ever see the derived picture descriptions, never the raw story text.
  // The planning pass is where the story scope (current beat vs last N beats,
  // i.e. historyMode / historyNodes) reaches a model at all.
  if (vars.purePictures) return 'planned-enblock';
  if (count > 1 && vars.planDescriptions === false) return 'storyboard-direct';
  if (count > 1 && vars.singleCall) return 'planned-enblock';
  if (count > 1) return 'planned-scenes';
  if (vars.historyMode === 'full') return 'render-full';
  if (vars.historyMode === 'window') return 'render-window';
  return 'render-node';
}

const CONTROLLERS: Partial<Record<UsecaseKind, UsecaseController>> = {
  'storyboard-direct': storyboardDirect,
  'planned-enblock': plannedEnblock,
  'planned-scenes': plannedScenes,
  'render-full': renderFull,
  'render-window': renderWindow,
  'render-node': renderNode,
  'image-generation': imageGeneration,
  'image-send': imageSend,
  'append': append,
  'append-with-images': appendWithImages
};

export function controllerFor(usecase: UsecaseKind): UsecaseController {
  const c = CONTROLLERS[usecase];
  if (!c) throw new Error(`No controller for ${usecase}`);
  return c;
}

/** Top-level entry: builds the env and runs the selected use case. */
@Injectable({ providedIn: 'root' })
export class LlmUseCaseRunner {
  private readonly factory = inject(UsecaseContextFactory);
  private readonly orch = inject(LlmOrchestratorService);
  private readonly flowRunner = inject(LlmFlowRunner);
  private readonly chatService = inject(ChatService);

  async run(build: BuildContext, opts: { signal?: AbortSignal; onChunk?: PrimitiveOptions['onChunk']; onImages?: (scenes: ImageScene[]) => void; nodeId?: string } = {}): Promise<EvalSlots> {
    const usecase = build.usecase;
    const cx = this.factory.buildContext(build);
    // Topic-scoped prompt versions apply to the request's chat.
    this.factory.setPromptTopic(this.factory.topicIdForChat(cx.chat));

    // Structural flows (branch/insert/regenerate/rewrite/prepend): delegate
    // to the flow runner, which handles its own env (write model + ChatService
    // for the chat mutation around the text send).
    if (isFlowUsecase(usecase)) {
      return this.flowRunner.run(build, opts);
    }

    // append / append-with-images: a text send — no image model needed.
    if (usecase === 'append' || usecase === 'append-with-images') {
      const write = this.factory.resolveWriteModel(cx.node);
      if (!write || !this.factory.providerFor(write.model)) {
        return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
      }
      // Current chat-lore: materialize a lore node in front of the direction
      // being sent (sent with this one direction, then deactivated).
      await this.chatService.ensureLoreNodeBefore(cx.chat.id, cx.node.id);
      // For append-with-images the controller rebuilds the messages WITH the
      // image interpretation; building a baseline here keeps the env valid.
      const sendMessages = this.factory.buildSendMessages(
        cx.chat.id,
        cx.node.id,
        build.vars.content
      );
      const textExtras = await this.factory.resolveTextExtras(write.model, cx.chat);
      const env: UsecaseEnv = {
        cx,
        factory: this.factory,
        orch: this.orch,
        render: write,   // unused for append* but required by the type
        plan: write,
        instruction: '',
        contextMessages: sendMessages,
        anchor: '',
        imageExtras: {},
        write,
        textExtras,
        sendMessages,
        nodeId: opts.nodeId,
        signal: opts.signal,
        onChunk: opts.onChunk,
        onImages: opts.onImages
      };
      return controllerFor(usecase)(env);
    }

    const render = this.factory.resolveImageModel(build.vars.modelId, build.vars.providerId);
    if (!render || !this.factory.providerFor(render.model)) {
      return { error: makeSlot('error', 'http', 'No image model is enabled.', {}) };
    }
    const plan = this.factory.resolvePlanModel(render, cx.node);
    const instruction = this.factory.styledDrawingInstruction(build.vars.style);
    // Full chat CONTEXT up to (not including) the current node; the anchor is
    // the scene text, appended by the use-case render step. The scene text is
    // `vars.promptText` when given (explicit picture prompt — the
    // `image-generation` "adapt prompt & re-render" flow), else `vars.content`
    // (illustrate-from-draft / storyboard override), else the node's content.
    // With `historyMode === 'window'` the context is bounded to the last
    // `historyNodes` BEATS — counted in ASSISTANT nodes only (the current
    // node is the anchor, so `historyNodes - 1` earlier chapters precede it;
    // user directions/lore never count toward the window). A window of 1
    // keeps NO preceding beat (the anchor alone is the current beat). The
    // same windowed context feeds the storyboard planning pass, so both
    // illustration and storyboarding can be grounded in a bounded slice of
    // the story instead of the complete chat.
    const cParentId = cx.node.parentId;
    const precedingNodes = build.vars.historyMode === 'window'
      ? Math.max(0, (build.vars.historyNodes ?? 1) - 1)
      : 0;
    const contextMessages = cParentId
      ? (build.vars.historyMode === 'window'
          ? this.factory.buildContextMessagesWindow(cx.chat.id, cParentId, precedingNodes)
          : this.factory.buildContextMessagesUpTo(cx.chat.id, cParentId))
      : [];
    const sceneText = build.vars.promptText ?? build.vars.content ?? cx.node.content ?? '';
    const nodeText = sceneText.trim() || '(no text)';
    const anchor = `${instruction}\n\n${nodeText}`;
    const imageExtras = await this.factory.resolveExtras(render.model, cx.chat);

    const env: UsecaseEnv = {
      cx,
      factory: this.factory,
      orch: this.orch,
      render,
      plan,
      instruction,
      contextMessages,
      anchor,
      imageExtras,
      nodeId: opts.nodeId,
      signal: opts.signal,
      onChunk: opts.onChunk,
      onImages: opts.onImages
    };
    return controllerFor(usecase)(env);
  }
}
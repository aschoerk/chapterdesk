import { Injectable, inject } from '@angular/core';
import { ChatNode, NodeAttachment } from '../../models/chat';
import { ModelEntry, ProviderConfig } from '../../models/chat-config';
import { ChatService } from '../../core/chat/chat.service';
import { SettingsService } from '../../core/settings/settings.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';
import { LlmLogService } from '../../core/llm/llm-log.service';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { isSentenceComplete, MAX_COMPLETION_DIRECTIONS } from '../../core/util/helpers';
import {
  imageOnlyAnswerContent,
  generatedImageAttachments,
} from '../../core/llm/orchestration';
import { isImageMime, resolvedMime } from '../../core/llm/llm-message';
import { type LlmImagePart } from '../../core/llm/llm-message';
import { StreamReveal } from '../../core/llm/stream-reveal';
import { RevealQueue } from '../../core/llm/reveal-queue';
import {
  startHeldAnswerStream,
  type HeldAnswerStream,
  type HeldAnswerStreamDeps,
} from '../../core/llm/held-answer-stream';
import { NodeActionState, type NodeActionKind } from './node-action-state';
import type { EditorController } from './editor-controller';

/** Fallback for the editable `structure.completeMessage` prompt template. */
export const COMPLETE_PRECEDING_MESSAGE_FALLBACK = 'complete the preceding message';

/** Everything the send path needs from the card (DOM + tree it owns). */
export interface SendHost {
  /** The node this card shows. */
  node(): ChatNode;
  /** Busy state of the card (one action at a time). */
  readonly actions: NodeActionState;
  /** Draft owner (text / attachments / selected model). */
  readonly editor: EditorController;
  enabledModels(): ModelEntry[];
  providers(): ProviderConfig[];
  /** The card's own model preference resolution. */
  resolvePreferredModelId(node: ChatNode): string;
  /** True for the in-thread composer (an empty, childless direction). */
  isUnsentQuestion(): boolean;
  /** Commit + close the inline editor (DOM/session concern of the card). */
  closeEditor(): void;
  /** Paint streamed text onto an in-flux answer node. */
  paintAnswer(nodeId: string, content: string, thinking: string): void;
  /** Re-target the card to a new node version (`activate.emit`). */
  onActivated(nodeId: string): void;
  /** Structural flows (branch / insert / …) stay on the card. */
  runFlow(
    usecase: 'send-branch' | 'send-insert',
    pending: 'branch' | 'insert',
    builder?: (build: { vars: Record<string, unknown> }) => void,
  ): Promise<boolean>;
}

/** A resolved composer send: what to persist and with which model. */
interface SendTarget {
  node: ChatNode;
  content: string;
  attachments: NodeAttachment[];
  chatId: string;
  model: ModelEntry;
  provider: ProviderConfig;
}

/**
 * Everything a chat-node card does to SEND: the composer send, Branch, Insert,
 * the Continue / Multiple-Characters batch, and the two streaming paths
 * (single raw stream + the "held" stream used by batches).
 *
 * Extracted out of `ChatNodeComponent` (see `docs/architecture/chat-ui.md`).
 * The boundaries chosen here:
 *
 *  - the DRAFT is read from {@link EditorController} — the send path never
 *    keeps its own copy;
 *  - the BUSY state is {@link NodeActionState} (one action at a time);
 *  - painting, closing the editor and `activate` remain card concerns and are
 *    reached through {@link SendHost};
 *  - the structural flows (branch / insert) stay on the card, because they own
 *    the flow runner wiring shared with regenerate / rewrite / prepend.
 *
 * Instance-scoped: provided in `ChatNodeComponent.providers`.
 */
@Injectable()
export class SendController {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly runner = inject(LlmUseCaseRunner);
  private readonly llmLog = inject(LlmLogService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  private host: SendHost | null = null;

  /** Wire the card (called once from its constructor). */
  bind(host: SendHost): void {
    this.host = host;
  }

  /** The busy state (or null before `bind`). */
  private get actions(): NodeActionState | null {
    return this.host?.actions ?? null;
  }

  // ------------------------------------------------------------------
  // Resolving the send
  // ------------------------------------------------------------------

  /** Resolve node/draft/model/provider, or null (with a toast) when unusable. */
  private resolveSendTarget(): SendTarget | null {
    const host = this.host;
    if (!host) return null;
    const node = host.node();
    const content = host.editor.contentDraft().trim();
    const attachments = host.editor.editAttachments();
    if (!content && attachments.length === 0) return null;

    const chatId = this.chatService.currentChatId();
    if (!chatId) return null;

    const modelId = host.editor.branchModelId() || host.resolvePreferredModelId(node);
    const model = host.enabledModels().find(
      m => m.modelId === modelId || m.id === modelId,
    );
    if (!model) {
      this.toast.error(this.i18n.t('node.modelMissing'));
      return null;
    }

    const provider = host.providers().find(p => p.id === model.providerId);
    if (!provider) {
      this.toast.error(this.i18n.t('node.providerMissing'));
      return null;
    }

    return { node, content, attachments, chatId, model, provider };
  }

  /**
   * Run one send under the chat operation signal + the card's busy state.
   * A second operation in the same chat is refused (`node.busy`), so two
   * producers can never interleave in one message list.
   */
  private async runSend(
    chatId: string,
    pending: Extract<NodeActionKind, 'send' | 'branch' | 'insert' | 'continue' | 'switchCharacters'>,
    work: () => Promise<void>,
  ): Promise<void> {
    const host = this.host;
    const actions = host?.actions;
    if (!host || !actions) return;
    const opSignal = this.chatService.beginChatOperation(chatId, 'stream');
    if (!opSignal) {
      this.toast.error(this.i18n.t('node.busy'));
      return;
    }
    // Keep the pending kind a composer shortcut ALREADY set (Continue /
    // Switch characters drive their own label through the send).
    if (pending !== 'continue' || actions.pending() !== 'continue') {
      actions.pending.set(pending);
    }
    actions.loading.set(true);
    try {
      await work();
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.failed', { error: err?.message || err }));
    } finally {
      actions.loading.set(false);
      actions.pending.set(null);
      this.chatService.endChatOperation(chatId);
    }
  }

  // ------------------------------------------------------------------
  // Composer send
  // ------------------------------------------------------------------

  /**
   * Send an unsent question (the in-thread composer): write the draft onto
   * this same node, then stream the answer.
   *
   * Text-only sends go through the orchestration `append` use case (full chat
   * history + topic system prompt via the request builder). Directions
   * carrying image attachments use `append-with-images`: the images are
   * described first by the image-interpret model and the description is merged
   * into the direction text (no binary images reach the writing model).
   */
  async sendDraft(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const target = this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, chatId, model, provider } = target;
    const actions = host.actions;

    const current = actions.pending();
    const pending = current === 'continue' || current === 'switchCharacters' ? current : 'send';
    await this.runSend(chatId, pending, async () => {
      const saved = await this.chatService.persistQuestion(
        chatId, node.id, content, attachments, model.modelId, model.providerId,
      );
      host.onActivated(saved.id);

      // Auto-generated meta directions (Continue, Multiple Characters) and
      // directions in a chat with the "auto-exclude directions" mode are sent
      // while they are the current question, but excluded from history
      // afterwards (the stream builder skips excluded history nodes and always
      // sends the final one).
      const isMetaDirection = actions.pending() === 'continue'
        || actions.pending() === 'switchCharacters';
      const chat = this.chatService.chats().find(c => c.id === chatId);
      if (isMetaDirection || chat?.autoExcludeDirections) {
        await this.chatService.patchNode(chatId, saved.id, { excludeFromContext: true });
      }

      if (!node.parentId) {
        const firstLine = content
          ? content.split('\n')[0].trim().slice(0, 80)
          : (attachments[0]?.name ?? '');
        if (firstLine && this.chatService.chats().find(c => c.id === chatId)?.title === 'New Chat') {
          await this.chatService.updateChatTitle(chatId, firstLine);
        }
      }

      const hasImages = attachments.some(
        a => isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:'),
      );
      if (hasImages) {
        await this.streamAppendOrchestrated(chatId, saved, content, model, provider, {
          usecase: 'append-with-images',
          attachments,
        });
        return;
      }

      await this.streamAppendOrchestrated(chatId, saved, content, model, provider);
    });
  }

  // ------------------------------------------------------------------
  // Single (raw) stream
  // ------------------------------------------------------------------

  /**
   * Stream one answer through the orchestration text-send use cases: the
   * request builder sends the FULL chat up to this node (+ topic system
   * prompt), the transport streams, and the evaluator folds the chunks into the
   * text slot — while `onChunk` paints the answer node LIVE during the SSE
   * stream. Placement (versioned editAssistant) goes through ChatService so the
   * chat stays consistent with the rest of the app.
   */
  private async streamAppendOrchestrated(
    chatId: string,
    question: ChatNode,
    content: string,
    model: ModelEntry,
    provider: ProviderConfig,
    opts: {
      usecase?: 'append' | 'append-with-images';
      attachments?: NodeAttachment[];
      emitActivate?: boolean;
    } = {},
  ): Promise<void> {
    const host = this.host;
    if (!host) return;

    // Close the inline editor NOW (commit the session + clear the draft),
    // mirroring the batch path timing — the editor does not stay in edit mode
    // after Send.
    host.closeEditor();

    // Placeholder answer bubble so the user sees it (and can Stop) streaming.
    const answerNode = await this.chatService.addNode(chatId, {
      parentId: question.id,
      role: 'assistant',
      content: '',
      thinking: '',
      modelId: model.modelId,
      providerId: model.providerId,
    });
    this.chatService.setActiveChild(question.id, answerNode.id);
    const signal = this.chatService.startGeneration(answerNode.id);
    // Single (raw) stream path — presented = the node being revealed.
    this.chatService.setPresentedNode(answerNode.id, chatId);
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    const usecase = opts.usecase ?? 'append';
    const vars = {
      content,
      ...(usecase === 'append-with-images' ? { attachments: opts.attachments } : {}),
    };

    let accContent = '';
    let accThinking = '';
    const accImages: LlmImagePart[] = [];
    // Reveal pump: pace the streamed answer at the configured chars/s or
    // words/s instead of painting the whole buffer on every chunk (restores
    // the legacy behaviour lost when streaming moved into the orchestration
    // flows). Painting is a view concern.
    const reveal = new StreamReveal(this.chatService.streamRevealPrefs(), (c, t) => {
      host.paintAnswer(answerNode.id, c, t);
    });
    try {
      const slots = await this.runner.run(
        { chat, node: question, usecase, vars },
        {
          signal,
          nodeId: answerNode.id,
          onChunk: chunk => {
            if (chunk.content) accContent += chunk.content;
            if (chunk.thinking) accThinking += chunk.thinking;
            if (chunk.images?.length) accImages.push(...chunk.images);
            reveal.update(accContent, accThinking);
          },
        },
      );

      // The model is done: keep revealing the leftover buffer at the chosen
      // speed (respecting paceAfterComplete) before the answer is finalized.
      await reveal.finish(accContent, accThinking, { signal });

      // append-with-images: persist the merged direction text (direction +
      // image description) ONTO the user node for real, so the description
      // stays available in the history. The interpretation RECORD is stored
      // too — it marks "the description is already part of this node's text",
      // so the same images are NOT interpreted again on a later send. The
      // attachments themselves remain on the node but are never sent to the
      // LLM (history is text-only).
      const interpretation = slots.interpretation?.value;
      const mergedDirection = interpretation?.content?.trim()
        ?? slots.direction?.value?.trim();
      if (mergedDirection && mergedDirection !== question.content?.trim()) {
        const attachments = interpretation
          ? [...(question.attachments ?? []), interpretation.record as NodeAttachment]
          : question.attachments;
        await this.chatService.patchNode(chatId, question.id, {
          content: mergedDirection,
          ...(interpretation ? { attachments } : {}),
        });
      } else if (interpretation) {
        // Content already matches — only store the record so re-sends skip.
        const attachments = [...(question.attachments ?? []), interpretation.record as NodeAttachment];
        await this.chatService.patchNode(chatId, question.id, { attachments });
      }

      // Prefer the evaluator's settled slots.
      const finalContent = slots.text?.value ?? accContent;
      const finalThinking = slots.thinking?.value ?? accThinking;
      const finalImages = slots.images?.value ?? accImages;
      // An IMAGE-ONLY answer (the writing model returned only pictures, no
      // text): fill the chapter with the original direction so it is not an
      // empty bubble — the generated image is attached below it.
      const chapterContent = imageOnlyAnswerContent(finalContent, question.content, finalImages);
      host.paintAnswer(answerNode.id, chapterContent, finalThinking);

      // An image-only answer (an image-capable model streamed pictures, no
      // text) must STILL be finalized with its attachments — otherwise it
      // stays an empty placeholder that renders as "Generation stopped".
      if (chapterContent.trim() || finalThinking.trim() || finalImages.length > 0) {
        const attachments = finalImages.length
          ? generatedImageAttachments(finalImages)
          : undefined;
        const versioned = await this.chatService.editAssistant(
          chatId, answerNode.id, chapterContent, attachments, finalThinking,
          slots.usage?.value ?? undefined,
        );
        this.chatService.setActiveChild(question.id, versioned.id);
        // For batch iterations on foreign leaves the card's `activate` output
        // is bound to THIS card's parent — activating the answer under the
        // foreign question directly via ChatService is the correct move.
        if (opts.emitActivate !== false) {
          host.onActivated(versioned.id);
        }
        // The call was logged under the placeholder id — the versioned answer
        // node that is kept must carry the usage/cost instead.
        if (slots.logEntry && versioned.id !== answerNode.id) {
          this.llmLog.retargetNode(slots.logEntry, versioned.id);
        }
      }
    } finally {
      // Show whatever arrived (error/abort) or nothing extra (success already
      // revealed + finalized); stop the pump either way.
      reveal.flush();
      reveal.destroy();
      this.chatService.clearGeneration(answerNode.id);
      if (this.chatService.presentedNodeId() === answerNode.id) {
        this.chatService.setPresentedNode(null, chatId);
      }
      // One-shot excluded nodes (e.g. the chat-lore node created with
      // `excludeAfterSend`) were just sent as part of this request: flip them
      // to permanently excluded so they document but never re-ship.
      await this.chatService.markSentOnceExcluded(chatId, question.id);
    }
  }

  // ------------------------------------------------------------------
  // Held stream (batches)
  // ------------------------------------------------------------------

  /**
   * HELD variant of `streamAppendOrchestrated` for the batched Continue /
   * Switch-characters flows. The answer registers as a slot in the shared
   * {@link RevealQueue}: the first becomes the live head (its reveal slows to
   * the input speed while the LLM fills it), every later one is a background
   * buffer — its LLM runs immediately but its text does NOT paint until the
   * queue promotes it once the previous head has fully revealed (one bubble
   * paints at a time, like a conveyor belt).
   */
  private async startHeldAppendStream(
    chatId: string,
    question: ChatNode,
    content: string,
    model: ModelEntry,
    provider: ProviderConfig,
    opts: {
      queue?: RevealQueue;
      emitActivate?: boolean;
      historyOverrides?: Record<string, string>;
      /** Chat operation signal — ties a hard Stop to this stream's request. */
      signal?: AbortSignal;
    } = {},
  ): Promise<HeldAnswerStream> {
    const host = this.host;
    if (!host) throw new Error('SendController is not bound to a card');
    // Close the inline editor NOW (commit the session), mirroring the Send
    // path timing.
    host.closeEditor();
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    const deps: HeldAnswerStreamDeps = {
      prefs: this.chatService.streamRevealPrefs(),
      createPlaceholderNode: async () => {
        const answerNode = await this.chatService.addNode(chatId, {
          parentId: question.id,
          role: 'assistant',
          content: '',
          thinking: '',
          modelId: model.modelId,
          providerId: model.providerId,
        });
        this.chatService.setActiveChild(question.id, answerNode.id);
        return answerNode.id;
      },
      setActiveChild: (p: string | null, c: string) => this.chatService.setActiveChild(p, c),
      startGeneration: (id: string) => this.chatService.startGeneration(id),
      paint: (nodeId: string, c: string, t: string) => host.paintAnswer(nodeId, c, t),
      runCompletion: async ({ nodeId, signal, onChunk }) => this.runner.run(
        {
          chat,
          node: question,
          usecase: 'append',
          vars: {
            content,
            ...(opts.historyOverrides ? { historyOverrides: opts.historyOverrides } : {}),
          },
        },
        { signal, nodeId, onChunk },
      ),
      finalizeAnswer: async fo => {
        // An IMAGE-ONLY answer: fill the chapter with the original direction
        // so it is not an empty bubble — the generated image is attached below.
        const chapterContent = imageOnlyAnswerContent(
          fo.finalContent, question.content, fo.finalImages,
        );
        const attachments = fo.finalImages.length
          ? generatedImageAttachments(fo.finalImages)
          : undefined;
        const versioned = await this.chatService.editAssistant(
          chatId, fo.placeholderId, chapterContent, attachments, fo.finalThinking, fo.usage,
        );
        this.chatService.setActiveChild(question.id, versioned.id);
        if (opts.emitActivate !== false) {
          host.onActivated(versioned.id);
        }
        return { id: versioned.id, content: chapterContent };
      },
      markSentOnceExcluded: () => this.chatService.markSentOnceExcluded(chatId, question.id),
      retargetLog: (entry, nodeId) => this.llmLog.retargetNode(entry, nodeId),
      discardAnswer: async ({ placeholderId }) => {
        this.chatService.clearGeneration(placeholderId);
        await this.chatService.deleteNode(chatId, placeholderId);
      },
    };

    return startHeldAnswerStream(deps, {
      queue: opts.queue,
      // A hard Stop aborts the chat operation signal — forward it so a send
      // whose preparation was still running when Stop was pressed never issues
      // its LLM request.
      signal: opts.signal,
    });
  }

  // ------------------------------------------------------------------
  // Continue / Switch-characters batch
  // ------------------------------------------------------------------

  /**
   * Chain `count` Continue / Multiple Characters sends across successive empty
   * leaf questions. Each send fills the current draft leaf, streams the answer,
   * and the chat-page draft housekeeping appends the next empty leaf, so the
   * loop simply targets the newest leaf every iteration. One Stop press aborts
   * the WHOLE batch (beginOperation → operationAbort). The current repetition
   * number is published via chatService.batchProgress so the answer node's
   * spinner can render it below the spinner.
   */
  async runDirectionBatch(
    direction: 'continue' | 'switchCharacters',
    count: number,
  ): Promise<void> {
    const host = this.host;
    if (!host || !host.isUnsentQuestion() || !host.actions.idle) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const modelId = host.node().modelId || host.resolvePreferredModelId(host.node());
    const model = host.enabledModels().find(
      m => m.modelId === modelId || m.id === modelId,
    );
    if (!model) {
      this.toast.error(this.i18n.t('node.modelMissing'));
      return;
    }
    const provider = host.providers().find(p => p.id === model.providerId);
    if (!provider) {
      this.toast.error(this.i18n.t('node.providerMissing'));
      return;
    }

    const content = direction === 'continue'
      ? (this.promptDefaults.effective('structure.continue') || 'continue')
      : (this.promptDefaults.effective('structure.switchCharacters') || 'switch characters');
    // Editable completion direction (Settings → Prompt defaults).
    const completionContent =
      this.promptDefaults.effective('structure.completeMessage') || COMPLETE_PRECEDING_MESSAGE_FALLBACK;

    // One Stop press cancels the whole batch. A chat may run only ONE
    // streaming/batch operation at a time — a second one is refused so the
    // message list cannot be mangled by two overlapping producers.
    const opSignal = this.chatService.beginChatOperation(
      chatId, direction === 'continue' ? 'continue' : 'switchCharacters',
    );
    if (!opSignal) {
      this.toast.error(this.i18n.t('node.busy'));
      return;
    }
    host.actions.pending.set(direction);
    host.actions.loading.set(true);
    this.chatService.batchProgress.set({ current: 1, total: count, unit: 'repetition' });
    const started: HeldAnswerStream[] = [];
    // A shared PRESENTER QUEUE decouples presenting from generation: each
    // iteration's answer is a slot — the first becomes the live head (its
    // reveal slows to the input speed while the LLM fills it), every later
    // iteration's LLM runs in the background BUFFERING its text (nothing
    // paints), and the queue reveals it in order once the previous head has
    // fully revealed.
    const queue = new RevealQueue(
      this.chatService.streamRevealPrefs(),
      (slot, c, t) => host.paintAnswer(slot.targetId, c, t),
      { onHeadChange: id => this.chatService.setPresentedNode(id, chatId) },
    );
    try {
      let current: HeldAnswerStream | null = null;
      // A hard Stop (aborted operation signal) ends the batch IMMEDIATELY:
      // every between-step check sees it, and the signal is forwarded into each
      // held stream so a step that is still being prepared cannot issue a fresh
      // request afterwards.
      const stopped = () =>
        opSignal.aborted || this.chatService.shouldStopAfterCurrentStep();
      for (let i = 1; i <= count; i++) {
        // Hard Stop aborts the operation; a graceful "Finish & stop" also ends
        // the batch, but only AFTER the current stream has finished and been
        // saved.
        if (stopped()) break;

        // The previous iteration's LLM has stopped — finalize it NOW (data
        // model complete), so THIS iteration's context is correct even though
        // its tail is still revealing.
        if (current) {
          await current.streamDone;
          await current.finalize(opSignal);
          // Release the single-answer generation slot so the next composer leaf
          // can be hung below (draft housekeeping is skipped while a generation
          // is active). The drain of the previous tail happens later on the
          // OPERATION signal, so it is unaffected.
          this.chatService.clearGeneration();
          // An answer that does not end like a proper sentence is completed by
          // a SEPARATE direction message before the next repetition starts.
          // The completion is a normal held step: it streams, finalizes and
          // drains like a repetition and becomes the `current` answer the next
          // repetition is chained under. A completion answer can itself stop
          // mid-sentence, so it is repeated — bounded by
          // MAX_COMPLETION_DIRECTIONS so a model that keeps truncating can
          // never loop forever.
          for (let attempt = 0; attempt < MAX_COMPLETION_DIRECTIONS; attempt++) {
            if (isSentenceComplete(current.finalContent())) break;
            if (stopped()) break;
            const completion = await this.runCompletionStep(
              chatId, current, completionContent, model, provider, queue, opSignal, started,
            );
            // Stopped (hard or graceful) or no composer leaf: the batch ends
            // with what is already in the story.
            if (!completion) {
              current = null;
              break;
            }
            current = completion;
          }
          if (!current) break;
        }

        // Make sure the active path ends on an empty draft question to send on
        // — hung under the previous (possibly freshly completed) answer.
        const leaf = await this.ensureDraftLeaf(chatId, current?.answerNodeId);
        if (!leaf) break;

        // The draft housekeeping above is async — a Stop / a "Finish & stop"
        // pressed while it ran must NOT start another repetition: the CURRENT
        // one is already complete, so the batch ends here.
        if (stopped()) break;

        // Publish the repetition that is actually about to generate. Doing it
        // HERE (not at the top of the loop) keeps "Repetition X of Y" in sync
        // with the live send: the top-of-loop slot still belongs to the
        // previous repetition, whose tail is only being revealed.
        this.chatService.batchProgress.set({ current: i, total: count, unit: 'repetition' });

        // Start THIS iteration's stream. The first becomes the queue HEAD
        // (reveals live at the pace, slowing to the input speed); every later
        // one is a BACKGROUND slot — its LLM runs immediately but its text
        // buffers (nothing paints) until the queue promotes it. The previous
        // answer's FULL text is passed as a history override so THIS
        // iteration's context is never truncated by the reveal clamp.
        const held = await this.sendDirectionOnce(chatId, leaf, content, model, provider, {
          queue,
          signal: opSignal,
          historyOverrides: current && current.answerNodeId
            ? { [current.answerNodeId]: current.finalContent() }
            : undefined,
        });
        started.push(held);
        // A Stop / "Finish & stop" that landed while this repetition was being
        // prepared (question persist / placeholder creation) ends the batch
        // with the PREVIOUS repetition: this one never became the current node,
        // so it is dropped together with the nodes it just created.
        if (stopped()) {
          await this.discardPrefetchedStep(chatId, leaf, held);
          if (current) await current.drain(opSignal);
          current = null;
          break;
        }
        if (current) {
          // Keep pacing the previous tail — `held` streams in the background;
          // once the tail fully reveals, the queue advances to `held`.
          await current.drain(opSignal);
          // A "Finish & stop" pressed while the tail was still revealing also
          // ends the batch with the CURRENT repetition: the step that was
          // prefetched in the background never reached the screen.
          if (this.chatService.gracefulStop()) {
            await this.discardPrefetchedStep(chatId, leaf, held);
            current = null;
            break;
          }
        }
        current = held;
      }
      // Final iteration.
      if (current) {
        await current.streamDone;
        await current.finalize(opSignal);
        await current.drain(opSignal);
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      this.toast.error(this.i18n.t('node.failed', { error: err?.message || err }));
    } finally {
      // Abort any still-running held streams (error / hard stop).
      for (const h of started) h.abort();
      this.chatService.batchProgress.set(null);
      this.chatService.clearGeneration();
      this.chatService.endChatOperation(chatId);
      host.actions.loading.set(false);
      host.actions.pending.set(null);
    }
  }

  /**
   * Ensure the active path ends on an empty user draft to send on. The previous
   * answer's reveal pump clamps its DISPLAYED content to the revealed slice
   * (empty while the tail is still pacing), so `ensureDraftAtLeaf`'s
   * content-based heuristic would treat it as an un-answered placeholder and
   * refuse to hang the next composer. Hang the draft under the FINALIZED answer
   * explicitly instead — through the SERIALIZED `ensureDraftUnderAnswer`, so
   * the chat-page housekeeping effect cannot create a SECOND empty leaf in the
   * same gap. Returns null when no usable draft could be produced.
   */
  private async ensureDraftLeaf(
    chatId: string,
    prevAnswerId: string | null | undefined,
  ): Promise<ChatNode | null> {
    let leaf = this.chatService.getActivePath().at(-1) ?? null;
    if (prevAnswerId) {
      // `finalized: true` — the previous answer's LLM already stopped and was
      // persisted; its DISPLAYED content is still clamped by the reveal pump,
      // so the empty-content heuristic must be skipped here.
      const ensured = await this.chatService.ensureDraftUnderAnswer(
        chatId, prevAnswerId, { finalized: true },
      );
      if (ensured) leaf = ensured;
    }
    if (!leaf || leaf.role !== 'user' || (leaf.content ?? '').trim()) {
      // Fall back to the generic draft housekeeping (e.g. right after a lore
      // send flips exclude flags async).
      await this.chatService.ensureDraftAtLeaf(chatId);
      leaf = this.chatService.getActivePath().at(-1) ?? null;
    }
    return leaf && leaf.role === 'user' && !(leaf.content ?? '').trim() ? leaf : null;
  }

  /**
   * Send the "complete the preceding message" direction as its OWN step and
   * drive it to a finalized + drained answer. Returns the completion stream
   * (the caller's new `current`), or null when the run was stopped or no
   * composer leaf could be produced.
   */
  private async runCompletionStep(
    chatId: string,
    prev: HeldAnswerStream,
    completionContent: string,
    model: ModelEntry,
    provider: ProviderConfig,
    queue: RevealQueue,
    opSignal: AbortSignal,
    started: HeldAnswerStream[],
  ): Promise<HeldAnswerStream | null> {
    const leaf = await this.ensureDraftLeaf(chatId, prev.answerNodeId);
    if (!leaf) return null;
    if (opSignal.aborted || this.chatService.shouldStopAfterCurrentStep()) return null;
    const completion = await this.sendDirectionOnce(
      chatId, leaf, completionContent, model, provider, {
        queue,
        signal: opSignal,
        historyOverrides: prev.answerNodeId
          ? { [prev.answerNodeId]: prev.finalContent() }
          : undefined,
      },
    );
    started.push(completion);
    // Keep pacing the previous tail, then run the completion step.
    await prev.drain(opSignal);
    if (this.chatService.gracefulStop()) {
      await this.discardPrefetchedStep(chatId, leaf, completion);
      return null;
    }
    await completion.streamDone;
    await completion.finalize(opSignal);
    await completion.drain(opSignal);
    if (opSignal.aborted || this.chatService.shouldStopAfterCurrentStep()) return null;
    return completion;
  }

  /**
   * Drop a prefetched batch step that never became the CURRENT repetition (a
   * Stop / "Finish & stop" ended the batch while it was being prepared, or
   * while the previous answer's tail was still revealing): abort its request,
   * stop its reveal without painting and undo the nodes it created — as if the
   * repetition had never been started.
   */
  private async discardPrefetchedStep(
    chatId: string,
    leaf: ChatNode,
    held: HeldAnswerStream,
  ): Promise<void> {
    await held.discard();
    // The step filled the composer leaf with the auto direction — empty it
    // again so the user's composer is exactly where it was before the press.
    await this.chatService.patchNode(chatId, leaf.id, {
      content: '',
      excludeFromContext: false,
    });
  }

  /**
   * Persist ONE direction onto a specific leaf question and start its stream.
   * Returns a HELD answer-stream handle (the caller drives finalize/drain), so
   * batched Continue / Switch-characters sends can pipeline: iteration N+1
   * streams in the background while iteration N's tail is still revealing.
   */
  private async sendDirectionOnce(
    chatId: string,
    leaf: ChatNode,
    content: string,
    model: ModelEntry,
    provider: ProviderConfig,
    opts: {
      queue?: RevealQueue;
      historyOverrides?: Record<string, string>;
      /** Chat operation signal — a hard Stop also aborts this send. */
      signal?: AbortSignal;
    } = {},
  ): Promise<HeldAnswerStream> {
    const host = this.host;
    if (!host) throw new Error('SendController is not bound to a card');
    // Only the FIRST iteration targets this card's own node, where the
    // parent's (activate) binding is valid. Foreign leaves (iterations 2+)
    // are activated directly through ChatService instead.
    const isOwn = leaf.id === host.node().id;
    const saved = await this.chatService.persistQuestion(
      chatId, leaf.id, content, [], model.modelId, model.providerId,
    );
    if (isOwn) {
      host.onActivated(saved.id);
    } else {
      this.chatService.setActiveChild(leaf.parentId ?? null, saved.id);
    }

    // Auto-generated meta directions (Continue, Multiple Characters) are sent
    // while they are the current question, but excluded from history after.
    await this.chatService.patchNode(chatId, saved.id, { excludeFromContext: true });

    if (!leaf.parentId) {
      const firstLine = content.split('\n')[0].trim().slice(0, 80);
      if (firstLine && this.chatService.chats().find(c => c.id === chatId)?.title === 'New Chat') {
        await this.chatService.updateChatTitle(chatId, firstLine);
      }
    }

    return this.startHeldAppendStream(chatId, saved, content, model, provider, {
      queue: opts.queue,
      signal: opts.signal,
      emitActivate: isOwn,
      historyOverrides: opts.historyOverrides,
    });
  }

  // ------------------------------------------------------------------
  // Branch / Insert (structural flows)
  // ------------------------------------------------------------------

  /**
   * Branch — create a new sibling question (a new leaf) and stream an answer.
   *
   * - From a question: sibling under the same parent.
   * - From an answer: new question whose parent is this answer (continues the
   *   thread from this point).
   */
  async saveAsBranchAndSend(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const target = this.resolveSendTarget();
    if (!target) return;
    const { content, attachments, model } = target;

    const ok = await host.runFlow('send-branch', 'branch', build => {
      build.vars['content'] = content;
      build.vars['attachments'] = attachments;
      // The model selected in the editor wins — the flow writer (and the new
      // question node) must use the freshly chosen model, not the node's.
      build.vars['modelId'] = model.modelId;
      build.vars['providerId'] = model.providerId;
    });
    // The draft was consumed to create the branch — close the editor so the
    // edit session is not left dangling (otherwise the next edit on this node
    // reopens a stale, dirty session).
    if (ok) host.closeEditor();
  }

  /**
   * Insert — like Branch (new sibling question + LLM answer with the same
   * prior-message context), then hang the previous question and its siblings
   * under that new assistant answer.
   */
  async saveAsInsertAndSend(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const target = this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, model } = target;
    if (node.role !== 'user') return;

    // The draft was consumed to create the insert: close the editor NOW
    // (commit the session) so it does not stay open while the insert flow
    // streams its answer — matching the Send path timing.
    host.closeEditor();

    await host.runFlow('send-insert', 'insert', build => {
      build.vars['content'] = content;
      build.vars['attachments'] = attachments;
      // The model selected in the editor wins — the flow writer (and the new
      // question node) must use the freshly chosen model, not the node's.
      build.vars['modelId'] = model.modelId;
      build.vars['providerId'] = model.providerId;
    });
  }
}

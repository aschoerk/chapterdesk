import { Injectable, inject, signal } from '@angular/core';
import { ChatNode, NodeAttachment } from '../../models/chat';
import { ChatService } from '../../core/chat/chat.service';
import { SettingsService } from '../../core/settings/settings.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { IllustrateDialogService } from '../../core/dialogs/illustrate-dialog.service';
import { newId } from '../../core/util/helpers';
import { ModelEntry, ProviderConfig, canGenerateImages } from '../../models/chat-config';
import {
  buildIllustrationAttachments,
  pickUsecase,
  type ImageScene,
} from '../../core/llm/orchestration';
import { decodeDataUrlToText, isImageMime, isTextualMime, resolvedMime } from '../../core/llm/llm-message';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { LlmPostprocessorService } from '../../core/llm/orchestration';
import { NodeActionState } from './node-action-state';

/** What a caller has to hand in — the DOM-dependent parts stay in the component. */
export interface IllustrationCallContext {
  /** The node the button belongs to (a direction node delegates to its chapter). */
  pressed: ChatNode;
  /**
   * The MARKED part of the node (editor selection or DOM selection inside the
   * rendered content); '' when nothing is marked. Captured by the component,
   * which owns the textarea / rendered-content refs.
   */
  markedSceneText?: string;
  /** Replaces the depicted node's content as the scene (an edited draft). */
  promptOverride?: string | null;
  /** Re-target the caller after a versioning write (`activate.emit`). */
  onActivated?: (nodeId: string) => void;
}

/**
 * Everything the "Illustrate" family of chat-node actions does:
 *  - generate one or more pictures for a beat (`illustrate`),
 *  - adapt a recorded prompt and re-render ONE scene (`rerenderPrompt`),
 *  - delete a recorded prompt (`deletePromptAttachment`),
 *  - the prompt-record attachment helpers + the storyboard progress signal
 *    that the node's buttons render.
 *
 * Extracted out of `ChatNodeComponent` because it is ~1000 lines of
 * near-duplicated action sequence (guard → resolve model → dialog → run the
 * use case → build attachments → version the chapter → report), and because
 * that sequence is where the bugs historically were. The component keeps thin
 * delegating members so the template and the existing 200+ specs keep working.
 *
 * Instance-scoped: provided in `ChatNodeComponent.providers`, so
 * `imageProgress` / the prompt-editor signals belong to ONE card.
 *
 * Everything it needs from the DOM (the marked text, the editor state) is
 * passed in per call — this class never touches `viewChild` refs.
 */
@Injectable()
export class IllustrationController {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly illustrateDialog = inject(IllustrateDialogService);
  private readonly runner = inject(LlmUseCaseRunner);
  private readonly postprocessor = inject(LlmPostprocessorService);
  private readonly actions = inject(NodeActionState);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  /** Progress of a storyboard run (done/total), set while `pending === 'image'`. */
  readonly imageProgress = signal<{ done: number; total: number } | null>(null);

  /** Which recorded prompt attachment is expanded inline (by attachment id). */
  readonly expandedPromptId = signal<string | null>(null);
  /** Which prompt attachment is being edited for re-render. */
  readonly editingPromptId = signal<string | null>(null);
  /** Live draft of the adapted prompt while editing a prompt record. */
  readonly promptEditDraft = signal('');

  /** Button label while generating — "Creating…" or "Creating 3/12…" in storyboard mode. */
  imageProgressLabel(): string {
    const p = this.imageProgress();
    return p && p.total > 1
      ? this.i18n.t('node.generatingImageCount', { done: p.done, total: p.total })
      : this.i18n.t('node.generatingImage');
  }

  // ------------------------------------------------------------------
  // Prompt-record attachments
  // ------------------------------------------------------------------

  /** A text attachment recording an image prompt (`prompt-N.txt`, `refused-prompt-N.txt`). */
  isPromptAttachment(a: NodeAttachment): boolean {
    return isTextualMime(resolvedMime(a))
      && /^(?:refused-)?prompt(?:-\d+)?\.txt$/i.test(a.name);
  }

  /** A prompt attachment that records a REFUSED / empty image generation. */
  isRefusedPromptAttachment(a: NodeAttachment): boolean {
    return isTextualMime(resolvedMime(a))
      && /^refused-prompt(?:-\d+)?\.txt$/i.test(a.name);
  }

  /** Decoded text of a (prompt) attachment, or ''. */
  attachmentText(a: NodeAttachment): string {
    return typeof a.dataUrl === 'string' ? (decodeDataUrlToText(a.dataUrl) ?? '') : '';
  }

  /**
   * The actual prompt portion of a recorded prompt attachment. For refused
   * records the body is "Prompt used:\n…\n\nModel reply:\n…" — this returns
   * only the prompt part so an adapted edit starts from the prompt alone.
   */
  promptAttachmentPrompt(a: NodeAttachment): string {
    const text = this.attachmentText(a);
    if (this.isRefusedPromptAttachment(a)) {
      const m = text.match(/^Prompt used\s*:\n([\s\S]*?)\n\s*\n\s*Model reply:/i);
      if (m && (m[1] ?? '').trim()) return m[1].trim();
    }
    return text.trim();
  }

  /** The scene number recorded in a `prompt-N.txt` / `refused-prompt-N.txt` name (or null). */
  promptRecordScene(a: NodeAttachment): number | null {
    const m = a.name.match(/^(?:refused-)?prompt-(\d+)\.txt$/i);
    return m ? Number(m[1]) : null;
  }

  /** True when `a` is an illustration paired with the given scene number. */
  isIllustrationForScene(a: NodeAttachment, scene: number): boolean {
    return isImageMime(resolvedMime(a)) &&
      new RegExp(`^illustration-${scene}\\.`, 'i').test(a.name);
  }

  /** Toggle the inline prompt text of a record (closes any open editor). */
  togglePrompt(a: NodeAttachment): void {
    const same = this.expandedPromptId() === a.id;
    this.editingPromptId.set(null);
    this.promptEditDraft.set('');
    this.expandedPromptId.set(same ? null : a.id);
  }

  /** Open the inline editor for a prompt record, pre-filled with the prompt used. */
  startPromptEdit(a: NodeAttachment): void {
    this.expandedPromptId.set(a.id);
    this.editingPromptId.set(a.id);
    this.promptEditDraft.set(this.promptAttachmentPrompt(a));
  }

  cancelPromptEdit(): void {
    this.editingPromptId.set(null);
    this.promptEditDraft.set('');
  }

  /**
   * Delete a recorded prompt attachment from the chapter (with confirmation).
   * Only the prompt trace/record is removed — a paired illustration, if any,
   * is kept. `editAssistant` versions the change, so the record stays
   * recoverable from prior versions.
   */
  async deletePromptAttachment(
    node: ChatNode,
    a: NodeAttachment,
    ctx: IllustrationCallContext
  ): Promise<void> {
    if (node.role !== 'assistant') return;
    if (!this.actions.idle || this.chatService.isGenerating(node.id)) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const ok = await this.confirm.ask({
      title: this.i18n.t('node.promptDeleteTitle'),
      message: this.i18n.t('node.promptDeleteMsg', { name: a.name }),
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;

    try {
      const rest = (node.attachments || []).filter(x => x.id !== a.id);
      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        rest,
        node.thinking ?? undefined
      );
      // Close any open inline editor for this attachment.
      if (this.expandedPromptId() === a.id) this.expandedPromptId.set(null);
      if (this.editingPromptId() === a.id) {
        this.editingPromptId.set(null);
        this.promptEditDraft.set('');
      }
      ctx.onActivated?.(saved.id);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.deleteFailed', { error: err?.message || err }));
    }
  }

  /**
   * Re-render ONE picture with the adapted prompt. The fresh image (and its
   * prompt file) replace the prompt record on the same chapter; every other
   * attachment stays. Runs the orchestration `image-generation` use case: a
   * single picture (no storyboard planning) — the adapted prompt IS the
   * concrete scene.
   */
  async rerenderPrompt(
    node: ChatNode,
    record: NodeAttachment,
    prompt: string,
    ctx: IllustrationCallContext
  ): Promise<void> {
    const text = (prompt ?? '').trim();
    const chatId = this.chatService.currentChatId();
    if (!text || !chatId) return;
    if (node.role !== 'assistant') return;
    if (!this.actions.idle || this.chatService.isGenerating(node.id)) return;

    this.actions.begin('image');
    this.imageProgress.set(null);
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId);
      if (!chat) return;

      // The orchestration `image-generation` use case resolves the image model
      // itself (image-create task → first enabled image-capable model), grounds
      // the picture in the context up to the chapter, forwards prior
      // illustrations as reference when the model can read images, and renders
      // the ADAPTED prompt as a single concrete scene — no storyboard planning.
      const promptText = `${this.i18n.t('node.imageAnchor', {
        role: this.i18n.t('node.roleAssistant')
      })}:\n${text}`;
      const result = await this.runner.run({
        chat,
        node,
        usecase: 'image-generation',
        vars: { promptText, count: 1 }
      });

      // A hard failure (e.g. no image model enabled) with no scene to fall
      // back on surfaces as an alert instead of silently doing nothing.
      const scenes = result.storyboard?.value ?? [];
      const images = result.images?.value ?? [];
      if (scenes.length === 0 && images.length > 0) {
        // No per-scene records but images came back (defensive — the
        // image-generation controller always emits a storyboard slot).
        scenes.push({ scene: 1, prompt: promptText, images, refused: false });
      }
      const imageCount = images.length;
      if (result.error?.status === 'error' && scenes.length === 0) {
        const reason = result.error.reason ?? '';
        if (/image model/i.test(reason)) {
          this.toast.error(this.i18n.t('node.imageModelMissing'));
          return;
        }
        throw new Error(reason || this.i18n.t('node.imageEmpty'));
      }

      const generated = buildIllustrationAttachments(scenes, promptText)
        .map(x => ({ ...x, id: x.id || newId() }));

      if (generated.length === 0) {
        const reply = (scenes[0]?.content ?? '').trim()
          || (result.text?.value ?? '').trim();
        throw new Error(
          reply
            ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
            : this.i18n.t('node.imageEmpty')
        );
      }

      // Replace the adapted record with the fresh result, renumbered to the
      // recorded scene number so it slots in next to the other storyboard
      // images instead of colliding with an existing `illustration-N`.
      const recordedScene = this.promptRecordScene(record);
      let rest = (node.attachments || []).filter(x => x.id !== record.id);
      if (recordedScene != null) {
        // For a SUCCESSFUL prompt (paired with an illustration), also drop the
        // old illustration of the same scene so the re-render REPLACES it
        // instead of duplicating the picture. A refused record has no image.
        rest = rest.filter(x => !this.isIllustrationForScene(x, recordedScene));
      }
      const placed = this.placeRerenderResult(generated, rest, recordedScene);
      const merged = [...rest, ...placed];

      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        merged,
        node.thinking ?? undefined
      );

      this.editingPromptId.set(null);
      this.promptEditDraft.set('');
      this.expandedPromptId.set(null);
      ctx.onActivated?.(saved.id);

      if (imageCount === 0) {
        // The model refused again (or returned nothing parseable): the updated
        // refused-prompt record was saved above so the adapted prompt stays
        // findable and pre-fills the next attempt — but there is STILL no
        // picture. Surface the model's reply instead of silently "succeeding"
        // (same as `illustrate`).
        const reply = (scenes[0]?.content ?? '').trim()
          || (result.text?.value ?? '').trim();
        this.toast.error(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      }
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      this.actions.end();
      this.imageProgress.set(null);
    }
  }

  /**
   * Renumber the result of a re-render: illustration + prompt files get the
   * recorded scene number when it is still free, otherwise the next free
   * number — so the re-rendered scene does not collide with other storyboard
   * attachments.
   */
  placeRerenderResult(
    attachments: NodeAttachment[],
    existing: NodeAttachment[],
    preferredScene: number | null
  ): NodeAttachment[] {
    const used = new Set<number>();
    for (const a of existing) {
      const m = a.name.match(/^(?:illustration|(?:refused-)?prompt)-(\d+)(\.\w+)?$/i);
      if (m) used.add(Number(m[1]));
    }
    let scene = preferredScene && !used.has(preferredScene) ? preferredScene : 0;
    if (!scene) {
      scene = 1;
      while (used.has(scene)) scene++;
      used.add(scene);
    }
    return attachments.map(a => {
      const ill = a.name.match(/^illustration-(\d+)(\.\w+)?$/i);
      if (ill) {
        used.add(scene);
        return { ...a, name: `illustration-${scene}${ill[2] ?? ''}` };
      }
      // Keep a re-refused attempt REFUSED (do not demote it to a success
      // "prompt" file — the model returned no picture for it).
      const re = a.name.match(/^refused-prompt-(\d+)(\.\w+)?$/i);
      if (re) return { ...a, name: `refused-prompt-${scene}${re[2] ?? '.txt'}` };
      const pr = a.name.match(/^prompt-(\d+)(\.\w+)?$/i);
      if (pr) return { ...a, name: `prompt-${scene}${pr[2] ?? '.txt'}` };
      return a;
    });
  }

  /**
   * Generate one or more pictures for the current beat with the configured
   * "image-create" generation task model (fallback: any enabled model that can
   * generate images). Opens the Illustrate dialog first to collect how many
   * scenes, the style, and (for >1 scenes) a storyboard prompt.
   *
   * A direction node delegates to the ASSISTANT chapter that responds to it —
   * the direction is only the instruction, the chapter is the beat to depict
   * (and the picture is attached to that chapter).
   */
  async illustrate(ctx: IllustrationCallContext): Promise<void> {
    const pressed = ctx.pressed;
    if (pressed.role !== 'user' && pressed.role !== 'assistant') return;
    if (!this.actions.idle || this.chatService.isGenerating(pressed.id)) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    // The node to depict is the CURRENT CHAPTER: when the button was pressed
    // on a direction (user) node, that is the assistant node right AFTER the
    // direction (the beat that responded to it) — `ctx.pressed` alone is the
    // wrong node there. The picture is always attached to that chapter.
    let chapter: ChatNode;
    if (pressed.role === 'assistant') {
      chapter = pressed;
    } else {
      const answers = this.chatService.getChildren(pressed.id)
        .filter(c => c.role === 'assistant' && c.isCurrent);
      const candidate = answers[0] ?? this.chatService.getChildren(pressed.id)
        .find(c => c.role === 'assistant');
      if (!candidate) {
        this.toast.error(this.i18n.t('node.imageNoChapter'));
        return;
      }
      chapter = candidate;
    }
    const anchorText = ctx.promptOverride ?? chapter.content ?? '';

    // 1. Prefer the configured image-create task model.
    let defaultModel = this.generation.modelFor('image-create') as ModelEntry | null;
    let defaultProvider = this.generation.providerFor('image-create') as ProviderConfig | null;
    // 2. Fall back to any enabled model that can generate images.
    if (!defaultModel || !defaultProvider) {
      const fallback = this.settings.enabledModels().find(canGenerateImages);
      if (fallback) {
        defaultModel = fallback;
        defaultProvider = this.settings.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!defaultModel || !defaultProvider) {
      this.toast.error(this.i18n.t('node.imageModelMissing'));
      return;
    }

    // Ask the user how many scenes, in which style, the storyboard prompt, and
    // which image model should render the picture(s). The dialog is seeded with
    // the default rendering model, but its own last-used selection (persisted
    // in localStorage) wins when still valid. When a part of the node content
    // is marked, the marked text seeds the dialog's "Scene to depict" field
    // (editable) so the pictures depict exactly that marked part in every use
    // case.
    const markedSceneText = (ctx.markedSceneText ?? '').trim();
    const options = await this.illustrateDialog.open({
      modelId: defaultModel.modelId,
      providerId: defaultModel.providerId,
      ...(markedSceneText ? { sceneText: markedSceneText } : {})
    });
    if (!options) return; // cancelled
    const {
      count, style, storyboardPrompt, purePictures, historyMode, historyNodes,
      storyboardHistoryNodes, planDescriptions
    } = options;
    // The marked text the user confirmed in the dialog (may have edited it).
    // Empty = use the whole chapter content as the scene (classic behavior).
    const sceneText = (options.sceneText ?? '').trim();

    // The dialog's options CHOOSE the orchestration use case:
    //   count > 1 || assistant chapter || pure mode → planning-based
    //   storyboards; single direction → render-node (current) / render-window
    //   (last N beats) / render-full (complete chat). `content` overrides the
    //   node text so an edited draft (promptOverride) is used as the scene.
    // The window width is remembered PER USE CASE: storyboards (count > 1)
    // use `storyboardHistoryNodes`, single pictures use `historyNodes`.
    const activeHistoryNodes = count > 1
      ? (storyboardHistoryNodes ?? historyNodes)
      : historyNodes;
    const vars = {
      count,
      style,
      storyboardPrompt,
      purePictures,
      historyMode,
      historyNodes: activeHistoryNodes,
      planDescriptions,
      // Reference images the user attached in the dialog (uploaded files or
      // images picked from the current chat) — forwarded to the image model so
      // it can keep characters / setting / style consistent.
      attachments: options.attachments ?? [],
      // The marked scene text (if any) overrides the whole chapter as the
      // scene — in ALL illustration use cases, planned / direct / pure.
      content: sceneText || anchorText,
      modelId: options.modelId || defaultModel.modelId,
      providerId: (options.modelId && options.providerId)
        ? options.providerId
        : defaultModel.providerId
    };
    const usecase = pickUsecase(vars);

    // Storyboard use cases render several pictures in stages: they take long
    // enough to warrant a Stop button, and each picture can be attached to the
    // chapter AS SOON AS it is ready (instead of waiting for the whole use case
    // to finish).
    const isStoryboard =
      usecase === 'planned-enblock' || usecase === 'planned-scenes' || usecase === 'storyboard-direct';

    const opSignal = this.chatService.beginChatOperation(chatId, 'illustrate');
    if (!opSignal) {
      this.toast.error(this.i18n.t('node.busy'));
      return;
    }
    this.actions.begin('image');
    this.imageProgress.set(null);

    // Where the pictures live DURING a storyboard run. Progressive writes
    // version the chapter node, so every write re-targets the LATEST version
    // and the final write replaces the interim attachments with the
    // authoritative placement plan (base attachments are captured once, at
    // start, and authoritative end state = base + final plan).
    let currentTargetId = chapter.id;
    const baseAttachments = [...(chapter.attachments ?? [])];
    const baseThinking = chapter.thinking ?? undefined;
    let interimChain: Promise<void> = Promise.resolve();
    let applySignal: AbortSignal | null = null;
    const onImages = isStoryboard
      ? (scenes: ImageScene[]): void => {
          const interim = buildIllustrationAttachments(scenes, anchorText)
            .map(a => ({ ...a, id: a.id || newId() }));
          // Serialize the progressive writes so they never race (each one
          // targets the node version returned by the previous write).
          interimChain = interimChain.then(async () => {
            try {
              const cur = this.chatService.nodes().find(n => n.id === currentTargetId) ?? chapter;
              const saved = await this.chatService.editAssistant(
                chatId,
                currentTargetId,
                cur.content || '',
                [...baseAttachments, ...interim],
                cur.thinking ?? baseThinking
              );
              currentTargetId = saved.id;
            } catch (err: any) {
              console.error(err);
            }
          });
        }
      : undefined;

    try {
      const chat = this.chatService.chats().find(c => c.id === chatId)!;
      if (isStoryboard) {
        // One Stop press cancels the whole illustrate use case: the returned
        // signal propagates into the orchestration runner so in-flight LLM
        // calls abort and no further scenes are rendered.
        applySignal = opSignal;
        this.chatService.isIllustrating.set(true);
      }
      const build = { chat, node: chapter, usecase, vars };
      const result = await this.runner.run(build, {
        signal: applySignal ?? undefined,
        ...(onImages ? { onImages } : {})
      });
      await interimChain; // flush any pending progressive writes

      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error

      // Place the pictures on the chapter node (illustration-N + prompt-N /
      // refused-prompt-N attachments), consistent with the app.
      const plan = this.postprocessor.plan(result, build);
      if (!plan) {
        throw new Error(this.i18n.t('node.imageNoChapter'));
      }

      let saved: ChatNode;
      if (isStoryboard) {
        // Replace the interim (progressively attached) pictures with the
        // authoritative final plan — the progressive writes above are
        // supersets of the start state, so this never duplicates.
        const cur = this.chatService.nodes().find(n => n.id === currentTargetId) ?? chapter;
        saved = await this.chatService.editAssistant(
          chatId,
          currentTargetId,
          cur.content || '',
          [...baseAttachments, ...plan.attachments],
          cur.thinking ?? baseThinking
        );
      } else {
        saved = await this.postprocessor.apply(plan, build);
      }
      ctx.onActivated?.(saved.id);

      const imagesTotal = plan.summary.imagesTotal;
      if (imagesTotal === 0) {
        // Everything was refused — the refused-prompt attachments were saved
        // above so the prompts stay findable; still inform the user. Prefer
        // the model's own refusal reply: it lives on the refused scenes'
        // `content` (storyboard-direct does NOT fill `result.text`), falling
        // back to the generic empty message (UX playbook §8: the user sees the
        // reason, not a generic failure).
        const refusedReply = (result.storyboard?.value ?? [])
          .find(s => (s.content ?? '').trim())?.content?.trim() ?? '';
        const reply = result.text?.value?.trim() ?? refusedReply;
        this.toast.error(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      } else if (count > 1 && imagesTotal < count) {
        // Storyboard partially completed — keep what was generated, tell the
        // user how many scenes came back.
        this.toast.info(this.i18n.t('node.imagePartial', {
          got: imagesTotal,
          want: count
        }));
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      this.toast.error(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      this.actions.end();
      this.imageProgress.set(null);
      if (isStoryboard) {
        this.chatService.isIllustrating.set(false);
      }
      this.chatService.endChatOperation(chatId);
    }
  }
}

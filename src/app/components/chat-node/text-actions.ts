import { Injectable, inject, signal } from '@angular/core';
import { ChatNode, NodeAttachment } from '../../models/chat';
import { ChatService } from '../../core/chat/chat.service';
import { NodeEditSession } from '../../core/chat/node-edit-session';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { RewriteDialogService } from '../../core/dialogs/rewrite-dialog.service';
import { CreateImageDialogService } from '../../core/dialogs/create-image-dialog.service';
import { ModelEntry, ProviderConfig, canGenerateImages } from '../../models/chat-config';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { buildIllustrationAttachments } from '../../core/llm/orchestration';
import { parseSuggestionVariants } from '../../core/llm/orchestration/evaluators';
import { markFragmentInSource } from '../../core/util/mark-fragment';
import { newId } from '../../core/util/helpers';
import { NodeActionState } from './node-action-state';
import type { EditorController } from './editor-controller';
import type { IllustrationController } from './illustration-controller';

/** The text currently marked inside the open editor. */
export interface EditorSelection {
  start: number;
  end: number;
}

/**
 * What the text actions need from the card. The card owns the DOM (textarea
 * and rendered-content refs), so selections and caret restoration are reached
 * through these callbacks instead of `viewChild`.
 */
export interface TextActionsHost {
  /** The node this card shows. */
  node(): ChatNode;
  /** True while the inline editor of this card is open. */
  isEditing(): boolean;
  /** Busy state of the card (one action at a time). */
  readonly actions: NodeActionState;
  /** Draft owner (text + attachments + the selected model). */
  readonly editor: EditorController;
  /** Story signals used by the illustrate controller (image progress). */
  readonly illustration: IllustrationController;
  /** Single-session edit state (draft hand-off). */
  readonly editSession: NodeEditSession;
  enabledModels(): ModelEntry[];
  providers(): ProviderConfig[];
  /** The card's own model preference resolution. */
  resolvePreferredModelId(node: ChatNode): string;
  /** Re-target the card to a new node version (`activate.emit`). */
  onActivated(nodeId: string): void;
  /** The textarea selection while the editor is open, else null. */
  editorSelection(): EditorSelection | null;
  /** The text marked in the rendered (read-only) content, else null. */
  readSelection(): string | null;
  /** Re-measure the textarea after a programmatic draft change. */
  resizeEditor(): void;
  /** Re-focus the editor and select `start .. start+length`. */
  focusEditorAt(start: number, length: number): void;
  /** Write a new text into the open draft (and the edit session). */
  writeDraft(text: string): void;
}

/**
 * The READ-MODE text actions of one chat-node card — the ones that transform
 * or annotate the text the user is looking at:
 *
 *  - `generateHeading()` — a structural heading for this chapter;
 *  - `checkMyEnglish()` + `applyEnglishSuggestion()` + `dismissEnglishCheck()`
 *    — the language-check suggestion panel;
 *  - `openRewriteDialog()` — rewrite the marked text INSIDE the editor;
 *  - `openReadRewriteDialog()` — rewrite marked text in the rendered chapter;
 *  - `openReadCreateImageDialog()` — "Create image" of a marked passage.
 *
 * Extracted out of `ChatNodeComponent` (see `docs/architecture/chat-ui.md`):
 * every one of these is the same guard → resolve model → dialog/per-call
 * completion → write result → re-target sequence, and each runs under
 * {@link NodeActionState} so the card stays "one action at a time".
 *
 * Instance-scoped: provided in `ChatNodeComponent.providers`.
 */
@Injectable()
export class TextActionsController {
  private readonly chatService = inject(ChatService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly runner = inject(LlmUseCaseRunner);
  private readonly rewriteDialog = inject(RewriteDialogService);
  private readonly createImageDialog = inject(CreateImageDialogService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  /** Check-my-English state: running flag + the returned variants. */
  readonly checkingEnglish = signal(false);
  readonly englishSuggestions = signal<string[] | null>(null);
  /** What was checked: null = the whole direction, else the marked range. */
  private readonly englishSelection = signal<EditorSelection | null>(null);

  private host: TextActionsHost | null = null;

  /** Wire the card that owns the DOM (called once from its constructor). */
  bind(host: TextActionsHost): void {
    this.host = host;
  }

  // ------------------------------------------------------------------
  // Chapter heading
  // ------------------------------------------------------------------

  /** Generate a chapter heading for THIS assistant answer; only its text is used as context. */
  async generateHeading(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const node = host.node();
    if (node.role !== 'assistant') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const configuredModel = this.generation.modelFor('headings');
    const model = configuredModel
      ?? host.enabledModels().find(m => m.modelId === host.resolvePreferredModelId(node));
    const provider = model
      ? host.providers().find(p => p.id === model.providerId)
      : null;
    if (!model || !provider) {
      this.toast.error(this.i18n.t('node.structureModelMissing'));
      return;
    }

    if (!host.actions.begin('structure')) return;
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      // The `structure-heading` use case resolves the task prompt, runs the
      // non-streaming completion and creates/patches the structural heading
      // (activating it via the flow result).
      const slots = await this.runner.run({
        chat,
        node,
        usecase: 'structure-heading',
        vars: { modelId: model.modelId, providerId: model.providerId },
      });
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.structureEmpty'));
      }
      const structureNodeId = slots.flow?.value?.structureNodeId;
      if (structureNodeId) host.onActivated(structureNodeId);
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      host.actions.end();
    }
  }

  // ------------------------------------------------------------------
  // Check my English
  // ------------------------------------------------------------------

  /**
   * "Check my English" — asks the LLM to review the current direction and
   * return three improved variants. The main goal is NOT style: directions are
   * not part of the finished story, so the focus is grammar / orthography /
   * unambiguous wording that helps the writing model understand the intent.
   * One variant ("minimal") stays as close to the original as possible.
   *
   * Model/provider come from the "language-check" generation task (Settings →
   * Generation tasks); when the task is unset it falls back to the model
   * selected in the editor (the one that will read the direction).
   */
  async checkMyEnglish(): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (host.node().role !== 'user' || !host.isEditing()) return;
    if (this.checkingEnglish() || !host.actions.idle) return;

    // When the user has MARKED a part of the direction, check only that marked
    // text (mirroring the rewrite-selection flow) so the suggestions replace
    // just the selection instead of the whole direction.
    const selection = host.editorSelection();
    const draft = host.editor.contentDraft();
    const fragment = selection ? draft.slice(selection.start, selection.end) : draft;
    if (!fragment.trim()) {
      this.toast.error(this.i18n.t('node.englishEmpty'));
      return;
    }
    const text = fragment.trim();
    this.englishSelection.set(selection);

    // 1. Prefer the model configured for the language-check task.
    let model = this.generation.modelFor('language-check');
    let provider = this.generation.providerFor('language-check');
    if (!model || !provider) {
      // 2. Fall back to the model selected in the editor / the preferred model.
      const modelId = host.editor.branchModelId() || host.resolvePreferredModelId(host.node());
      const fallback = host.enabledModels().find(
        m => m.modelId === modelId || m.id === modelId,
      );
      model = fallback ?? null;
      provider = fallback
        ? host.providers().find(p => p.id === fallback.providerId) ?? null
        : null;
    }
    if (!model || !provider) {
      this.toast.error(this.i18n.t('node.englishModelMissing'));
      return;
    }

    this.checkingEnglish.set(true);
    this.englishSuggestions.set(null);
    try {
      const chatId = this.chatService.currentChatId();
      const chat = chatId
        ? this.chatService.chats().find(c => c.id === chatId) ?? null
        : null;
      // The `language-check` use case resolves the task prompt + model, runs
      // the non-streaming completion and returns the RAW model text — the
      // variants are parsed here for the suggestion panel.
      const slots = await this.runner.run({
        chat,
        node: host.node(),
        usecase: 'language-check',
        vars: { content: text, modelId: model.modelId, providerId: model.providerId },
      });
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.englishFailed'));
      }
      const variants = this.parseEnglishVariants(slots.text?.value ?? '');
      if (variants.length === 0) {
        this.toast.error(this.i18n.t('node.englishFailed', {
          error: this.i18n.t('node.englishNoVariants'),
        }));
        return;
      }
      this.englishSuggestions.set(variants);
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.englishFailed', { error: err?.message || err }));
    } finally {
      this.checkingEnglish.set(false);
    }
  }

  /**
   * Replace the draft — or just the marked range when the check was started
   * on a selection — with a chosen variant and close the panel.
   */
  applyEnglishSuggestion(text: string): void {
    const host = this.host;
    if (!host) return;
    const selection = this.englishSelection();
    const draft = host.editor.contentDraft();
    const next = selection
      ? draft.slice(0, selection.start) + text + draft.slice(selection.end)
      : text;
    host.writeDraft(next);
    this.englishSuggestions.set(null);
    this.englishSelection.set(null);
    host.resizeEditor();
    // Restore focus and place the cursor around the inserted replacement.
    if (selection) host.focusEditorAt(selection.start, text.length);
  }

  dismissEnglishCheck(): void {
    this.englishSuggestions.set(null);
    this.englishSelection.set(null);
  }

  /** Parse the LLM answer into up to 3 suggestion strings. */
  private parseEnglishVariants(content: string): string[] {
    return parseSuggestionVariants(content);
  }

  // ------------------------------------------------------------------
  // Rewrite (inside the editor)
  // ------------------------------------------------------------------

  /**
   * Rewrite the MARKED text of the editor: capture the current textarea
   * selection, open the rewrite dialog (editable fragment + directions +
   * context scope + model), and when the dialog returns a text, replace the
   * marked range in the draft with it. Works for both directions (user) and
   * chapters (assistant) while editing.
   */
  async openRewriteDialog(): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (!host.isEditing() || !host.actions.idle || this.checkingEnglish()) return;
    const selection = host.editorSelection();
    // A collapsed caret (no marked range) and a whitespace-only range both
    // mean "nothing to rewrite" — tell the user to mark the text first rather
    // than opening the dialog (mirrors `openReadRewriteDialog`).
    if (!selection) {
      this.toast.error(this.i18n.t('node.rewriteNoSelection'));
      return;
    }

    const draft = host.editor.contentDraft();
    const fragment = draft.slice(selection.start, selection.end);
    if (!fragment.trim()) {
      this.toast.error(this.i18n.t('node.rewriteNoSelection'));
      return;
    }

    const node = host.node();
    const chatId = this.chatService.currentChatId();
    const chat = chatId
      ? this.chatService.chats().find(c => c.id === chatId) ?? null
      : null;
    const result = await this.rewriteDialog.open({
      fragment,
      // The whole node content is the most useful default context; the user can
      // narrow it (none / up to the marked part / whole thread) in the dialog.
      contextMode: 'node',
      selectionEnd: selection.end,
      node,
      chat,
      modelId: node.modelId || host.resolvePreferredModelId(node),
      providerId: node.providerId ?? '',
    });
    if (result == null) return; // cancelled

    const next = draft.slice(0, selection.start) + result + draft.slice(selection.end);
    host.writeDraft(next);
    host.resizeEditor();
    // Restore focus and place the cursor around the inserted replacement.
    host.focusEditorAt(selection.start, result.length);
  }

  // ------------------------------------------------------------------
  // Rewrite / create-image from the read-only view
  // ------------------------------------------------------------------

  /**
   * Rewrite a piece of text MARKED in the rendered (non-edit) content.
   * Captures the current DOM selection inside the node, opens the rewrite
   * dialog (editable fragment + directions + context scope + model), and when
   * the dialog returns a text, persists a new version of the node with the
   * marked range replaced. The marked text is located in the markdown source
   * via a marker map (markdown syntax removed, whitespace collapsed), so the
   * rest of the source — including surrounding markdown formatting — is
   * preserved. If the range cannot be mapped back at all, the rewrite is
   * appended at the end of the node instead of being lost.
   */
  async openReadRewriteDialog(): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (host.isEditing() || !host.actions.idle) return;

    const fragment = host.readSelection();
    if (!fragment?.trim()) {
      this.toast.error(this.i18n.t('node.rewriteNoSelection'));
      return;
    }

    const node = host.node();
    const source = node.content || '';
    const loc = markFragmentInSource(source, fragment);
    const chatId = this.chatService.currentChatId();
    const chat = chatId
      ? this.chatService.chats().find(c => c.id === chatId) ?? null
      : null;
    const result = await this.rewriteDialog.open({
      fragment,
      // The whole node content is the most useful default context; the user can
      // narrow it (none / up to the marked part / whole thread) in the dialog.
      contextMode: 'node',
      selectionEnd: loc ? loc.index + loc.length : source.length,
      node,
      chat,
      modelId: node.modelId || host.resolvePreferredModelId(node),
      providerId: node.providerId ?? '',
    });
    if (result == null) return; // cancelled

    // Never lose the created rewrite: when the marked range cannot be mapped
    // back to the source (formatting/rendering differences), append the
    // rewrite at the end of the node instead of discarding it.
    const newContent = loc
      ? source.slice(0, loc.index) + result + source.slice(loc.index + loc.length)
      : appendRewriteFallback(source, result);
    if (!loc) this.toast.info(this.i18n.t('node.rewriteAppended'));

    if (!chatId) return;
    if (!host.actions.begin('version')) return;
    try {
      const saved = await this.writeText(chatId, node, newContent);
      host.onActivated(saved.id);
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.saveFailed', { error: err?.message || err }));
    } finally {
      host.actions.end();
    }
  }

  /**
   * Create an image of a piece of text MARKED in the rendered chapter content.
   * Captures the current DOM selection inside the ASSISTANT node, opens the
   * "Create image" dialog (chat-specific constant + the marked text, both
   * editable, plus optional reference images + the image model), and when the
   * dialog confirms, sends the combined text AS-IS (with any reference images)
   * to the image model. The created picture is attached to the assistant node
   * via `editAssistant` (versioned), exactly like the illustration flow.
   *
   * Unlike `illustrate` there is NO planning and NO drawing-instruction
   * template — "send it as it is" is the point of this action; reference images
   * only ever appear when the user attached them.
   */
  async openReadCreateImageDialog(): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (host.isEditing() || !host.actions.idle) return;
    const node = host.node();
    if (node.role !== 'assistant') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const script = host.readSelection();
    if (!script?.trim()) {
      this.toast.error(this.i18n.t('node.createImageNoSelection'));
      return;
    }

    // Default image-producing model from the settings (image-create task,
    // fallback: the first enabled image-capable model).
    let defaultModel = this.generation.modelFor('image-create');
    let defaultProvider = this.generation.providerFor('image-create');
    if (!defaultModel || !defaultProvider) {
      const fallback = host.enabledModels().find(canGenerateImages);
      if (fallback) {
        defaultModel = fallback;
        defaultProvider = host.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!defaultModel || !defaultProvider) {
      this.toast.error(this.i18n.t('node.imageModelMissing'));
      return;
    }

    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
    const result = await this.createImageDialog.open({
      chatId,
      chat,
      node,
      script,
      modelId: defaultModel.modelId,
      providerId: defaultModel.providerId,
    });
    if (!result) return; // cancelled

    // The text is sent AS-IS: the chat constant (always shown) followed by the
    // marked text, with the reference images attached as image parts.
    const prompt = [result.constant.trim(), result.script.trim()]
      .filter(Boolean)
      .join('\n\n');
    if (!prompt.trim() && result.images.length === 0) {
      this.toast.error(this.i18n.t('createImageDialog.empty'));
      return;
    }

    if (!host.actions.begin('image')) return;
    host.illustration.imageProgress.set(null);
    try {
      const build = {
        chat,
        node,
        usecase: 'image-send' as const,
        vars: {
          promptText: prompt,
          attachments: result.images,
          count: 1,
          modelId: result.modelId || defaultModel.modelId,
          providerId: (result.modelId && result.providerId)
            ? result.providerId
            : defaultModel.providerId,
        },
      };
      const slots = await this.runner.run(build);

      const scenes = slots.storyboard?.value ?? [];
      const images = slots.images?.value ?? [];
      if (scenes.length === 0 && images.length > 0) {
        // No per-scene records but images came back (defensive).
        scenes.push({ scene: 1, prompt, images, refused: false });
      }
      if (slots.error?.status === 'error' && scenes.length === 0) {
        const reason = slots.error.reason ?? '';
        if (/image model/i.test(reason)) {
          this.toast.error(this.i18n.t('node.imageModelMissing'));
          return;
        }
        throw new Error(reason || this.i18n.t('node.imageEmpty'));
      }

      const generated = buildIllustrationAttachments(scenes, prompt)
        .map(x => ({ ...x, id: x.id || newId() }));
      if (generated.length === 0) {
        const reply = (scenes[0]?.content ?? '').trim()
          || (slots.text?.value ?? '').trim();
        throw new Error(
          reply
            ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
            : this.i18n.t('node.imageEmpty'),
        );
      }

      // Attach the created picture (+ the prompt record) to the chapter node.
      const merged: NodeAttachment[] = [...(node.attachments ?? []), ...generated];
      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        merged,
        node.thinking ?? undefined,
      );
      host.onActivated(saved.id);

      if (images.length === 0) {
        // Everything refused — the refused-prompt record was saved so the
        // prompt stays findable; still inform the user.
        const reply = (scenes[0]?.content ?? '').trim()
          || (slots.text?.value ?? '').trim();
        this.toast.error(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      }
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      host.actions.end();
      host.illustration.imageProgress.set(null);
    }
  }

  /** Persist a new version of the node with `text` (keeps the attachments). */
  private writeText(chatId: string, node: ChatNode, text: string): Promise<ChatNode> {
    return node.role === 'assistant' || node.role === 'system' || node.role === 'structural'
      ? this.chatService.editAssistant(chatId, node.id, text, node.attachments || [])
      : this.chatService.editUser(chatId, node.id, text, node.attachments || []);
  }
}

/**
 * Keep a rewrite that could not be mapped back to the markdown source: append
 * it as a new paragraph instead of discarding the model's answer.
 */
function appendRewriteFallback(source: string, rewrite: string): string {
  const tail = source.trimEnd();
  return tail.length ? tail + '\n\n' + rewrite : rewrite;
}

import { Injectable, inject, signal } from '@angular/core';
import { ChatNode, NodeAttachment } from '../../models/chat';
import { ChatService } from '../../core/chat/chat.service';
import { NodeEditSession } from '../../core/chat/node-edit-session';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';
import { ModelEntry } from '../../models/chat-config';
import { NodeActionState } from './node-action-state';

/** Editing modes of the card. `user` = the user opened it, `auto` = the
 *  composer's automatic entry. Kept for the session's own bookkeeping. */
export type EditSource = 'user' | 'auto';

/**
 * What the editor needs from the card. The card owns the DOM (textarea refs,
 * scroll restoration) and the tree, so those stay there; the editor owns the
 * *draft* and the edit lifecycle.
 */
export interface EditorHost {
  /** The node this card shows. */
  node(): ChatNode;
  /** Single-session edit state (which node is edited, dirty tracking). */
  readonly editSession: NodeEditSession;
  /** Enabled models (for the editor's model listbox). */
  enabledModels(): ModelEntry[];
  /** The card's own model preference resolution. */
  resolvePreferredModelId(node: ChatNode): string;
  /** Reset the attachment multi-selection of the card. */
  clearAttachmentSelection(): void;
  /** The card drops its scroll-restore target (a DOM concern). */
  onEditorTargetCleared(): void;
  /** Re-focus/resize the textarea (a DOM concern) after a search replacement. */
  onDraftReplaced(): void;
  /** Re-target the card to a new node version (`activate.emit`). */
  onActivated(nodeId: string): void;
  /** True for the in-thread composer (an empty, childless direction). */
  isUnsentQuestion(): boolean;
  /** Send the current draft (owned by the card / send controller). */
  sendDraft(): Promise<void>;
  /** Continue / Switch batching (owned by the send controller). */
  runDirectionBatch(direction: 'continue' | 'switchCharacters', count: number): Promise<void>;
}

/**
 * The inline editor of ONE chat-node card: the draft (text + attachments +
 * selected model), the preview toggle, and the edit lifecycle
 * (save-as-version / cancel / close) plus the Continue and "switch characters"
 * shortcuts that fill the draft and send it.
 *
 * Extracted out of `ChatNodeComponent` because the card had grown into
 * "editor + sender + illustrator + attachment manager + context menu" at once.
 * The rule followed here (see `docs/architecture/chat-ui.md`):
 *
 *  - the DRAFT STATE lives here — the component re-exports the same signal
 *    objects, so the template and the 200+ specs are unchanged;
 *  - everything DOM-bound (textarea refs, scroll/caret restoration, focus)
 *    stays in the card and is reached through {@link EditorHost};
 *  - the busy flag is `NodeActionState` (one action at a time), never a local
 *    boolean.
 *
 * Instance-scoped: provided in `ChatNodeComponent.providers`.
 */
@Injectable()
export class EditorController {
  private readonly chatService = inject(ChatService);
  private readonly confirm = inject(ConfirmService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly actions = inject(NodeActionState);

  private readonly _contentDraft = signal('');
  private readonly _editAttachments = signal<NodeAttachment[]>([]);
  private readonly _branchModelId = signal('');
  private readonly _showPreview = signal(false);
  private readonly _editDismissed = signal(false);
  private readonly _repeatCount = signal(1);

  /** How many Continue / Multiple Characters sends to chain in one batch. */
  static readonly REPEAT_MAX = 20;

  private host: EditorHost | null = null;

  /**
   * The draft signals are WRITABLE on purpose: the card's attachment
   * manager, the search integration and the composer shortcuts all write the
   * same state, exactly as before the extraction (same precedent as
   * `NodeActionState`). New code should prefer the methods below, which keep
   * the edit session in sync.
   */
  /** The live editor text. */
  readonly contentDraft = this._contentDraft;
  /** Attachments of the unsaved draft (editable, not yet persisted). */
  readonly editAttachments = this._editAttachments;
  /** Model id chosen in the editor's listbox (persisted on save). */
  readonly branchModelId = this._branchModelId;
  /** Markdown preview toggle. */
  readonly showPreview = this._showPreview;
  /**
   * Set by Cancel so the automatic "re-open the composer" logic does not
   * immediately re-enter edit mode.
   */
  readonly editDismissed = this._editDismissed;
  /** Batch size for Continue / Multiple Characters. */
  readonly repeatCount = this._repeatCount;

  /** Wire the card that owns the DOM (called once from its constructor). */
  bind(host: EditorHost): void {
    this.host = host;
  }

  // ------------------------------------------------------------------
  // Draft plumbing
  // ------------------------------------------------------------------

  /** True when neither text nor attachments would be sent/saved. */
  isDraftEmpty(): boolean {
    return !this._contentDraft().trim() && this._editAttachments().length === 0;
  }

  /** A keystroke in the textarea: update the draft AND the edit session. */
  onDraftText(text: string): void {
    this._contentDraft.set(text);
    const host = this.host;
    if (host) host.editSession.patch(host.node().id, text, this._editAttachments());
  }

  /**
   * Apply text produced by the shared search/replace dialog. The dialog
   * persists replacements through patchNode (committed content), but an open
   * editor renders the live draft — keep the two in sync so the textarea shows
   * what will be found next and the draft stays the source of truth for the
   * next match offsets.
   */
  setDraftFromSearch(text: string): void {
    const host = this.host;
    if (!host || host.editSession.editingNodeId() !== host.node().id) return;
    this._contentDraft.set(text);
    host.editSession.patch(host.node().id, text, this._editAttachments());
    host.onDraftReplaced();
  }

  /** Push the current draft into the edit session (attachment add/remove). */
  syncAttachments(): void {
    const host = this.host;
    if (!host) return;
    host.editSession.patch(host.node().id, this._contentDraft(), this._editAttachments());
  }

  /**
   * Seed the draft after the session was successfully begun: content,
   * attachments, the model shown in the listbox, and a cleared "dismissed"
   * flag. The card then opens the textarea (DOM) itself.
   */
  openDraft(node: ChatNode): void {
    const host = this.host;
    this._editDismissed.set(false);
    this._contentDraft.set(node.content || '');
    this._editAttachments.set([...(node.attachments || [])]);
    host?.clearAttachmentSelection();
    this._branchModelId.set(
      node.modelId || host?.resolvePreferredModelId(node) || '',
    );
    this.actions.pending.set(null);
  }

  /** Clear the draft state (no session change) — used when the editor closes. */
  private resetDraft(): void {
    const host = this.host;
    this.actions.pending.set(null);
    this._showPreview.set(false);
    this._contentDraft.set('');
    this._editAttachments.set([]);
    host?.clearAttachmentSelection();
    host?.onEditorTargetCleared();
  }

  // ------------------------------------------------------------------
  // Edit lifecycle
  // ------------------------------------------------------------------

  /**
   * Commit the draft and close the editor **without** asking anything:
   * `editSession.commit` so a late/dirty session does not prompt. Used after a
   * successful save/send and when nothing changed.
   */
  closeEditor(): void {
    const host = this.host;
    if (!host) return;
    const id = host.node().id;
    this.resetDraft();
    host.editSession.commit(id);
  }

  /**
   * Cancel the editor. Asks for confirmation when the session is dirty (the
   * draft would be lost) and returns whether the editor may close.
   */
  async cancelEdit(): Promise<boolean> {
    const host = this.host;
    if (!host) return false;
    if (
      host.editSession.editingNodeId() === host.node().id &&
      host.editSession.isDirty()
    ) {
      const discard = await this.confirm.ask({
        title: this.i18n.t('node.discardTitle'),
        message: this.i18n.t('node.discardMsg'),
        confirmLabel: this.i18n.t('common.discard'),
        cancelLabel: this.i18n.t('common.keepEditing'),
        danger: true,
      });
      if (!discard) return false;
    }
    this._editDismissed.set(true);
    this.resetDraft();
    host.editSession.abandon(host.node().id);
    return true;
  }

  /**
   * OK — persist the draft as a NEW VERSION of the node. Does not call the LLM.
   * Answers use `editAssistant`, questions `editUser`; for a question the model
   * selected in the editor is persisted onto the new version, so the choice
   * sticks (Send / Branch / Insert read it from there next time).
   */
  async saveAsVersion(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const node = host.node();
    const newContent = this._contentDraft().trim();
    const attachments = this._editAttachments();

    const attachmentsUnchanged =
      JSON.stringify(attachments) === JSON.stringify(node.attachments || []);

    // Nothing changed (empty draft without attachments, or identical text +
    // attachments) → keep the node untouched and just close the editor. Use
    // closeEditor() (NOT cancelEdit()): cancelEdit would ask for a discard
    // confirmation when the session is dirty (e.g. the user typed and then
    // reverted), which blocked saving.
    if ((!newContent && attachments.length === 0) ||
      (newContent === node.content && attachmentsUnchanged)) {
      this.closeEditor();
      return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    if (!this.actions.begin('version')) return;
    try {
      let saved: ChatNode;
      if (node.role === 'assistant' || node.role === 'system' || node.role === 'structural') {
        saved = await this.chatService.editAssistant(chatId, node.id, newContent, attachments);
      } else {
        saved = await this.chatService.editUser(chatId, node.id, newContent, attachments);
      }
      // The model listbox is only shown for a user node. Versioning copies the
      // OLD model, so persist the freshly selected model when it changed.
      if (node.role === 'user' && this._branchModelId()) {
        const selected = host.enabledModels().find(
          m => m.modelId === this._branchModelId() || m.id === this._branchModelId(),
        );
        if (selected && selected.modelId !== node.modelId && selected.providerId) {
          saved = await this.chatService.patchNode(chatId, saved.id, {
            modelId: selected.modelId,
            providerId: selected.providerId,
          });
        }
      }
      // Re-target the card to the new version BEFORE closing (the id changes).
      host.onActivated(saved.id);
      this.closeEditor();
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.saveFailed', { error: err?.message || err }));
    } finally {
      this.actions.end();
    }
  }

  // ------------------------------------------------------------------
  // Composer shortcuts
  // ------------------------------------------------------------------

  /** Fill the composer with the editable `structure.continue` template + send. */
  async continueDraft(): Promise<void> {
    return this.sendShortcut('continue');
  }

  /** Fill the composer with `structure.switchCharacters` + send. */
  async switchCharactersDraft(): Promise<void> {
    return this.sendShortcut('switchCharacters');
  }

  private async sendShortcut(kind: 'continue' | 'switchCharacters'): Promise<void> {
    const host = this.host;
    if (!host || !host.isUnsentQuestion() || !this.actions.idle) return;
    if (this._repeatCount() > 1) {
      await host.runDirectionBatch(kind, this._repeatCount());
      return;
    }
    const template = kind === 'continue' ? 'structure.continue' : 'structure.switchCharacters';
    const fallback = kind === 'continue' ? 'continue' : 'switch characters';
    this._contentDraft.set(this.promptDefaults.effective(template) || fallback);
    this._editAttachments.set([]);
    this._branchModelId.set(host.node().modelId || host.resolvePreferredModelId(host.node()));
    this.actions.pending.set(kind);
    await host.sendDraft();
    await this.cancelEdit();
  }

  decRepeat(): void {
    this._repeatCount.update(n => Math.max(1, n - 1));
  }

  incRepeat(): void {
    this._repeatCount.update(n => Math.min(EditorController.REPEAT_MAX, n + 1));
  }
}

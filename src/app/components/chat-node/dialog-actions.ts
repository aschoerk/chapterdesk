import { Injectable, inject, type WritableSignal } from '@angular/core';
import { ChatMessage, ChatNode } from '../../models/chat';
import { ChatService } from '../../core/chat/chat.service';
import { ProjectService } from '../../core/settings/project.service';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';
import { ModelEntry, ProviderConfig } from '../../models/chat-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { PrependDialogService } from '../../core/dialogs/prepend-dialog.service';
import { NodeVersionDiffDialogService } from '../../core/dialogs/node-version-diff-dialog.service';
import { ChapterDescriptionsDialogService } from '../../core/dialogs/chapter-descriptions-dialog.service';
import { NodeEditSession } from '../../core/chat/node-edit-session';
import {
  estimateContentTokens,
  nodeToMessageContent,
  PREPEND_MAX_TOKENS,
} from '../../core/llm/llm-message';
import { NodeActionState } from './node-action-state';
import type { EditorController } from './editor-controller';

/** Per-node director (prepend) instructions, as a `{ [nodeId]: text }` map. */
const LS_PREPEND = 'chat.prependByNodeId';

/**
 * What the dialog actions need from the card. The card owns the DOM (textarea,
 * rendered content, focus) and the flow-runner wiring shared with the other
 * actions, so those stay there and are reached through this host.
 */
export interface DialogActionsHost {
  node(): ChatNode;
  /** Busy state of the card (one action at a time). */
  readonly actions: NodeActionState;
  /** Draft owner (text / attachments / selected model). */
  readonly editor: EditorController;
  readonly editSession: NodeEditSession;
  enabledModels(): ModelEntry[];
  providers(): ProviderConfig[];
  /** The card's own model preference resolution. */
  resolvePreferredModelId(node: ChatNode): string;
  /** True while the inline editor of this card is open. */
  isEditing(): boolean;
  /** Re-measure the editor textarea (a DOM concern). */
  resizeTextarea(): void;
  /** Re-target the card to a new node version (`activate.emit`). */
  onActivated(nodeId: string): void;
  /** Structural flows stay on the card (shared with regenerate/rewrite). */
  runFlow(
    usecase: 'send-prepend' | 'send-chapter-descriptions',
    pending: 'prepend' | 'chapterDescriptions',
    builder?: (build: { vars: Record<string, unknown> }) => void,
  ): Promise<boolean>;
  /** Prepend state — the template binds these signals directly. */
  readonly prependEnabled: WritableSignal<boolean>;
  readonly prependText: WritableSignal<string>;
  /** The node's comparable siblings (content-diff dialog). */
  comparableSiblings(): ChatNode[];
  /** Write a dialog result into the open draft + edit session. */
  replaceDraft(text: string): void;
}

/**
 * The DIALOG actions of one chat-node card — every action whose first step is
 * "ask the user in a modal, then act on the answer":
 *
 *  - **prepend** (director instruction): store per node, propose a template,
 *    then run the `send-prepend` flow and insert the two nodes before the
 *    current direction;
 *  - **compare versions / compare siblings**: apply the chosen text to the
 *    draft (editor open) or persist it as a new version (read-only);
 *  - **chapter descriptions**: run `send-chapter-descriptions` as another
 *    branch with the dialog's parameters.
 *
 * Extracted out of `ChatNodeComponent` (see `docs/architecture/chat-ui.md`):
 * the card had grown into "editor + sender + illustrator + attachment manager +
 * context menu + dialog dispatcher" at once. The card keeps thin delegating
 * members, so the template and the existing specs are unchanged.
 *
 * Instance-scoped: provided in `ChatNodeComponent.providers`.
 */
@Injectable()
export class DialogActionsController {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly prependDialog = inject(PrependDialogService);
  private readonly versionDiffDialog = inject(NodeVersionDiffDialogService);
  private readonly chapterDescriptionsDialog = inject(ChapterDescriptionsDialogService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  private host: DialogActionsHost | null = null;

  /** Wire the card that owns the DOM (called once from its constructor). */
  bind(host: DialogActionsHost): void {
    this.host = host;
  }

  // ------------------------------------------------------------------
  // Prepend (director instruction)
  // ------------------------------------------------------------------

  /** Stored director texts per node id (a `{ [nodeId]: string }` map). */
  readPrependMap(): Record<string, string> {
    try {
      const raw = localStorage.getItem(LS_PREPEND);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writePrependMap(map: Record<string, string>): void {
    try {
      localStorage.setItem(LS_PREPEND, JSON.stringify(map));
    } catch { /* best-effort */ }
  }

  /** True when a director instruction is stored for the node. */
  isPrependStored(nodeId: string): boolean {
    const map = this.readPrependMap();
    return Object.prototype.hasOwnProperty.call(map, nodeId);
  }

  /** The stored director text of a node ('' when none). */
  storedPrependText(nodeId: string): string {
    const map = this.readPrependMap();
    return Object.prototype.hasOwnProperty.call(map, nodeId) ? (map[nodeId] ?? '') : '';
  }

  /** Publish the stored prepend state of `nodeId` onto the card's signals. */
  syncPrependState(nodeId: string): void {
    const host = this.host;
    if (!host) return;
    host.prependEnabled.set(this.isPrependStored(nodeId));
    host.prependText.set(this.storedPrependText(nodeId));
  }

  /**
   * Open the "Prepend director" dialog, prefilled with the existing editor text
   * or a newly-proposed instruction (from `prependInstruction`). On confirm, the
   * edited text is stored AND the LLM is called with the director instruction +
   * the following assistant chapters (≤5000 tokens); the result is inserted as
   * TWO new nodes BEFORE the current direction/user/question node: the
   * prompt-prefix (director) node and the LLM result node. An empty confirmed
   * text clears the director.
   */
  async openPrependDialog(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const node = host.node();
    if (node.role !== 'user') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const nodeId = node.id;
    const existing = this.storedPrependText(nodeId);
    const proposed = existing.trim() || this.prependInstruction();
    const text = await this.prependDialog.open(proposed, this.isPrependStored(nodeId));
    // Cancel resolves null — keep the current state.
    if (text == null) return;
    const cleaned = text.trim();
    const map = this.readPrependMap();
    if (cleaned) {
      map[nodeId] = cleaned;
    } else {
      delete map[nodeId];
    }
    this.writePrependMap(map);
    this.syncPrependState(nodeId);
    if (!cleaned) return; // cleared — no generation

    await this.generatePrependNodes(node, cleaned);
  }

  /**
   * The proposed director instruction: the stored text wins, else the
   * topic-scoped `structure.prepend` template (with the chat's elaborate
   * characters) or `structure.prepend-basic`.
   */
  prependInstruction(): string {
    const host = this.host;
    if (!host) return '';
    const stored = host.prependText().trim();
    if (stored) return stored;
    const characters = this.elaborateCharacters();
    // Topic-scoped prompt versions apply to the current chat's topic.
    const chatId = this.chatService.currentChatId();
    const chat = chatId ? this.chatService.chats().find(c => c.id === chatId) ?? null : null;
    const project = chat?.projectId
      ? this.projectService.getProject(chat.projectId) ?? null
      : null;
    const topicId = this.projectService
      .topicForProject(project?.id, this.projectService.topics())?.id ?? null;
    return characters
      ? this.promptDefaults.render('structure.prepend', { characters }, topicId)
      : this.promptDefaults.render('structure.prepend-basic', {}, topicId);
  }

  /** The elaborate "characters" string stored per chat ('' when unset). */
  private elaborateCharacters(): string {
    try {
      const chatId = this.chatService.currentChatId();
      if (!chatId) return '';
      const raw = localStorage.getItem('chat-client.elaborate.byChatId');
      const map = raw ? JSON.parse(raw) : {};
      const entry = map?.[chatId];
      return typeof entry?.characters === 'string' ? entry.characters.trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * The concatenated FULL text of the assistant nodes that FOLLOW the current
   * node on the active path (the chapters after the direction being prepended).
   * Whole chapters are kept (never split); walking from the current node
   * forward, chapters are appended until the aggregate token estimate exceeds
   * `PREPEND_MAX_TOKENS` — the remaining (newest) chapters are left out.
   */
  followingAssistantContent(nodeId: string): string {
    const path: ChatNode[] = this.chatService.getActivePath();
    const start = path.findIndex(n => n.id === nodeId);
    if (start < 0) return '';

    const parts: string[] = [];
    let tokens = 0;
    for (let i = start + 1; i < path.length; i++) {
      const n = path[i];
      if (n.role !== 'assistant') continue;
      const text = (n.content || '').trim();
      if (!text) continue;
      const t = estimateContentTokens(text);
      if (parts.length > 0 && tokens + t > PREPEND_MAX_TOKENS) break;
      parts.push(text);
      tokens += t;
    }
    return parts.join('\n\n');
  }

  /**
   * The text-only history up to `parentId` (structural nodes and excluded
   * meta/lore nodes skipped) — used as the "is there anything to narrate?"
   * guard of the prepend flow.
   */
  private contextMessagesUpTo(parentId: string | null): ChatMessage[] {
    if (!parentId) return [];
    const path: ChatNode[] = this.chatService.getPathToNode(parentId);
    const messages: ChatMessage[] = [];
    for (const n of path) {
      if (n.role !== 'structural') {
        // Excluded meta / lore-documentation nodes are shown but are not part
        // of the LLM context history.
        if (n.excludeFromContext) continue;
        messages.push({ role: n.role, content: nodeToMessageContent(n) });
      }
    }
    return messages;
  }

  /**
   * Insert the director (user) node + a streamed result (assistant) BEFORE the
   * current direction, adopting the current node under the result — via the
   * orchestration `send-prepend` flow. On failure the stored flag is rolled
   * back.
   */
  async generatePrependNodes(node: ChatNode, directorText: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    const following = this.followingAssistantContent(node.id);
    const hasHistory = this.contextMessagesUpTo(node.parentId).length > 0
      || following.trim().length > 0;
    // Nothing to narrate — no assistant chapter anywhere in the thread.
    if (!hasHistory) return;

    const ok = await host.runFlow('send-prepend', 'prepend', build => {
      build.vars['directorText'] = directorText;
      build.vars['followingText'] = following;
    });
    // On failure the flow runner alerted; roll back the stored flag so the UI
    // reflects "not active".
    if (!ok && host.prependEnabled()) {
      const map = this.readPrependMap();
      delete map[node.id];
      this.writePrependMap(map);
      this.syncPrependState(node.id);
    }
  }

  // ------------------------------------------------------------------
  // Compare versions / siblings
  // ------------------------------------------------------------------

  /**
   * Open the "Compare versions" dialog.
   *
   * While the inline editor is open the dialog compares the UNSAVED draft
   * against a prior version; on Apply the result stays in the draft (temporary
   * until OK/Save). From the read-only view it compares the node's CURRENT
   * content against a prior version; on Apply the edited result is persisted
   * immediately as a new version (mirroring saveAsVersion).
   */
  async openVersionDiffDialog(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const node = host.node();
    const versions = this.chatService.getPriorVersions(node);
    if (versions.length === 0) return;
    const newText = host.isEditing() ? host.editor.contentDraft() : (node.content ?? '');
    const result = await this.versionDiffDialog.open({ newText, versions });
    if (result == null) return;

    if (host.isEditing()) {
      // Keep it temporary in the unsaved draft — the user presses OK/Save later.
      this.applyDialogToDraft(node.id, result);
      return;
    }
    await this.persistDialogAsVersion(node, result);
  }

  /**
   * Open the "Compare siblings" dialog: compare THIS node against one of its
   * siblings (the current sibling is the editable side). Mirrors the compare-
   * versions dialog: draft-apply while editing, persist-as-new-version from the
   * read-only view.
   */
  async openCompareSiblingsDialog(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const node = host.node();
    const siblings = host.comparableSiblings();
    if (siblings.length === 0) return;
    const newText = host.isEditing() ? host.editor.contentDraft() : (node.content ?? '');
    const result = await this.versionDiffDialog.open({ newText, siblings });
    if (result == null) return;

    if (host.isEditing()) {
      this.applyDialogToDraft(node.id, result);
      return;
    }
    await this.persistDialogAsVersion(node, result);
  }

  /** Write a dialog result into the open editor's unsaved draft. */
  private applyDialogToDraft(nodeId: string, result: string): void {
    const host = this.host;
    if (!host) return;
    host.editor.contentDraft.set(result);
    host.editSession.patch(nodeId, result, host.editor.editAttachments());
    host.resizeTextarea();
  }

  /** Persist a dialog result as a new version of the node (read-only path). */
  async persistDialogAsVersion(node: ChatNode, result: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    if (result.trim() === (node.content ?? '').trim()) return; // nothing changed
    if (!host.actions.begin('version')) return;
    try {
      const saved =
        node.role === 'assistant' || node.role === 'system' || node.role === 'structural'
          ? await this.chatService.editAssistant(chatId, node.id, result, node.attachments)
          : await this.chatService.editUser(chatId, node.id, result, node.attachments);
      host.onActivated(saved.id);
      this.toast.success(this.i18n.t('node.versioned'));
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.saveFailed', { error: err?.message || err }));
    } finally {
      host.actions.end();
    }
  }

  // ------------------------------------------------------------------
  // Chapter descriptions
  // ------------------------------------------------------------------

  /**
   * Open the "Create chapter descriptions" dialog (available on the last node,
   * next to Continue). On confirm, the chapter description list is generated as
   * ANOTHER branch to the first one: a new sibling question carries the request
   * (previous visible chat content + the dialog parameters + goal) and the
   * answer streams under it. The last input parameters are remembered per chat,
   * so the next press of the button provides them again (first chapter
   * continues after the last generated).
   */
  async openChapterDescriptionsDialog(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const node = host.node();
    if (node.role !== 'user' || !host.actions.idle) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    const defaultModelId = node.modelId || host.resolvePreferredModelId(node);
    const result = await this.chapterDescriptionsDialog.open({
      chatId,
      chat,
      node,
      defaultModelId,
      defaultProviderId: node.providerId ?? '',
    });
    if (result == null) return; // cancelled

    await host.runFlow('send-chapter-descriptions', 'chapterDescriptions', build => {
      build.vars['chapterCount'] = result.chapterCount;
      build.vars['sentencesPerChapter'] = result.sentencesPerChapter;
      build.vars['firstChapter'] = result.firstChapter;
      build.vars['goal'] = result.goal;
      // The model chosen in the dialog wins — the new branch must use the
      // freshly chosen model, not the node's (its draft is left untouched).
      build.vars['modelId'] = result.modelId;
      build.vars['providerId'] = result.providerId;
    });
  }
}

/**
 * chat-nav-actions.service.ts
 *
 * The chat page's navbar clipboard / branch OPERATIONS, extracted from
 * ChatComponent. The nav-bar (`ChatNavBarComponent`) is the `ChatNavMenuHost`
 * and EMITS these upward; the page used to perform them. This service owns the
 * actual tree mutations:
 *
 *  - selection clipboard: copy / cut / delete / extract the selected chain,
 *  - paste: insert / append the clipboard chain into the active path (after a
 *    node, before a node, or as a parallel branch),
 *  - branch ops: start a parallel branch at a node, switch the active
 *    continuation to a sibling,
 *  - the node-menu variants (copy / cut / delete a single node, or the whole
 *    selection when the node is part of one),
 *  - the keyboard dispatch (`onKey`) for the navbar shortcuts.
 *
 * Unlike the search / paced-read services it needs NO page host: every
 * dependency (chat service, node clipboard, confirm / toast / i18n, the
 * selection state and the menu geometry) is injectable. It is component-scoped
 * so it shares the page's `ChatNavMenuService` instance.
 *
 * The page keeps thin delegates for every public member, so the template and
 * the specs are unchanged.
 */
import { Injectable, inject } from '@angular/core';
import { ChatNode } from '../../models/chat';
import { ChatService } from './chat.service';
import { NodeClipboardService } from '../clipboard/node-clipboard.service';
import { ConfirmService } from '../dialogs/confirm.service';
import { I18nService } from '../i18n/i18n.service';
import { ToastService } from '../toast/toast.service';
import { ChatNavSelectionService } from './chat-nav-selection.service';
import { ChatNavMenuService } from './chat-nav-menu.service';

/**
 * The navbar clipboard / branch operations the chat page exposes to its
 * template and specs. Implemented by `ChatNavActionsService` (the real logic)
 * and by `ChatComponent` (thin delegates that forward to the service) — the
 * two are compile-time checked to stay in lockstep.
 */
export interface ChatNavActions {
  copyNavSelection(): void;
  cutNavSelection(): Promise<void>;
  deleteNavSelection(): Promise<void>;
  extractNavSelection(withVisibleSubtree?: boolean): Promise<void>;
  pasteNavSelectionAfter(nodeId: string): Promise<void>;
  pasteNavSelectionBefore(node: ChatNode): Promise<void>;
  pasteNavSelectionBeforeId(nodeId: string): Promise<void>;
  pasteChainInto(mode: 'insert' | 'append', leftId: string, rightId: string | null): Promise<void>;
  appendNavSelectionAfter(nodeId: string): Promise<void>;
  canPasteAfter(node: ChatNode): boolean;
  switchNavSibling(node: ChatNode, dir: -1 | 1): void;
  startBranchAt(node: ChatNode): Promise<void>;
  copyNavNodes(node: ChatNode): void;
  cutNavNodes(node: ChatNode): Promise<void>;
  deleteNavNodes(node: ChatNode): Promise<void>;
}

/**
 * Component-scoped (one instance per chat page) so it can inject the page's
 * `ChatNavMenuService`. The page binds nothing — the service is self-contained.
 */
@Injectable()
export class ChatNavActionsService implements ChatNavActions {
  private readonly chatService = inject(ChatService);
  private readonly clipboard = inject(NodeClipboardService);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly navSelection = inject(ChatNavSelectionService);
  private readonly navMenu = inject(ChatNavMenuService);

  // ------------------------------------------------------------------
  // Selection clipboard (the whole selected chain)
  // ------------------------------------------------------------------

  /** The selected nodes in active-path (top-first) order so cut/delete
   *  reparent left-over children to the chain's topmost surviving ancestor. */
  private selectedNavNodes(): ChatNode[] {
    return this.navSelection.selectedNodes(
      this.chatService.getActivePath(),
      (id) => this.navMenu.isLastEmptyDirection(id)
    );
  }

  copyNavSelection(): void {
    const nodes = this.selectedNavNodes();
    if (!nodes.length) return;
    this.clipboard.copySequence(nodes);
  }

  async cutNavSelection(): Promise<void> {
    const nodes = this.selectedNavNodes();
    if (!nodes.length) return;
    const hasPayload = nodes.some(
      (n) => !!n.content?.trim() || !!(n.attachments && n.attachments.length),
    );
    if (hasPayload) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.cutSelectedAsk', { count: nodes.length }),
        message: this.i18n.t('node.cutSelectedMsg', { count: nodes.length }),
        confirmLabel: this.i18n.t('node.cutSelected'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await this.clipboard.cutSequence(nodes);
      this.navSelection.clear();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.cutFailed', { error: err?.message || err }));
    }
  }

  /**
   * Extract the selected chain into a NEW story: the selected nodes are
   * copied there (as the story's starting chain), the source story's lore is
   * copied along with them. The new story is opened afterwards.
   *
   * With `withVisibleSubtree` the visible continuation below the selection (the
   * rest of the active path) travels along as well, so the new story does not
   * end at the cut.
   *
   * Only nodes whose whole subtree moved are removed from this story. A node
   * that transitively is a parent of a node which is NOT extracted stays here
   * (removing it would orphan that branch) — it is COPIED instead. Example:
   * visible A → B → C → D with an invisible C → E; extracting B with its
   * subtree yields B → C → D in the new story and keeps A → B → C → E here.
   */
  async extractNavSelection(withVisibleSubtree = false): Promise<void> {
    const nodes = this.selectedNavNodes();
    if (!nodes.length) return;
    const hasPayload = nodes.some(
      (n) => !!n.content?.trim() || !!(n.attachments && n.attachments.length),
    );
    if (hasPayload) {
      const key = withVisibleSubtree ? 'extractSubtree' : 'extractSelected';
      const ok = await this.confirm.ask({
        title: this.i18n.t(`node.${key}Ask`, { count: nodes.length }),
        message: this.i18n.t(`node.${key}Msg`, { count: nodes.length }),
        confirmLabel: this.i18n.t(`node.${key}`),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const chat = await this.clipboard.extractSequence(nodes, { withVisibleSubtree });
      this.navSelection.clear();
      if (chat) {
        this.toast.success(this.i18n.t('node.extractSelectedDone'));
        await this.chatService.selectChat(chat.id);
      }
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.extractFailed', { error: err?.message || err }));
    }
  }

  /** Remove the selected chain (top-first) — left-over children are
   *  reparented to the chain's topmost surviving ancestor. */
  async deleteNavSelection(): Promise<void> {
    const nodes = this.selectedNavNodes();
    if (!nodes.length) return;
    try {
      for (const node of nodes) {
        await this.chatService.deleteNode(node.chatId, node.id, { keepChildren: true });
      }
      this.navSelection.clear();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.deleteSelectedFailed', { error: err?.message || err }));
    }
  }

  // ------------------------------------------------------------------
  // Paste (insert / append the clipboard chain into the active path)
  // ------------------------------------------------------------------

  /** The two visible navbar nodes around a paste button: the node itself
   *  (left) and the next visible node (right, or null when pasting at the end).
   *  Excluded-from-context nodes are skipped — they are not shown in the nav-bar.
   *  A delegate over `ChatNavMenuService` (it owns the paste-menu geometry). */
  private navPasteTargets(nodeId: string): { leftId: string; rightId: string | null } | null {
    return this.navMenu.pasteTargets(nodeId);
  }

  private async pasteChain(
    mode: 'insert' | 'append',
    leftId: string,
    rightId: string | null,
  ): Promise<void> {
    try {
      if (mode === 'insert') {
        await this.clipboard.insertIntoPath(leftId, rightId);
      } else {
        await this.clipboard.appendIntoPath(leftId, rightId);
      }
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.pasteFailed', { error: err?.message || err }));
    }
  }

  /** Paste the clipboard chain into the active path right between the node
   *  after which the navbar paste button sits and its successor — the two
   *  visible nodes left and right of the button (a simple left click, and
   *  Ctrl+V on the hovered node). If the button belongs to the last visible
   *  node, the chain is appended behind it. */
  async pasteNavSelectionAfter(nodeId: string): Promise<void> {
    const targets = this.navPasteTargets(nodeId);
    if (!targets) return;
    await this.pasteChain('insert', targets.leftId, targets.rightId);
  }

  /** The navbar paste button appears after this node only when pasting there
   *  is allowed (never left of the empty terminal direction node). */
  canPasteAfter(node: ChatNode): boolean {
    return this.navPasteTargets(node.id) !== null;
  }

  /** Append the clipboard chain as a PARALLEL BRANCH under the left visible
   *  node (sibling of the right visible node) instead of splicing it into the
   *  visible chain. Only made visible when pasted at the very end. */
  async appendNavSelectionAfter(nodeId: string): Promise<void> {
    const targets = this.navPasteTargets(nodeId);
    if (!targets) return;
    await this.pasteChain('append', targets.leftId, targets.rightId);
  }

  /** The `pasteChain` output handler: the shared insert-vs-append splice used
   *  by the paste menu (via the nav bar's `ChatNavMenuHost`). */
  pasteChainInto(
    mode: 'insert' | 'append',
    leftId: string,
    rightId: string | null,
  ): Promise<void> {
    return this.pasteChain(mode, leftId, rightId);
  }

  /** Targets for pasting the clipboard IN FRONT OF `node` (between its
   *  predecessor and the node), or null when not possible — no predecessor
   *  (first visible node) or left of the terminal empty direction. A delegate
   *  over `ChatNavMenuService`. */
  private navPasteBeforeTargets(node: ChatNode): { leftId: string; rightId: string | null } | null {
    return this.navMenu.pasteBeforeTargets(node);
  }

  /** Paste the clipboard chain immediately BEFORE `node` in the active path. */
  async pasteNavSelectionBefore(node: ChatNode): Promise<void> {
    const targets = this.navPasteBeforeTargets(node);
    if (!targets) return;
    await this.pasteChain('insert', targets.leftId, targets.rightId);
  }

  /** `app-chat-nav-bar` emits the node ID — resolve it to the path node. */
  async pasteNavSelectionBeforeId(nodeId: string): Promise<void> {
    const node = this.chatService.getActivePath().find(n => n.id === nodeId);
    if (node) await this.pasteNavSelectionBefore(node);
  }

  // ------------------------------------------------------------------
  // Branch ops (navbar equivalent of the node's branch switcher)
  // ------------------------------------------------------------------

  /** Switch the active continuation at `node.parentId` to the previous/next
   *  sibling — the navbar equivalent of the node's branch switcher. */
  switchNavSibling(node: ChatNode, dir: -1 | 1): void {
    const siblings = this.chatService.getChildren(node.parentId);
    if (siblings.length < 2) return;
    const anchorId = this.chatService.getActiveChildId(node.parentId) ?? node.id;
    const idx = siblings.findIndex(s => s.id === anchorId);
    const target = siblings[(idx + dir + siblings.length) % siblings.length];
    if (!target) return;
    this.chatService.setActiveChild(node.parentId, target.id);
  }

  /** Start a branch next to `node`: materialize an empty direction leaf with
   *  the SAME parent, so it sits in parallel with `node`. The active path
   *  then picks up the new leaf as its next node — the navbar equivalent of
   *  typing a fresh continuation beside the current one. */
  async startBranchAt(node: ChatNode): Promise<void> {
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    const draft = await this.chatService.addNode(chatId, {
      parentId: node.parentId,
      role: 'user',
      content: '',
      modelId: node.modelId || undefined,
      providerId: node.providerId || undefined,
    });
    this.chatService.setActiveChild(node.parentId, draft.id);
  }

  // ------------------------------------------------------------------
  // Node-menu variants (whole selection when the node is part of one)
  // ------------------------------------------------------------------

  /** The nodes a navbar clipboard action targets: the whole selection when
   *  the right-clicked node is part of one, otherwise just that node. */
  private navActionNodes(node: ChatNode): ChatNode[] {
    if (this.navSelection.selectedIds().includes(node.id)) {
      return this.selectedNavNodes();
    }
    return [node];
  }

  copyNavNodes(node: ChatNode): void {
    const nodes = this.navActionNodes(node);
    if (!nodes.length) return;
    this.clipboard.copySequence(nodes);
  }

  async cutNavNodes(node: ChatNode): Promise<void> {
    const nodes = this.navActionNodes(node);
    if (!nodes.length) return;
    const hasPayload = nodes.some(
      n => !!n.content?.trim() || !!(n.attachments && n.attachments.length),
    );
    if (hasPayload) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.cutSelectedAsk', { count: nodes.length }),
        message: this.i18n.t('node.cutSelectedMsg', { count: nodes.length }),
        confirmLabel: this.i18n.t('node.cutSelected'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await this.clipboard.cutSequence(nodes);
      this.navSelection.clear();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.cutFailed', { error: err?.message || err }));
    }
  }

  async deleteNavNodes(node: ChatNode): Promise<void> {
    const nodes = this.navActionNodes(node);
    if (!nodes.length) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('node.navDeleteAsk', { count: nodes.length }),
      message: this.i18n.t('node.navDeleteMsg', { count: nodes.length }),
      confirmLabel: this.i18n.t('node.deleteSelected'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      for (const n of nodes) {
        await this.chatService.deleteNode(n.chatId, n.id, { keepChildren: true });
      }
      this.navSelection.clear();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.deleteSelectedFailed', { error: err?.message || err }));
    }
  }

  // ------------------------------------------------------------------
  // Keyboard dispatch (navbar shortcuts)
  // ------------------------------------------------------------------

  /**
   * Keyboard handling for the navbar clipboard, called from the page's `onKey`
   * AFTER the Escape/menu handling, the `isTyping` guard and the paced-read
   * keys.
   *
   * Copy / cut / delete act on the WHOLE SELECTION when one exists, else on
   * the navbar node under the pointer — mirroring the context menu, which
   * acts on the whole selection when the right-clicked node is part of one,
   * else on just that node. Ctrl+V pastes behind the hovered node.
   *
   * Returns true when the event was consumed — the page must not process it
   * further.
   */
  onKey(event: KeyboardEvent): boolean {
    const ctrl = event.ctrlKey || event.metaKey;

    if (ctrl && (event.key === 'c' || event.key === 'C')) {
      if (this.navSelection.hasSelection()) {
        event.preventDefault();
        this.copyNavSelection();
        return true;
      }
      const node = this.hoveredNavNode();
      if (node) {
        event.preventDefault();
        this.copyNavNodes(node);
        return true;
      }
      return false;
    }

    if (ctrl && (event.key === 'x' || event.key === 'X')) {
      if (this.navSelection.hasSelection()) {
        event.preventDefault();
        void this.cutNavSelection();
        return true;
      }
      const node = this.hoveredNavNode();
      if (node) {
        event.preventDefault();
        void this.cutNavNodes(node);
        return true;
      }
      return false;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.navSelection.hasSelection()) {
        event.preventDefault();
        void this.deleteNavSelection();
        return true;
      }
      const node = this.hoveredNavNode();
      if (node) {
        event.preventDefault();
        void this.deleteNavNodes(node);
        return true;
      }
      return false;
    }

    // Paste behind the navbar node under the pointer.
    if (ctrl && (event.key === 'v' || event.key === 'V')) {
      const targetId = this.navSelection.clipboardTargetId();
      if (this.clipboard.hasContent() && targetId) {
        event.preventDefault();
        void this.pasteNavSelectionAfter(targetId);
        return true;
      }
    }

    return false;
  }

  /** The navbar node currently under the pointer (keyboard copy/cut/delete
   *  target when nothing is selected). */
  private hoveredNavNode(): ChatNode | null {
    const id = this.navSelection.clipboardTargetId();
    if (!id) return null;
    return this.chatService.getActivePath().find(n => n.id === id) ?? null;
  }
}
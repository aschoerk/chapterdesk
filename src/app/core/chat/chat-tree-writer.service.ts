import { Injectable, inject } from '@angular/core';
import { Chat, ChatNode, CreateNodeRequest, NodeAttachment, NodeUsageSummary } from '../../models/chat';
import { CHAT_API } from '../../api/chat-api.token';
import { isImageMime, resolvedMime } from '../llm/llm-message';
import { ChatTreeStateService } from './chat-tree-state.service';
import { ChatTreeReaderService } from './chat-tree-reader.service';
import { ChatOperationService } from './chat-operation.service';

/** True when the node carries at least one real image attachment (e.g. a
 *  generated illustration). Used to treat an empty-text, image-only answer
 *  as an answered assistant chapter for draft-housekeeping. */
export function hasImageAttachment(node: Pick<ChatNode, 'attachments'> | null | undefined): boolean {
  return (node?.attachments ?? []).some(a => isImageMime(resolvedMime(a)));
}

/**
 * WRITE logic for the chat tree: every mutation of the chat/nodes state, plus
 * the draft-housekeeping that keeps the active path typed-into-able, and the
 * trash lifecycle. It is the ONLY service (besides `ChatService`, which just
 * delegates) that persists through the API and mutates
 * `ChatTreeStateService`'s signals.
 *
 * Dependencies flow one way: writer → reader → state (and → operations for the
 * generation/batch flags). No cycles. Read-only navigation lives in
 * `ChatTreeReaderService`; lore materialization in `ChatLoreService`.
 */
@Injectable({ providedIn: 'root' })
export class ChatTreeWriterService {
  private readonly state = inject(ChatTreeStateService);
  private readonly reader = inject(ChatTreeReaderService);
  private readonly operations = inject(ChatOperationService);
  private readonly api = inject(CHAT_API);

  // ---------------------------------------------------------- active path

  /** Switch the active sibling under a parent. */
  setActiveChild(parentId: string | null, childId: string): void {
    const key = parentId ?? 'root';
    this.state.activeChildMap.update(m => ({ ...m, [key]: childId }));
  }

  /** Walk root → leaf, choosing the newest child at every fork. */
  restoreMostRecentPath(): void {
    const map: Record<string, string> = {};
    let parentId: string | null = null;
    while (true) {
      const child = this.reader.newestChild(parentId);
      if (!child) break;
      map[parentId ?? 'root'] = child.id;
      parentId = child.id;
    }
    this.state.activeChildMap.set(map);
  }

  /** Live-patch the raw node list (used to paint streaming answers). */
  updateNodes(updateFn: (value: ChatNode[]) => ChatNode[]): void {
    this.state.nodes.update(updateFn);
  }

  // ---------------------------------------------------------- node writes

  async loadNodes(chatId: string): Promise<void> {
    this.state.nodes.set(await this.api.getNodes(chatId));
  }

  async fetchNodes(chatId: string): Promise<ChatNode[]> {
    return this.api.getNodes(chatId);
  }

  async addNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    const node = await this.api.createNode(chatId, data);
    this.state.nodes.update(list => [...list, node]);
    return node;
  }

  /** Create a node during bundle import without polluting another chat's in-memory list. */
  async createNodeForImport(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    const node = await this.api.createNode(chatId, data);
    if (this.state.currentChatId() === chatId) {
      this.state.nodes.update(list => [...list, node]);
    }
    return node;
  }

  async persistQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
    modelId?: string,
    providerId?: string
  ): Promise<ChatNode> {
    const node = await this.api.patchNode(chatId, nodeId, {
      content,
      attachments,
      modelId,
      providerId
    });
    this.state.nodes.update(list => list.map(n => (n.id === nodeId ? { ...n, ...node } : n)));
    return this.state.nodes().find(n => n.id === nodeId) ?? node;
  }

  async patchNode(
    chatId: string,
    nodeId: string,
    data: {
      content?: string;
      thinking?: string;
      attachments?: NodeAttachment[];
      modelId?: string;
      providerId?: string;
      parentId?: string | null;
      excludeFromContext?: boolean;
      excludeAfterSend?: boolean;
    }
  ): Promise<ChatNode> {
    const node = await this.api.patchNode(chatId, nodeId, data);
    this.state.nodes.update(list => list.map(n => (n.id === nodeId ? { ...n, ...node } : n)));
    return this.state.nodes().find(n => n.id === nodeId) ?? node;
  }

  /** Edit a question → creates a new branch. */
  async branchQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    modelId?: string,
    providerId?: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    const node = await this.api.branchUser(chatId, nodeId, {
      content,
      modelId,
      providerId,
      attachments
    });
    this.state.nodes.update(list => [...list, node]);
    return node;
  }

  async editAssistant(chatId: string, nodeId: string, content: string,
                      attachments?: NodeAttachment[],
                      thinking?: string,
                      usage?: NodeUsageSummary): Promise<ChatNode> {
    const saved = await this.api.editAssistant(chatId, nodeId, content, attachments, thinking, usage);

    this.state.nodes.update(list => {
      const retired = list.map(n =>
        n.id === nodeId && saved.id !== nodeId ? { ...n, isCurrent: false } : n
      );
      const withoutDup = retired.filter(n => n.id !== saved.id);
      return [...withoutDup, saved];
    });

    this.adoptSubtree(nodeId, saved.id);
    this.setActiveChild(saved.parentId ?? null, saved.id);
    await this.ensureDraftAtLeaf(chatId);
    return saved;
  }

  async editUser(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    const saved = await this.api.editUser(chatId, nodeId, content, attachments);

    this.state.nodes.update(list => {
      const retired = list.map(n =>
        n.id === nodeId && saved.id !== nodeId ? { ...n, isCurrent: false } : n
      );
      const withoutDup = retired.filter(n => n.id !== saved.id);
      return [...withoutDup, saved];
    });

    this.adoptSubtree(nodeId, saved.id);
    this.setActiveChild(saved.parentId ?? null, saved.id);
    return saved;
  }

  private adoptSubtree(oldId: string, newId: string): void {
    if (oldId === newId) return;

    this.state.nodes.update(list =>
      list.map(n => n.parentId === oldId ? { ...n, parentId: newId } : n)
    );

    this.state.activeChildMap.update(m => {
      if (!(oldId in m)) return m;
      const { [oldId]: childId, ...rest } = m;
      return { ...rest, [newId]: childId };
    });
  }

  async deleteNode(
    chatId: string,
    nodeId: string,
    options?: { keepChildren?: boolean }
  ): Promise<void> {
    const snapshot = this.state.nodes();
    const target = snapshot.find(n => n.id === nodeId);
    const parentId = target?.parentId ?? null;
    const keepChildren = !!options?.keepChildren;

    await this.api.deleteNode(chatId, nodeId, options);

    if (keepChildren) {
      this.state.nodes.update(list =>
        list
          .filter(n => n.id !== nodeId)
          .map(n => (n.parentId === nodeId ? { ...n, parentId } : n))
      );

      this.state.activeChildMap.update(m => {
        const next: Record<string, string> = {};
        const promoted = m[nodeId];
        for (const [k, v] of Object.entries(m)) {
          if (k === nodeId) continue;
          if (v === nodeId) {
            if (promoted) next[k] = promoted;
            continue;
          }
          next[k] = v;
        }
        const parentKey = parentId ?? 'root';
        if (promoted && !(parentKey in next)) {
          next[parentKey] = promoted;
        }
        return next;
      });
    } else {
      const toDelete = new Set<string>();
      const collect = (id: string) => {
        toDelete.add(id);
        snapshot.filter(n => n.parentId === id).forEach(child => collect(child.id));
      };
      collect(nodeId);

      this.state.nodes.update(list => list.filter(n => !toDelete.has(n.id)));

      this.state.activeChildMap.update(m => {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(m)) {
          if (toDelete.has(k) || toDelete.has(v)) continue;
          next[k] = v;
        }
        return next;
      });
    }

    const remaining = this.reader.getChildren(parentId);
    if (remaining.length > 0) {
      this.setActiveChild(parentId, this.reader.newestChild(parentId)!.id);
    }

    await this.ensureDraftAtLeaf(chatId);
    await this.loadDeletedNodes(chatId);
  }

  /** Move existing nodes under a new parent and keep local state in sync. */
  async reparentNodes(chatId: string, nodeIds: string[], newParentId: string | null): Promise<void> {
    const ids = [...new Set(nodeIds)].filter(id => id && id !== newParentId);
    if (ids.length === 0) return;

    for (const id of ids) {
      const saved = await this.api.patchNode(chatId, id, { parentId: newParentId });
      this.state.nodes.update(list => list.map(n => n.id === id ? { ...n, ...saved } : n));
    }

    this.state.activeChildMap.update(m => {
      const next: Record<string, string> = { ...m };
      const parentKey = newParentId ?? 'root';
      if (!(parentKey in next) && ids.length > 0) {
        next[parentKey] = ids[0];
      }
      return next;
    });
  }

  /** Reorder siblings under a parent (assigns persistent positions) and apply locally. */
  async reorderSiblings(
    chatId: string,
    parentId: string | null,
    orderedNodeIds: string[],
  ): Promise<void> {
    const updated = await this.api.reorderSiblings(chatId, parentId, orderedNodeIds);
    const byId = new Map(updated.map(n => [n.id, n]));
    this.state.nodes.update(list => list.map(n => byId.get(n.id) ?? n));
  }

  /** Persist per-node usage (in place) + refresh the chat totals in the list. */
  async saveChatUsage(chatId: string, nodes: { nodeId: string; usage?: NodeUsageSummary }[]): Promise<Chat | null> {
    const chat = await this.api.saveChatUsage(chatId, nodes);
    this.state.chats.update(list => list.map(c => (c.id === chat.id ? chat : c)));
    return chat;
  }

  // ------------------------------------------------------- draft housekeeping

  private ensuringDraft = false;
  private ensureDraftPromise: Promise<void> | null = null;

  /**
   * Guarantee the active path ends on an empty question the user can type into.
   * - empty chat → root draft question
   * - leaf answer with generated text and no child question → child draft
   *
   * Re-entrancy: the chat-page housekeeping effect AND the Continue / Switch
   * characters batch loop both call this after every send. A single
   * `ensuringDraft` boolean guard made a second caller return early while the
   * first was mid-flight (its `addNode` is async), so a caller then read a
   * stale leaf and the batch broke after one round (most visible when chat
   * lore exists — `markSentOnceExcluded` adds real async gaps that let the
   * effect grab the guard first). Concurrent callers now await the SAME
   * in-flight promise, so nobody returns early with a half-created draft.
   */
  async ensureDraftAtLeaf(chatId: string): Promise<void> {
    if (!chatId || this.operations.generatingNodeId()) return;
    if (this.state.elaborating) return;
    if (this.state.currentChatId() !== chatId) return;
    if (!this.ensureDraftPromise) {
      this.ensureDraftPromise = this.doEnsureDraftAtLeaf(chatId).finally(() => {
        this.ensureDraftPromise = null;
      });
    }
    return this.ensureDraftPromise;
  }

  private async doEnsureDraftAtLeaf(chatId: string): Promise<void> {
    this.ensuringDraft = true;
    try {
      if (this.state.nodes().every(n => n.chatId !== chatId)) {
        await this.loadNodes(chatId);
      }

      if (!this.reader.getActivePath().length) {
        this.restoreMostRecentPath();
      }

      let leaf = this.reader.getActivePath().at(-1) ?? null;

      if (!leaf) {
        const roots = this.reader.getChildren(null).filter(n => n.role === 'user');
        if (roots.length > 0) {
          this.setActiveChild(null, this.reader.newestChild(null)!.id);
          return;
        }
        const draft = await this.addNode(chatId, {
          parentId: null,
          role: 'user',
          content: ''
        });
        this.setActiveChild(null, draft.id);
        return;
      }

      // If the leaf is already an empty draft question (the composer), the
      // path is in the right shape — nothing to do.
      if (this.reader.isDraftQuestion(leaf)) return;

      // Composer leaves are only ever created under ANSWERED ASSISTANT
      // chapters. Deliberately NOT under a childless user/system node with
      // content: the chat-page housekeeping effect runs this method on every
      // node/path change, and during a send a question briefly has content
      // but no answer yet (between persistQuestion and the answer node
      // appearing) — creating a draft there would spawn a spurious extra leaf
      // on every Continue/send. The "Delete Continuation" and "new chat"
      // cases are handled explicitly by ensureDraftUnderUserLeaf from the
      // stable entry points (chat-node delete / selectChat).
      if (leaf.role !== 'assistant') return;
      // An empty-text assistant chapter with real image attachments is still
      // an ANSWERED chapter (an image-capable model answered the direction
      // with ONLY a picture — the illustration was attached, no text came
      // back). It needs the next composer leaf too, so only bail when the
      // leaf has neither text nor an image.
      if (!leaf.content?.trim() && !hasImageAttachment(leaf)) return;

      const existing = this.reader.getChildren(leaf.id).filter(n => n.role === 'user');
      if (existing.length > 0) {
        const draft = existing.find(n => this.reader.isDraftQuestion(n)) ?? existing[0];
        this.setActiveChild(leaf.id, draft.id);
        return;
      }

      const draft = await this.addNode(chatId, {
        parentId: leaf.id,
        role: 'user',
        content: '',
        modelId: leaf.modelId || undefined,
        providerId: leaf.providerId || undefined
      });
      this.setActiveChild(leaf.id, draft.id);
    } finally {
      this.ensuringDraft = false;
    }
  }

  /**
   * Create an empty composer leaf under the ACTIVE path's leaf when it is a
   * childless user/system node with content — the "Delete Continuation" case
   * (the answer was removed, so the remaining question needs a composer) and a
   * newly created chat whose seeds end on a user node (no greeting).
   *
   * Deliberately NOT part of ensureDraftAtLeaf: that method is called by the
   * chat-page housekeeping effect on every node/path change, and during a send
   * a question briefly has content but no answer yet — creating a draft there
   * would spawn a spurious sibling leaf on every send. This helper is called
   * only from stable points (delete / selectChat) where no generation is in
   * flight, so the extra composer is exactly the intended one.
   */
  async ensureDraftUnderUserLeaf(chatId: string): Promise<void> {
    if (this.operations.generatingNodeId()) return;
    if (this.state.elaborating) return;
    if (this.state.currentChatId() !== chatId) return;

    const leaf = this.reader.getActivePath().at(-1) ?? null;
    if (!leaf) return;
    if (leaf.role === 'assistant') return; // answered chapters: ensureDraftAtLeaf handles them
    if (!leaf.content?.trim()) return;     // already an empty draft → nothing to do
    if (this.reader.isDraftQuestion(leaf)) return;

    const existing = this.reader.getChildren(leaf.id).filter(n => n.role === 'user');
    if (existing.length > 0) {
      const draft = existing.find(n => this.reader.isDraftQuestion(n)) ?? existing[0];
      this.setActiveChild(leaf.id, draft.id);
      return;
    }

    const draft = await this.addNode(chatId, {
      parentId: leaf.id,
      role: 'user',
      content: '',
      modelId: leaf.modelId || undefined,
      providerId: leaf.providerId || undefined
    });
    this.setActiveChild(leaf.id, draft.id);
  }

  // ------------------------------------------------------------- trash

  /** Refresh the trash list (deleted branch roots) for a chat. */
  async loadDeletedNodes(chatId: string): Promise<void> {
    if (!chatId) {
      this.state.deletedNodes.set([]);
      return;
    }
    this.state.deletedNodes.set(await this.api.getDeletedNodes(chatId));
  }

  /** Restore a soft-deleted branch back into the live tree. */
  async restoreBranch(chatId: string, nodeId: string): Promise<void> {
    await this.api.restoreNode(chatId, nodeId);
    await this.loadNodes(chatId);
    await this.loadDeletedNodes(chatId);
    // Re-point the active path so the restored branch is visible right away.
    for (const node of this.reader.getPathToNode(nodeId)) {
      this.setActiveChild(node.parentId ?? null, node.id);
    }
  }

  /** Permanently remove a soft-deleted branch. */
  async purgeBranch(chatId: string, nodeId: string): Promise<void> {
    await this.api.purgeNode(chatId, nodeId);
    await this.loadDeletedNodes(chatId);
  }

  // ------------------------------------------------------------- chats

  async loadChats(): Promise<void> {
    this.state.chats.set(await this.api.getChats());
  }

  async createChat(title = 'New Chat', projectId: string | null = null): Promise<Chat> {
    const chat = await this.api.createChat(title, projectId);
    this.state.chats.update(list => [chat, ...list]);
    return chat;
  }

  /** Clone a story including the full node tree (parents, siblings, versions). */
  async cloneChat(chatId: string): Promise<Chat> {
    const chat = await this.api.cloneChat(chatId);
    this.state.chats.update(list => [chat, ...list]);
    return chat;
  }

  async deleteChat(id: string): Promise<void> {
    await this.api.deleteChat(id);
    this.state.chats.update(list => list.filter(c => c.id !== id));

    if (this.state.currentChatId() === id) {
      this.state.currentChatId.set(null);
      this.state.nodes.set([]);
      this.state.deletedNodes.set([]);
    }
  }

  async reassignChat(chatId: string, projectId: string | null): Promise<Chat> {
    const chat = await this.api.patchChat(chatId, { projectId });
    this.state.chats.update(list =>
      list.map(c => (c.id === chatId ? chat : c))
    );
    return chat;
  }

  async reassignChatParams(chatId: string, chatParametersId: string | null): Promise<Chat> {
    const chat = await this.api.patchChat(chatId, { chatParametersId });
    this.state.chats.update(list =>
      list.map(c => (c.id === chatId ? chat : c))
    );
    return chat;
  }

  /** Patch per-chat meta (lore text, auto-exclude-directions mode) and refresh the local list. */
  async patchChatMeta(
    chatId: string,
    changes: { lore?: string | null; autoExcludeDirections?: boolean }
  ): Promise<Chat> {
    const chat = await this.api.patchChat(chatId, changes);
    this.state.chats.update(list =>
      list.map(c => (c.id === chatId ? chat : c))
    );
    return chat;
  }

  async updateChatTitle(id: string, title: string): Promise<void> {
    const updated = await this.api.patchChat(id, { title });

    this.state.chats.update(list =>
      list.map(c => (c.id === id ? updated : c))
    );
  }

  // ------------------------------------------------------- project deletion

  /**
   * After a project is deleted, keep the local chat list in sync: either drop
   * the project's chats entirely (`deleteChats`) or unassign them (keep the
   * chats, clear their `projectId`). Called by `ProjectService.deleteProject`.
   */
  applyProjectDelete(projectId: string, deleteChats: boolean): void {
    this.state.chats.update(list =>
      deleteChats
        ? list.filter(c => c.projectId !== projectId)
        : list.map(c => (c.projectId === projectId ? { ...c, projectId: null } : c))
    );
  }
}
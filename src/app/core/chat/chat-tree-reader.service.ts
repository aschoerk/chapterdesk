import { Injectable, computed, inject } from '@angular/core';
import { Chat, ChatNode } from '../../models/chat';
import { isChatLoreNode } from './chat-lore';
import { ChatTreeStateService } from './chat-tree-state.service';

/**
 * READ-ONLY chat-tree logic: every navigation / query over the chat tree, as a
 * pure function of `ChatTreeStateService`. No side effects, no persistence —
 * all mutations live in `ChatTreeWriterService`.
 */
@Injectable({ providedIn: 'root' })
export class ChatTreeReaderService {
  private readonly state = inject(ChatTreeStateService);

  readonly chatsByProject = computed(() => {
    const map = new Map<string | null, Chat[]>();
    for (const chat of this.state.chats()) {
      const key = chat.projectId ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(chat);
    }
    return map;
  });

  /** All nodes of the currently selected chat as a flat list. */
  readonly currentNodes = computed(() => {
    const chatId = this.state.currentChatId();
    if (!chatId) return [];
    return this.state.nodes().filter(n => n.chatId === chatId);
  });

  /** Currently chosen child under a parent (null parent = root level). */
  getActiveChildId(parentId: string | null): string | null {
    const key = parentId ?? 'root';
    return this.state.activeChildMap()[key] ?? null;
  }

  private nodeTimestamp(n: ChatNode): number {
    const raw = n.updatedAt || n.createdAt || '';
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }

  newestChild(parentId: string | null): ChatNode | null {
    const siblings = this.getChildren(parentId);
    if (siblings.length === 0) return null;
    return siblings.reduce((a, b) =>
      this.nodeTimestamp(a) >= this.nodeTimestamp(b) ? a : b
    );
  }

  getActiveChild(parentId: string | null): ChatNode | null {
    const siblings = this.getChildren(parentId);
    if (siblings.length === 0) return null;

    const activeId = this.getActiveChildId(parentId);
    const found = siblings.find(s => s.id === activeId);
    return found ?? this.newestChild(parentId);
  }

  /**
   * Memoized per-parent child lists of the CURRENT chat's nodes, rebuilt only
   * when `state.nodes()` changes. `getChildren()` (and everything built on it:
   * the active path, the nav bar, branch counts, sibling switching) used to
   * re-scan + re-sort the WHOLE node list on every call — O(depth × n) per
   * path computation, so long stories slowed down super-linearly. With this
   * map the lookups are O(1) (plus one sort per parent, done once here), so
   * path computations are O(depth).
   */
  private readonly childrenByParent = computed<Map<string | null, ChatNode[]>>(() => {
    const map = new Map<string | null, ChatNode[]>();
    for (const n of this.state.nodes()) {
      if (!n.isCurrent) continue;
      const key = n.parentId ?? null;
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(n);
    }
    // Sort each sibling list by position ONCE. The sort is stable, so equal
    // positions keep their node-list order — identical to the old per-call
    // filter+sort.
    for (const list of map.values()) {
      list.sort((a, b) => this.nodePosition(a) - this.nodePosition(b));
    }
    return map;
  });

  /** nodeId → node of the current chat, rebuilt only when `state.nodes()` changes. */
  private readonly nodesById = computed<Map<string, ChatNode>>(() => {
    const map = new Map<string, ChatNode>();
    for (const n of this.state.nodes()) {
      map.set(n.id, n);
    }
    return map;
  });

  /** Linear path from root following the active-child map. */
  getActivePath(): ChatNode[] {
    const path: ChatNode[] = [];
    let current = this.getActiveChild(null);
    while (current) {
      path.push(current);
      current = this.getActiveChild(current.id);
    }
    return path;
  }

  /** Path from root down to (and including) a given node. */
  getPathToNode(nodeId: string): ChatNode[] {
    const map = this.nodesById();
    const path: ChatNode[] = [];
    let cur: ChatNode | undefined = map.get(nodeId);
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? map.get(cur.parentId) : undefined;
    }
    return path;
  }

  private nodePosition(n: ChatNode): number {
    return typeof n.position === 'number' ? n.position : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Siblings of `parentId` (null = root level), only current nodes, ordered by
   * position. Returns a fresh shallow copy so callers may freely reorder /
   * filter the result without corrupting the shared memoized lists.
   */
  getChildren(parentId: string | null): ChatNode[] {
    return [...(this.childrenByParent().get(parentId ?? null) ?? [])];
  }

  /** All siblings of a given node (including the node itself). */
  getSiblingsOf(node: ChatNode): ChatNode[] {
    return this.getChildren(node.parentId ?? null);
  }

  /**
   * Retired versions of `node`, newest first, walking previousVersionId.
   * These are not on getActivePath() and are not sent to the LLM.
   */
  getPriorVersions(node: ChatNode): ChatNode[] {
    const byId = this.nodesById();
    const out: ChatNode[] = [];
    const seen = new Set<string>([node.id]);
    let id = node.previousVersionId ?? null;
    while (id && !seen.has(id)) {
      seen.add(id);
      const prev = byId.get(id);
      if (!prev) break;
      out.push(prev);
      id = prev.previousVersionId ?? null;
    }
    return out;
  }

  isDraftQuestion(node: ChatNode): boolean {
    return node.role === 'user'
      && !isChatLoreNode(node)
      && !node.content?.trim()
      && !(node.attachments?.length);
  }
}
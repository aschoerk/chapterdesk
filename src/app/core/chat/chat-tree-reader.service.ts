import { Injectable, computed, inject } from '@angular/core';
import { Chat, ChatNode } from '../../models/chat';
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
    const map = new Map(this.state.nodes().map(n => [n.id, n]));
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

  getChildren(parentId: string | null): ChatNode[] {
    return this.state.nodes()
      .filter(n =>
        (n.parentId ?? null) === (parentId ?? null) &&
        n.isCurrent
      )
      .sort((a, b) => this.nodePosition(a) - this.nodePosition(b));
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
    const byId = new Map(this.state.nodes().map(n => [n.id, n]));
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
      && !node.content?.trim()
      && !(node.attachments?.length);
  }
}
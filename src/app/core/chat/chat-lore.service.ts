import { Injectable, inject } from '@angular/core';
import { ChatNode } from '../../models/chat';
import { ChatTreeStateService } from './chat-tree-state.service';
import { ChatTreeWriterService } from './chat-tree-writer.service';
import {
  buildLoreNodeContent,
  isChatLoreNode,
  loreTextOf
} from './chat-lore';

/** Re-export the pure lore helpers so existing importers of the service keep
 *  working (`flows.spec` imports `buildLoreNodeContent` / `isChatLoreNode`). */
export { buildLoreNodeContent, isChatLoreNode, loreTextOf } from './chat-lore';

/**
 * Chat-LORE logic — materializing the chat's `lore` text as a one-shot node in
 * front of each direction that is sent, and deactivating those nodes after
 * they have been in the history once. Reads the lore live from the chat and
 * writes nodes through `ChatTreeWriterService` (full dependency chain:
 * lore → writer → reader → state; no cycles).
 */
@Injectable({ providedIn: 'root' })
export class ChatLoreService {
  private readonly state = inject(ChatTreeStateService);
  private readonly writer = inject(ChatTreeWriterService);

  /**
   * Insert a fresh chat-lore node IN FRONT OF a direction node (as its new
   * parent) right before that direction is sent, so the model sees the lore
   * immediately before the direction. The node is materialized with
   * `excludeAfterSend` — it is sent with that ONE direction, then flipped to
   * `excludeFromContext` by `markSentOnceExcluded` (deactivated). The next
   * direction gets a NEW lore node generated in front of it.
   *
   * Content = `buildLoreNodeContent` (prefix + lore + suffix, so the LLM
   * accepts it as lore). The lore is read live from `chat.lore`, so editing
   * it updates upcoming lore nodes. No-op when `chat.lore` AND `extra` are
   * empty.
   *
   * `extra` is the TEMPORARY part for this one send (the chapter-plan slice
   * the Elaborate dialog passes). It is NOT written to `chat.lore`, so it
   * never leaks into later chapters — the node itself documents what was sent.
   *
   * Idempotent: a direction that already sits behind a pending lore node with
   * the current text is left untouched (a re-send of the same direction
   * re-arms that node with the up-to-date text).
   */
  async ensureLoreNodeBefore(
    chatId: string,
    directionNodeId: string,
    extra?: string | null
  ): Promise<void> {
    const chat = this.state.chats().find(c => c.id === chatId);
    const content = buildLoreNodeContent(chat?.lore ?? null, extra);
    const direction = this.state.nodes().find(n => n.id === directionNodeId);
    if (!direction) return;
    const dirParentId = direction.parentId ?? null;
    const parent = dirParentId ? this.state.nodes().find(n => n.id === dirParentId) : null;
    const existingLore = isChatLoreNode(parent) ? parent : null;

    if (!content) {
      // Lore cleared/empty: deactivate a pending (not-yet-sent) lore node so
      // no stale lore is ever sent.
      if (existingLore && existingLore.excludeAfterSend && !existingLore.excludeFromContext) {
        await this.writer.patchNode(chatId, existingLore.id, {
          excludeFromContext: true,
          excludeAfterSend: false
        });
      }
      return;
    }

    if (existingLore) {
      // Already materialized in front of this direction: keep the current
      // text and (re-)arm it so the send carries the up-to-date lore.
      if (
        existingLore.content !== content ||
        existingLore.excludeFromContext ||
        !existingLore.excludeAfterSend
      ) {
        await this.writer.patchNode(chatId, existingLore.id, {
          content,
          excludeFromContext: false,
          excludeAfterSend: true
        });
      }
      return;
    }

    // Materialize a fresh lore node as the direction's new parent, so the
    // active path flows … → lore → direction → (answer). The node gets the
    // dedicated `lore` role (not `user`), so the tree/nav-bar/message builder
    // can tell it apart from a real direction without scanning the content.
    const created = await this.writer.addNode(chatId, {
      parentId: dirParentId,
      role: 'lore',
      content,
      excludeAfterSend: true
    });
    await this.writer.patchNode(chatId, direction.id, { parentId: created.id });
    this.writer.setActiveChild(dirParentId ?? null, created.id);
    this.writer.setActiveChild(created.id, direction.id);
  }

  /**
   * After a send completed, flip any one-shot `excludeAfterSend` nodes on the
   * question's path to `excludeFromContext` (clearing `excludeAfterSend`). A
   * lore node therefore reaches the model exactly once, then documents itself
   * in history without re-shipping. Best effort — never throws.
   */
  async markSentOnceExcluded(chatId: string, nodeId: string): Promise<void> {
    try {
      const map = new Map(this.state.nodes().map(n => [n.id, n]));
      const path: ChatNode[] = [];
      let cur: ChatNode | undefined = map.get(nodeId);
      while (cur) {
        path.unshift(cur);
        cur = cur.parentId ? map.get(cur.parentId) : undefined;
      }
      for (const n of path) {
        if (n.excludeAfterSend && !n.excludeFromContext) {
          await this.writer.patchNode(chatId, n.id, {
            excludeFromContext: true,
            excludeAfterSend: false
          });
        }
      }
    } catch {
      // Best effort — a failed flag flip must not surface as an error.
    }
  }
}
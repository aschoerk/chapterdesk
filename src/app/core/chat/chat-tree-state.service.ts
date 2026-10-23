import { Injectable, signal } from '@angular/core';
import { Chat, ChatNode } from '../../models/chat';

/**
 * The single source of truth for the chat tree: the signals that `ChatService`
 * and the chat page consume, plus the `elaborating` writer-lock flag.
 *
 * Extracted from `ChatService` so the read/navigation, write/mutation and lore
 * logic can each live in their own service WITHOUT passing signals around or
 * creating dependency cycles — every one of those services injects this tiny
 * store:
 *
 *   ChatTreeStateService  (this file — ONLY the state, no behavior)
 *   └─ ChatTreeReaderService (pure reads/navigation)
 *   └─ ChatTreeWriterService (node + chat mutations, draft housekeeping, trash)
 *   └─ ChatLoreService       (lore materialization + one-shot exclusion)
 *
 * Deliberately dumb: it owns the signals and nothing else.
 */
@Injectable({ providedIn: 'root' })
export class ChatTreeStateService {
  readonly chats = signal<Chat[]>([]);
  readonly nodes = signal<ChatNode[]>([]);
  readonly currentChatId = signal<string | null>(null);
  /** Deleted branch roots (trash) of the currently selected chat. */
  readonly deletedNodes = signal<ChatNode[]>([]);
  /** parentId → currently active childId. */
  readonly activeChildMap = signal<Record<string, string>>({});

  /**
   * True while a multi-step writer (e.g. Elaborate) is sequentially chaining
   * new nodes. ensureDraftAtLeaf is skipped so it cannot re-point the active
   * path to a stray draft under an intermediate answer mid-sequence.
   */
  elaborating = false;
}
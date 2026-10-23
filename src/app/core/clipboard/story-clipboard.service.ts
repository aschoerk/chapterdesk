import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatService } from './chat.service';

export type StoryClipboardAction = 'copy' | 'cut';

const LS_KEY = 'chat.storyClipboard.v1';
const FORMAT = 'chapterdesk.storyClipboard';
const VERSION = 1;

/**
 * Client-side clipboard for whole stories (Chats) on the sidebar.
 *
 * Unlike the node clipboard, a **cut** here is NOT destructive: the stories
 * stay in their current environment and are only *staged* (visually marked).
 * They are actually moved (reassigned to the target environment) when the
 * user pastes them into another environment. If no paste happens — or the
 * staged cut is cancelled — the stories remain exactly where they were.
 * (i.e. "if paste does not happen, the story is not cut".)
 *
 * A **copy** creates clones on paste (originals stay untouched).
 *
 * The payload survives reloads / navigation via localStorage and never leaves
 * the browser.
 */
export interface StoryClipboardEntry {
  format: typeof FORMAT;
  version: typeof VERSION;
  action: StoryClipboardAction;
  chatIds: string[];
}

function isStoryClipboardEntry(v: unknown): v is StoryClipboardEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<StoryClipboardEntry>;
  return (
    e.format === FORMAT &&
    e.version === VERSION &&
    (e.action === 'copy' || e.action === 'cut') &&
    Array.isArray(e.chatIds) &&
    e.chatIds.every(id => typeof id === 'string')
  );
}

@Injectable({ providedIn: 'root' })
export class StoryClipboardService {
  private readonly chatService = inject(ChatService);

  /** The current story clipboard payload (null = empty). */
  readonly clipboard = signal<StoryClipboardEntry | null>(this.readFromStorage());

  readonly hasContent = computed(() => this.clipboard() !== null);
  readonly count = computed(() => this.clipboard()?.chatIds.length ?? 0);
  readonly action = computed(() => this.clipboard()?.action ?? null);

  private readFromStorage(): StoryClipboardEntry | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return isStoryClipboardEntry(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private save(entry: StoryClipboardEntry | null): void {
    if (entry) {
      this.clipboard.set(entry);
      localStorage.setItem(LS_KEY, JSON.stringify(entry));
    } else {
      this.clipboard.set(null);
      localStorage.removeItem(LS_KEY);
    }
  }

  /** Stage a copy: store the ids with action 'copy' (originals stay on paste). */
  copy(chatIds: string[]): void {
    const ids = [...new Set(chatIds)];
    if (!ids.length) return;
    this.save({ format: FORMAT, version: VERSION, action: 'copy', chatIds: ids });
  }

  /**
   * Stage a MOVE: store the ids with action 'cut' WITHOUT touching the chats.
   * The stories are only reassigned when the user pastes them into a target
   * environment — nothing is removed here.
   */
  cut(chatIds: string[]): void {
    const ids = [...new Set(chatIds)];
    if (!ids.length) return;
    this.save({ format: FORMAT, version: VERSION, action: 'cut', chatIds: ids });
  }

  /** True when the given chat is currently staged for a cut (pending move). */
  isCutChat(chatId: string): boolean {
    const entry = this.clipboard();
    return entry?.action === 'cut' && entry.chatIds.includes(chatId);
  }

  /** True when the given chat is currently on the clipboard (any action). */
  isStaged(chatId: string): boolean {
    return this.clipboard()?.chatIds.includes(chatId) ?? false;
  }

  clear(): void {
    this.save(null);
  }

  /**
   * Paste the clipboard into the target environment.
   *
   * - cut  → the staged stories are MOVED there (reassigned), then cleared.
   * - copy → clones are created in the target environment (originals stay).
   *
   * Returns true when there was content to paste.
   */
  async pasteInto(targetProjectId: string | null): Promise<boolean> {
    const entry = this.clipboard();
    if (!entry) return false;
    try {
      if (entry.action === 'cut') {
        for (const chatId of entry.chatIds) {
          const chat = this.chatService.chats().find(c => c.id === chatId);
          if (chat && chat.projectId !== targetProjectId) {
            await this.chatService.reassignChat(chatId, targetProjectId);
          }
        }
      } else {
        for (const chatId of entry.chatIds) {
          const clone = await this.chatService.cloneChat(chatId);
          if (clone.projectId !== targetProjectId) {
            await this.chatService.reassignChat(clone.id, targetProjectId);
          }
        }
      }
    } finally {
      this.clear();
    }
    return true;
  }
}
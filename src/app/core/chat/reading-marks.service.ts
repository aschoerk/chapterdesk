/**
 * Persistent reading marks for a chat.
 *
 * A mark is a POSITION (`start === end`) or a TEXT SELECTION inside a node's
 * markdown source, optionally carrying a NOTE (a notice about that spot). A
 * chat may hold ANY number of them; they are stored on the chat record
 * (`Chat.readingMarks`) so they survive reloads and follow the story across
 * browsers.
 *
 * Two consumers:
 *  - `ChatNodeComponent` — the right-click menu creates a mark at the cursor or
 *    for the marked text, and the node shows its marks as chips.
 *  - `ChatComponent` — the "Marks" panel lists every mark of the chat with
 *    jump-to / read-from-here / edit-note / delete.
 *
 * "Read from here" feeds `PacedReadService.setNextReadPosition`, so a mark is
 * how you keep MANY bookmarks and choose which one the next paced read uses.
 */
import { Injectable, computed, inject } from '@angular/core';
import { ChatNode, ReadingMark } from '../../models/chat';
import { ChatService } from './chat.service';
import { newId } from '../util/helpers';

export interface ReadingMarkInput {
  nodeId: string;
  /** 0-based start offset into the node's markdown source. */
  start: number;
  /** End offset; equal to `start` for a bare position mark. */
  end?: number;
  /** The selected source text ('' for a position). */
  quote?: string;
  /** The user's notice. */
  note?: string;
}

@Injectable({ providedIn: 'root' })
export class ReadingMarksService {
  private readonly chatService = inject(ChatService);

  private get chat() {
    const id = this.chatService.currentChatId();
    return this.chatService.chats().find(c => c.id === id) ?? null;
  }

  /** All marks of the open chat, in reading order (path order, then offset). */
  readonly marks = computed<ReadingMark[]>(() => {
    const list = [...(this.chat?.readingMarks ?? [])];
    const order = new Map<string, number>();
    this.chatService.getActivePath().forEach((n, i) => order.set(n.id, i));
    return list.sort((a, b) => {
      const oa = order.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER;
      const ob = order.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      if (a.start !== b.start) return a.start - b.start;
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    });
  });

  readonly count = computed(() => this.marks().length);

  /** Marks that belong to one node. */
  marksFor(nodeId: string): ReadingMark[] {
    return this.marks().filter(m => m.nodeId === nodeId);
  }

  countFor(nodeId: string): number {
    return (this.chat?.readingMarks ?? []).filter(m => m.nodeId === nodeId).length;
  }

  find(id: string): ReadingMark | null {
    return this.marks().find(m => m.id === id) ?? null;
  }

  /** True for a bare position (no selected text). */
  isPosition(mark: ReadingMark): boolean {
    return mark.end <= mark.start;
  }

  /** Text to show for a mark: the quote, else a short excerpt around the spot. */
  label(mark: ReadingMark, nodes: ChatNode[] = this.chatService.currentNodes()): string {
    if (mark.quote?.trim()) return mark.quote.trim();
    const node = nodes.find(n => n.id === mark.nodeId);
    const source = node?.content ?? '';
    if (!source) return '';
    const from = Math.max(0, Math.min(mark.start, source.length));
    const to = Math.min(source.length, Math.max(from + 60, (mark.end || from) + 60));
    return source.slice(from, to).replace(/\s+/g, ' ').trim();
  }

  /** Add a mark and persist it. Returns the created mark (null when no chat). */
  async add(input: ReadingMarkInput): Promise<ReadingMark | null> {
    const chat = this.chat;
    if (!chat) return null;
    const start = Math.max(0, Math.round(input.start || 0));
    const end = Math.max(start, Math.round(input.end ?? start));
    const mark: ReadingMark = {
      id: newId(),
      nodeId: input.nodeId,
      start,
      end,
      quote: (input.quote ?? '').slice(0, 2000),
      note: input.note ?? '',
      createdAt: new Date().toISOString(),
      updatedAt: null
    };
    await this.save([...(chat.readingMarks ?? []), mark]);
    return mark;
  }

  /** Replace a mark's notice. */
  async setNote(id: string, note: string): Promise<void> {
    await this.patch(id, { note });
  }

  /** Move a mark (used when the text it referred to shifted). */
  async setRange(id: string, start: number, end?: number): Promise<void> {
    const s = Math.max(0, Math.round(start || 0));
    await this.patch(id, { start: s, end: Math.max(s, Math.round(end ?? s)) });
  }

  async remove(id: string): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    await this.save((chat.readingMarks ?? []).filter(m => m.id !== id));
  }

  /** Delete every mark of one node. */
  async removeForNode(nodeId: string): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    const next = (chat.readingMarks ?? []).filter(m => m.nodeId !== nodeId);
    if (next.length === (chat.readingMarks ?? []).length) return;
    await this.save(next);
  }

  async clear(): Promise<void> {
    const chat = this.chat;
    if (!chat || !(chat.readingMarks?.length)) return;
    await this.save([]);
  }

  // ------------------------------------------------------------------ internals

  private async patch(id: string, changes: Partial<ReadingMark>): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    const next = (chat.readingMarks ?? []).map(m =>
      m.id === id ? { ...m, ...changes, updatedAt: new Date().toISOString() } : m
    );
    await this.save(next);
  }

  private async save(marks: ReadingMark[]): Promise<void> {
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    await this.chatService.patchChatMeta(chatId, { readingMarks: marks });
  }
}

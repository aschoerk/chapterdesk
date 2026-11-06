import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi } from '../../../../test-helpers/factories';
import { ChatService } from './chat.service';
import { ReadingMarksService } from './reading-marks.service';

/**
 * Persistent reading marks: any number of positions / text selections with
 * notices, stored on the chat record and shared with the paced read
 * ("read from this mark").
 */
describe('ReadingMarksService — persistent positions / selections + notices', () => {
  let api: InMemoryChatApi;
  let chat: ChatService;
  let marks: ReadingMarksService;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    TestBed.configureTestingModule({
      providers: [ChatService, ReadingMarksService, { provide: CHAT_API, useValue: api }]
    });
    chat = TestBed.inject(ChatService);
    marks = TestBed.inject(ReadingMarksService);

    seedApi(api, {
      chats: [{ id: 'chat-1', title: 'Story' }],
      nodes: [
        { id: 'q1', chatId: 'chat-1', parentId: null, role: 'user', content: 'Question' },
        { id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one' },
        { id: 'a2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter two' }
      ]
    });
    await chat.loadChats();
    await chat.selectChat('chat-1');
    chat.setActiveChild(null, 'q1');
    chat.setActiveChild('q1', 'a1');
  });

  it('adds an arbitrary number of marks and persists them on the chat', async () => {
    const first = await marks.add({ nodeId: 'a1', start: 4, end: 9, quote: 'pter ' });
    const second = await marks.add({ nodeId: 'a1', start: 0 });
    const third = await marks.add({ nodeId: 'a2', start: 3, note: 'start of ch.2' });

    expect(first && second && third).toBeTruthy();
    expect(marks.count()).toBe(3);
    expect(marks.marksFor('a1')).toHaveLength(2);
    expect(marks.marksFor('a2')).toHaveLength(1);

    // Persisted in the aggregate (survives a reload / other browser).
    const stored = (await api.getChats()).find(c => c.id === 'chat-1')!;
    expect(stored.readingMarks).toHaveLength(3);
    expect(stored.readingMarks?.[2].note).toBe('start of ch.2');
  });

  it('flags positions vs selections', async () => {
    const pos = await marks.add({ nodeId: 'a1', start: 5 });
    const sel = await marks.add({ nodeId: 'a1', start: 2, end: 6, quote: 'apte' });
    expect(marks.isPosition(pos!)).toBe(true);
    expect(marks.isPosition(sel!)).toBe(false);
  });

  it('keeps notes editable and marks removable', async () => {
    const mark = await marks.add({ nodeId: 'a1', start: 1 });
    await marks.setNote(mark!.id, 'remember this');
    expect(marks.find(mark!.id)?.note).toBe('remember this');

    const chatAfter = (await api.getChats()).find(c => c.id === 'chat-1')!;
    expect(chatAfter.readingMarks?.[0].note).toBe('remember this');

    await marks.remove(mark!.id);
    expect(marks.count()).toBe(0);
  });

  it('derives a label from the quote or the text around the position', async () => {
    const sel = await marks.add({ nodeId: 'a1', start: 0, end: 7, quote: 'Chapter' });
    expect(marks.label(sel!)).toBe('Chapter');

    const pos = await marks.add({ nodeId: 'a1', start: 8 });
    expect(marks.label(pos!)).toContain('one');
  });

  it('orders marks by active-path position, then offset', async () => {
    await marks.add({ nodeId: 'a2', start: 0 });
    await marks.add({ nodeId: 'a1', start: 9 });
    await marks.add({ nodeId: 'a1', start: 1 });
    expect(marks.marks().map(m => `${m.nodeId}:${m.start}`)).toEqual([
      'a1:1', 'a1:9', 'a2:0'
    ]);
  });

  it('clears every mark of the chat', async () => {
    await marks.add({ nodeId: 'a1', start: 0 });
    await marks.add({ nodeId: 'a2', start: 1 });
    await marks.clear();
    expect(marks.count()).toBe(0);
    expect((await api.getChats())[0].readingMarks).toEqual([]);
  });
});

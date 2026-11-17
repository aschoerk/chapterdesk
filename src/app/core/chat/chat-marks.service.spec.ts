import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat } from '../../../../test-helpers/factories';
import { SettingsService } from '../settings/settings.service';
import { I18nService } from '../i18n/i18n.service';
import { ChatService } from './chat.service';
import { ReadingMarksService } from './reading-marks.service';
import { MarkNoteDialogService } from '../dialogs/mark-note-dialog.service';
import { ConfirmService } from '../dialogs/confirm.service';
import { ToastService } from '../toast/toast.service';
import { ChatPacedReadService } from './chat-paced-read.service';
import { ChatNavMenuService } from './chat-nav-menu.service';
import { ChatMarksService, type ChatMarksHost } from './chat-marks.service';
import type { ChatNode, ReadingMark } from '../../models/chat';
import type { ChatNodeComponent } from '../../components/chat-node/chat-node.component';

const CHAT_ID = 'chat-1';

/**
 * The page HOST contract: in the app the chat page is the host. The spec
 * delegates the active-path / leaf lookups to the real ChatService (like the
 * page) and stubs the DOM-bound pieces (rendered node components, tree
 * scroller, marks-panel state).
 */
function hostStub(
  chatService: ChatService,
  overrides: Partial<ChatMarksHost> = {},
): ChatMarksHost {
  return {
    nodeComps: signal<readonly ChatNodeComponent[]>([]),
    visibleNodeId: signal<string | null>(null),
    getActivePath: () => chatService.getActivePath(),
    getCurrentLeaf: () => currentLeaf(chatService),
    showMarks: signal(false),
    ...overrides,
  };
}

/** Deepest node on the active branch (the page's `getCurrentLeaf` logic). */
function currentLeaf(chatService: ChatService): ChatNode | null {
  let current = chatService.getActiveChild(null);
  if (!current) return null;
  for (;;) {
    const next = chatService.getActiveChild(current.id);
    if (!next) break;
    current = next;
  }
  return current;
}

/** A fake rendered chat-node component (only what the service touches). */
function fakeNodeComp(nodeId: string, overrides: Partial<ChatNodeComponent> = {}): ChatNodeComponent {
  return {
    node: () => ({ id: nodeId }),
    revealMark: () => true,
    hasContentSelection: () => false,
    markPosition: vi.fn(),
    markSelection: vi.fn(),
    ...overrides,
  } as unknown as ChatNodeComponent;
}

/** A three-node visible chain q1 → a1 → a2 (a1 = active continuation). */
function story(): ReturnType<typeof makeNode>[] {
  return [
    makeNode({ id: 'q1', role: 'user', content: 'Question' }),
    makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true }),
    makeNode({ id: 'a2', parentId: 'a1', role: 'assistant', content: 'Answer two', isCurrent: true }),
  ];
}

describe('ChatMarksService', () => {
  let api: InMemoryChatApi;
  let service: ChatMarksService;
  let chatService: ChatService;
  let readingMarks: ReadingMarksService;

  async function open(nodes: ReturnType<typeof makeNode>[]): Promise<void> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [{ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' }],
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story' }));
    api.nodes = nodes.map(n => ({ ...n, chatId: CHAT_ID }));
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        ChatNavMenuService,
        ChatPacedReadService,
        ChatMarksService,
      ],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    readingMarks = TestBed.inject(ReadingMarksService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    service = TestBed.inject(ChatMarksService);
  }

  /** Activate the chain q1 → a1 → a2. */
  function activateStory(): void {
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
  }

  /** Add a mark on `nodeId` with the given notice. */
  async function addMark(nodeId: string, note: string): Promise<ReadingMark> {
    const mark = await readingMarks.add({ nodeId, start: 0, note });
    return mark!;
  }

  beforeEach(() => {
    localStorage.clear();
  });

  // ----------------------------------------------------------------------
  // Panel rows
  // ----------------------------------------------------------------------

  it('markPreview returns the quote when the mark has one', async () => {
    await open(story());
    activateStory();
    service.bind(hostStub(chatService));
    const mark = { id: 'm1', nodeId: 'a1', start: 0, end: 6, quote: 'Answer', note: '', createdAt: '' } as ReadingMark;

    expect(service.markPreview(mark)).toBe('Answer');
  });

  it('markNodeLabel renders "chapter 3"-ish role + index references', async () => {
    await open(story());
    activateStory();
    service.bind(hostStub(chatService));

    // a1 is the 2nd node on the active path (q1, a1, a2).
    const mark = { id: 'm1', nodeId: 'a1', start: 0, end: 0, quote: '', note: '', createdAt: '' } as ReadingMark;
    expect(service.markNodeLabel(mark)).toBe('chapter 2');
  });

  it('markNodeLabel reports an orphan when the node left the active path', async () => {
    await open(story());
    activateStory();
    service.bind(hostStub(chatService));

    const mark = { id: 'm1', nodeId: 'gone', start: 0, end: 0, quote: '', note: '', createdAt: '' } as ReadingMark;
    expect(service.markNodeLabel(mark)).toBe('section removed');
  });

  // ----------------------------------------------------------------------
  // Jump / read
  // ----------------------------------------------------------------------

  it('jumpToMark asks the section to reveal the exact spot', async () => {
    await open(story());
    activateStory();
    const reveal = vi.fn().mockReturnValue(true);
    const comp = fakeNodeComp('a1', { revealMark: reveal });
    const host = hostStub(chatService, { nodeComps: signal([comp]) });
    service.bind(host);
    const scrollSpy = vi.spyOn(service, 'scrollToNode').mockImplementation(() => {});

    const mark = { id: 'm1', nodeId: 'a1', start: 3, end: 9, quote: 'Answer', note: '', createdAt: '' } as ReadingMark;
    service.jumpToMark(mark);

    expect(reveal).toHaveBeenCalledWith(mark);
    expect(scrollSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('jumpToMark scrolls to the section when the mark text is gone', async () => {
    await open(story());
    activateStory();
    const reveal = vi.fn().mockReturnValue(false);
    const comp = fakeNodeComp('a1', { revealMark: reveal });
    const host = hostStub(chatService, { nodeComps: signal([comp]) });
    service.bind(host);
    const scrollSpy = vi.spyOn(service, 'scrollToNode').mockImplementation(() => {});

    const mark = { id: 'm1', nodeId: 'a1', start: 3, end: 9, quote: 'Answer', note: '', createdAt: '' } as ReadingMark;
    service.jumpToMark(mark);

    expect(reveal).toHaveBeenCalledWith(mark);
    expect(scrollSpy).toHaveBeenCalledWith('a1');
    vi.restoreAllMocks();
  });

  it('readFromMark delegates to the paced-read service', async () => {
    await open(story());
    activateStory();
    service.bind(hostStub(chatService));
    const pacedRead = TestBed.inject(ChatPacedReadService);
    const spy = vi.spyOn(pacedRead, 'readFromMark').mockImplementation(() => {});

    const mark = { id: 'm1', nodeId: 'a1', start: 2, end: 8, quote: 'Answer', note: '', createdAt: '' } as ReadingMark;
    service.readFromMark(mark);

    expect(spy).toHaveBeenCalledWith(mark);
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------------
  // Edit / delete / clear
  // ----------------------------------------------------------------------

  it('deleteMark removes the mark', async () => {
    await open(story());
    activateStory();
    service.bind(hostStub(chatService));
    const mark = await addMark('a1', 'note');

    await service.deleteMark(mark);

    expect(readingMarks.marks()).toHaveLength(0);
  });

  it('editMarkNote opens the modal and persists the note', async () => {
    await open(story());
    activateStory();
    service.bind(hostStub(chatService));
    const mark = await addMark('a1', 'old');

    const dialog = TestBed.inject(MarkNoteDialogService);
    vi.spyOn(dialog, 'open').mockResolvedValue('new note');

    await service.editMarkNote(mark);

    expect(readingMarks.marks()[0]?.note).toBe('new note');
    vi.restoreAllMocks();
  });

  it('editMarkNote keeps the old note when the modal is cancelled', async () => {
    await open(story());
    activateStory();
    service.bind(hostStub(chatService));
    const mark = await addMark('a1', 'keep me');

    const dialog = TestBed.inject(MarkNoteDialogService);
    vi.spyOn(dialog, 'open').mockResolvedValue(null);

    await service.editMarkNote(mark);

    expect(readingMarks.marks()[0]?.note).toBe('keep me');
    vi.restoreAllMocks();
  });

  it('clearMarks confirms, clears and closes the panel', async () => {
    await open(story());
    activateStory();
    const host = hostStub(chatService);
    service.bind(host);
    await addMark('a1', 'note');

    const confirm = TestBed.inject(ConfirmService);
    vi.spyOn(confirm, 'ask').mockResolvedValue(true);

    await service.clearMarks();

    expect(readingMarks.marks()).toHaveLength(0);
    expect(host.showMarks()).toBe(false);
    vi.restoreAllMocks();
  });

  it('clearMarks does nothing when the user cancels', async () => {
    await open(story());
    activateStory();
    const host = hostStub(chatService);
    service.bind(host);
    await addMark('a1', 'note');

    const confirm = TestBed.inject(ConfirmService);
    vi.spyOn(confirm, 'ask').mockResolvedValue(false);

    await service.clearMarks();

    expect(readingMarks.marks()).toHaveLength(1);
    expect(host.showMarks()).toBe(false);
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------------
  // markAtCursor (Ctrl+M)
  // ----------------------------------------------------------------------

  it('markAtCursor marks the position of the visible section', async () => {
    await open(story());
    activateStory();
    const markPosition = vi.fn();
    const comp = fakeNodeComp('a1', { markPosition });
    const host = hostStub(chatService, {
      visibleNodeId: signal('a1'),
      nodeComps: signal([comp]),
    });
    service.bind(host);

    service.markAtCursor();

    expect(markPosition).toHaveBeenCalled();
  });

  it('markAtCursor marks the selection when the section has one', async () => {
    await open(story());
    activateStory();
    const markSelection = vi.fn();
    const comp = fakeNodeComp('a1', {
      hasContentSelection: () => true,
      markSelection,
    });
    const host = hostStub(chatService, {
      visibleNodeId: signal('a1'),
      nodeComps: signal([comp]),
    });
    service.bind(host);

    service.markAtCursor();

    expect(markSelection).toHaveBeenCalled();
  });
});
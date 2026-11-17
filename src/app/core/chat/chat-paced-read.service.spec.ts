import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal, type Signal, type ElementRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat } from '../../../../test-helpers/factories';
import { SettingsService } from '../settings/settings.service';
import { I18nService } from '../i18n/i18n.service';
import { ChatService } from './chat.service';
import {
  PacedReadService,
  type PacedReadHost,
  type PacedReadResumePoint,
} from '../llm/paced-read.service';
import { ChatPacedReadService, type ChatPacedReadHost } from './chat-paced-read.service';

const CHAT_ID = 'chat-1';

/**
 * The page HOST contract: in the app the chat page is the host. The spec
 * delegates the active-path lookup to the real ChatService (like the page) and
 * stubs the DOM-bound pieces (tree scroller + visible-node setters).
 */
function hostStub(
  chatService: ChatService,
  overrides: Partial<ChatPacedReadHost> = {},
): ChatPacedReadHost {
  return {
    tree: signal<ElementRef<HTMLElement> | undefined>(undefined),
    getActivePath: () => chatService.getActivePath(),
    visibleNodeId: signal<string | null>(null),
    visibleNodeIds: signal<string[]>([]),
    ...overrides,
  };
}

/** A three-node visible chain q1 → a1 → a2 (a1 = active continuation). */
function story(): ReturnType<typeof makeNode>[] {
  return [
    makeNode({ id: 'q1', role: 'user', content: 'Question' }),
    makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true }),
    makeNode({ id: 'a2', parentId: 'a1', role: 'assistant', content: 'Answer two', isCurrent: true }),
  ];
}

describe('ChatPacedReadService', () => {
  let api: InMemoryChatApi;
  let service: ChatPacedReadService;
  let pacedRead: PacedReadService;
  let chatService: ChatService;

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
        ChatPacedReadService,
      ],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    pacedRead = TestBed.inject(PacedReadService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    service = TestBed.inject(ChatPacedReadService);
  }

  beforeEach(() => {
    localStorage.clear();
  });

  it('starts a read from the first assistant chapter of the active path', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    service.startPacedReadFromView();

    expect(pacedRead.active()).toBe(true);
    expect(pacedRead.currentKey()).toBe('a1');
    expect(pacedRead.total()).toBe(2); // a1 + a2
    pacedRead.stop();
  });

  it('stops an active read when Ctrl+R is pressed again', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));
    void pacedRead.start([{ key: 'a1', text: 'Answer one' }]);
    expect(pacedRead.active()).toBe(true);

    service.startPacedReadFromView();

    expect(pacedRead.active()).toBe(false);
  });

  it('honours a pending read position over the visible node', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService, { visibleNodeId: signal('a1') }));
    pacedRead.setNextReadPosition('a2', 0);

    service.startPacedReadFromView();

    expect(pacedRead.currentKey()).toBe('a2');
    pacedRead.stop();
  });

  it('readFromMark relocates a paused read instead of stopping it', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));
    void pacedRead.start([{ key: 'a1', text: 'Answer one' }]);
    pacedRead.pause();
    expect(pacedRead.paused()).toBe(true);

    service.readFromMark({
      id: 'm1', nodeId: 'a2', start: 2, end: 8, quote: 'Answer', note: '', createdAt: '',
    } as any);

    expect(pacedRead.active()).toBe(true);
    expect(pacedRead.paused()).toBe(true);
    expect(pacedRead.currentKey()).toBe('a2');
    pacedRead.stop();
  });

  it('readFromMark defers the start position and begins a fresh read when idle', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    service.readFromMark({
      id: 'm1', nodeId: 'a2', start: 4, end: 10, quote: 'Answer', note: '', createdAt: '',
    } as any);

    expect(pacedRead.active()).toBe(true);
    expect(pacedRead.currentKey()).toBe('a2');
    // The pending position was consumed — the read began at that chapter.
    expect(pacedRead.pendingStart()).toBeNull();
    pacedRead.stop();
  });

  it('registers a resume host that captures the reading position and restores it', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');

    const tree = document.createElement('div');
    let capturedScrollTop = 0;
    Object.defineProperty(tree, 'scrollTop', {
      get: () => capturedScrollTop,
      set: (v: number) => { capturedScrollTop = v; },
      configurable: true,
    });
    const host = hostStub(chatService, {
      tree: signal({ nativeElement: tree }),
    });
    service.bind(host);

    // Grab the adapter the service hands to PacedReadService.
    let registered: PacedReadHost | null = null;
    vi.spyOn(pacedRead, 'registerHost').mockImplementation((h) => { registered = h; });
    service.registerHost();
    expect(registered).not.toBeNull();

    // capture — the chat, the current chapter and the tree scroll offset.
    void pacedRead.start([{ key: 'a1', text: 'Answer one' }]);
    tree.scrollTop = 123;
    const point = registered!.capture();
    expect(point).toMatchObject({ view: 'chat', chatId: CHAT_ID, nodeId: 'a1', scrollTop: 123 });

    // restore — a rendered node is scrolled to the top of the scroller and the
    // visible-node / positioned-chat signals are set.
    const nodeEl = document.createElement('div');
    nodeEl.setAttribute('data-node-id', 'a1');
    tree.appendChild(nodeEl);
    vi.spyOn(tree, 'querySelector').mockImplementation((sel: string) =>
      sel === '[data-node-id="a1"]' ? nodeEl : null);
    vi.spyOn(nodeEl, 'getBoundingClientRect').mockReturnValue({
      top: 100, bottom: 200, left: 0, right: 300, width: 300, height: 100, x: 0, y: 100, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(tree, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    registered!.restore({ view: 'chat', chatId: CHAT_ID, nodeId: 'a1', scrollTop: 0 } as PacedReadResumePoint);

    // delta = nodeEl.top(100) - tree.top(0) = 100 → scrollTop = max(0, 123 + 100 - 8).
    expect(capturedScrollTop).toBe(215);
    // The restored position is recorded on the service (positioned chat) and
    // written into the page's visible-node signals.
    expect(host.visibleNodeId()).toBe('a1');
    expect(host.visibleNodeIds()).toEqual(['a1']);
    expect(service.isPositionedFor(CHAT_ID)).toBe(true);
    pacedRead.stop();
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------------
  // onKey — the pacing keyboard handling (Ctrl+R + the reveal arrows)
  // ----------------------------------------------------------------------

  it('onKey starts the read with Ctrl+R and returns true (consumed)', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    const prevent = vi.fn();
    const handled = service.onKey({ key: 'r', ctrlKey: true, preventDefault: prevent } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(prevent).toHaveBeenCalled(); // Ctrl+R must not reload the window.
    expect(pacedRead.active()).toBe(true);
    expect(pacedRead.currentKey()).toBe('a1');
    pacedRead.stop();
  });

  it('onKey stops an active read when Ctrl+R is pressed again', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));
    void pacedRead.start([{ key: 'a1', text: 'Answer one' }]);
    expect(pacedRead.active()).toBe(true);

    const handled = service.onKey({ key: 'R', ctrlKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(pacedRead.active()).toBe(false);
  });

  it('onKey handles the pacing arrows + Space/P + Escape only while a read runs', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    // Idle: the pacing keys are NOT consumed.
    const idle = service.onKey({ key: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(idle).toBe(false);

    void pacedRead.start([{ key: 'a1', text: 'Answer one' }]);

    const skip = vi.spyOn(pacedRead, 'skipSeconds');
    const handled = service.onKey({ key: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(handled).toBe(true);
    expect(skip).toHaveBeenCalledWith(1);

    // Space = interrupt/resume.
    const toggle = vi.spyOn(pacedRead, 'toggle');
    expect(service.onKey({ key: ' ', preventDefault: vi.fn() } as unknown as KeyboardEvent)).toBe(true);
    expect(toggle).toHaveBeenCalled();

    // Escape = stop.
    service.onKey({ key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(pacedRead.active()).toBe(false);
    vi.restoreAllMocks();
  });

  it('onKey returns false for unrelated keys', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    expect(service.onKey({ key: 'b', preventDefault: vi.fn() } as unknown as KeyboardEvent)).toBe(false);
    expect(service.onKey({ key: 'ArrowDown', ctrlKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent)).toBe(false);
  });
});

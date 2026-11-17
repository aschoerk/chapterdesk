import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal, type Signal, type ElementRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat } from '../../../../test-helpers/factories';
import { SettingsService } from '../settings/settings.service';
import { I18nService } from '../i18n/i18n.service';
import { ToastService } from '../toast/toast.service';
import { ChatService } from './chat.service';
import { NodeEditSession } from './node-edit-session';
import { SearchReplaceService } from '../search-replace/search-replace.service';
import { NameReplaceDialogService } from '../dialogs/name-replace-dialog.service';
import { NameListDialogService } from '../dialogs/name-list-dialog.service';
import { ChatSearchService, type ChatSearchHost } from './chat-search.service';
import type { ChatNode } from '../../models/chat';
import type { ChatNodeComponent } from '../../components/chat-node/chat-node.component';

const CHAT_ID = 'chat-1';

/**
 * The page HOST contract: in the app the chat page is the host. The spec
 * delegates the tree/chat lookups to the real ChatService (like the page) and
 * stubs the DOM-bound pieces so the service can be exercised without the page.
 */
function hostStub(
  chatService: ChatService,
  overrides: Partial<ChatSearchHost> = {},
): ChatSearchHost {
  return {
    tree: signal<ElementRef<HTMLElement> | undefined>(undefined),
    nodeComps: signal<readonly ChatNodeComponent[]>([]),
    getActivePath: () => chatService.getActivePath(),
    getCurrentLeaf: () => currentLeaf(chatService),
    visibleNodeId: signal<string | null>(null),
    chats: chatService.chats,
    measureSearchCaret: () => null,
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
function fakeNodeComp(nodeId: string): ChatNodeComponent {
  return {
    node: () => ({ id: nodeId }),
    setDraftFromSearch: vi.fn(),
  } as unknown as ChatNodeComponent;
}

describe('ChatSearchService', () => {
  let api: InMemoryChatApi;
  let service: ChatSearchService;
  let search: SearchReplaceService;
  let chatService: ChatService;
  let editSession: NodeEditSession;
  let toast: ToastService;

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
        ChatSearchService,
      ],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    editSession = TestBed.inject(NodeEditSession);
    search = TestBed.inject(SearchReplaceService);
    toast = TestBed.inject(ToastService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    service = TestBed.inject(ChatSearchService);
  }

  /** A three-node visible chain q1 → a1 → a2 (a1 = active continuation). */
  function story(): ReturnType<typeof makeNode>[] {
    return [
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true }),
      makeNode({ id: 'a2', parentId: 'a1', role: 'assistant', content: 'Answer two', isCurrent: true }),
    ];
  }

  beforeEach(() => {
    localStorage.clear();
  });

  // ----------------------------------------------------------------------
  // Session lifecycle (register / unregister)
  // ----------------------------------------------------------------------

  it('registers the chat search session with the shared dialog', async () => {
    await open(story());
    expect(search.scopes()).toEqual([]);
    service.register();
    expect(search.scopes().map(s => s.id)).toEqual(['node', 'chat']);
    service.unregister();
    expect(search.scopes()).toEqual([]);
  });

  it('computes occurrences across the active path in the chat scope', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));
    service.register();

    search.setScope('chat');
    search.setTerm('Answer');
    // Both assistant chapters contain "Answer".
    expect(search.total()).toBe(2);
    expect(search.occurrences().map(o => o.unit.key)).toEqual(['a1', 'a2']);
  });

  // ----------------------------------------------------------------------
  // searchUnits — node scope
  // ----------------------------------------------------------------------

  it('node scope falls back to the current leaf when nothing is edited/visible', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    const leaf = currentLeaf(chatService)!;
    expect(service.searchUnits('node')).toEqual([
      { key: leaf.id, text: leaf.content ?? '', role: leaf.role },
    ]);
  });

  it('node scope searches the LIVE draft of the node being edited, not the committed content', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    await editSession.begin({ chatId: CHAT_ID, nodeId: a1.id, text: a1.content ?? '', attachments: [] });
    editSession.patch(a1.id, 'X' + (a1.content ?? ''), []);

    expect(service.searchUnits('node')).toEqual([
      { key: a1.id, text: 'X' + (a1.content ?? ''), role: a1.role },
    ]);
  });

  it('node scope uses the visible node when the leaf is not the edited node', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService, { visibleNodeId: signal('q1') }));

    expect(service.searchUnits('node')).toEqual([
      { key: 'q1', text: 'Question', role: 'user' },
    ]);
  });

  // ----------------------------------------------------------------------
  // searchUnits — chat scope
  // ----------------------------------------------------------------------

  it('chat scope returns every active-path node with the live draft for the edited one', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));

    const a2 = chatService.nodes().find(n => n.id === 'a2')!;
    await editSession.begin({ chatId: CHAT_ID, nodeId: a2.id, text: a2.content ?? '', attachments: [] });
    editSession.patch(a2.id, 'EDITED ' + (a2.content ?? ''), []);

    expect(service.searchUnits('chat')).toEqual([
      { key: 'q1', text: 'Question', role: 'user' },
      { key: 'a1', text: 'Answer one', role: 'assistant' },
      { key: 'a2', text: 'EDITED Answer two', role: 'assistant' },
    ]);
  });

  // ----------------------------------------------------------------------
  // Reveal in the editor (host measureSearchCaret + tree scroll)
  // ----------------------------------------------------------------------

  it('reveals a match by scrolling the textarea AND the conversation tree', async () => {
    await open(story());
    const ta = document.createElement('textarea');
    ta.className = 'editor-textarea';
    ta.value = 'x'.repeat(2000);
    const tree = document.createElement('div');

    // jsdom clamps real scrollTop, so capture it via an intercepting property.
    let capturedScrollTop = 0;
    Object.defineProperty(tree, 'scrollTop', {
      get: () => capturedScrollTop,
      set: (v: number) => { capturedScrollTop = v; },
      configurable: true,
    });
    vi.spyOn(tree, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue({
      top: 500, bottom: 760, left: 0, right: 300, width: 300, height: 260, x: 0, y: 500, toJSON: () => ({}),
    } as DOMRect);

    service.bind(hostStub(chatService, {
      tree: signal({ nativeElement: tree }),
      measureSearchCaret: () => ({ contentTop: 500, paddingTop: 12, lineHeight: 16 }),
    }));

    service.revealSearchMatchInEditor(ta, 123);

    expect(ta.scrollTop).toBe(500 - 16);
    // caretY = 500 + 12 + (500 - 484) = 528 → tree scrolls 528 - 360 = 168.
    expect(capturedScrollTop).toBe(168);
  });

  // ----------------------------------------------------------------------
  // Name dialogs
  // ----------------------------------------------------------------------

  it('openSearch opens the shared dialog', async () => {
    await open(story());
    service.register();
    expect(search.open()).toBe(false);
    service.openSearch();
    expect(search.open()).toBe(true);
  });

  it('openNameReplace passes the chat units + handled names and persists through apply/saveHandled', async () => {
    await open(story());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    service.bind(hostStub(chatService));
    await chatService.patchChatMeta(CHAT_ID, { handledNames: ['Liz'] });

    const nameReplace = TestBed.inject(NameReplaceDialogService);
    const openSpy = vi.spyOn(nameReplace, 'open').mockResolvedValue([]);
    const infoSpy = vi.spyOn(toast, 'info');
    const successSpy = vi.spyOn(toast, 'success');

    await service.openNameReplace();

    expect(infoSpy).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledTimes(1);
    const state = openSpy.mock.calls[0][0] as any;
    expect(state.units.map((u: any) => u.key)).toEqual(['q1', 'a1', 'a2']);
    expect(state.handled).toEqual(['Liz']);

    // The dialog's apply persists through the chat API and pushes the new
    // text into the open editor's node component.
    const comp = fakeNodeComp('a1');
    service.bind(hostStub(chatService, { nodeComps: signal([comp as ChatNodeComponent]) }));
    await state.apply([{ key: 'a1', text: 'Answer one (replaced)' }]);
    expect(chatService.nodes().find(n => n.id === 'a1')?.content).toBe('Answer one (replaced)');
    expect((comp.setDraftFromSearch as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('Answer one (replaced)');

    // saveHandled persists the updated handled list on the chat record.
    await state.saveHandled(['Liz', 'Rivers']);
    expect(chatService.chats().find(c => c.id === CHAT_ID)?.handledNames).toEqual(['Liz', 'Rivers']);

    expect(successSpy).not.toHaveBeenCalled(); // nothing approved
    vi.restoreAllMocks();
  });

  it('openNameReplace toasts when there is no searchable text in chat scope', async () => {
    await open([]);
    service.bind(hostStub(chatService));
    const infoSpy = vi.spyOn(toast, 'info');
    const nameReplace = TestBed.inject(NameReplaceDialogService);
    const openSpy = vi.spyOn(nameReplace, 'open').mockResolvedValue(null);

    await service.openNameReplace();

    expect(infoSpy).toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('openNameList opens the dialog and toasts when the dictionary changed', async () => {
    await open(story());
    const nameList = TestBed.inject(NameListDialogService);
    const openSpy = vi.spyOn(nameList, 'open').mockResolvedValue(true);
    const successSpy = vi.spyOn(toast, 'success');

    await service.openNameList();

    expect(openSpy).toHaveBeenCalledWith({});
    expect(successSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

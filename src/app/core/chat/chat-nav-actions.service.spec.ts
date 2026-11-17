import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat } from '../../../../test-helpers/factories';
import { SettingsService } from '../settings/settings.service';
import { I18nService } from '../i18n/i18n.service';
import { ChatService } from './chat.service';
import { NodeClipboardService } from '../clipboard/node-clipboard.service';
import { ConfirmService } from '../dialogs/confirm.service';
import { ChatNavSelectionService } from './chat-nav-selection.service';
import { ChatNavMenuService, type ChatNavMenuHost } from './chat-nav-menu.service';
import { ChatNavActionsService } from './chat-nav-actions.service';

const CHAT_ID = 'chat-1';

/**
 * The navbar OPERATIONS service is fully self-contained (no page host): it
 * works against the real ChatService / ChatNavSelectionService / ChatNavMenuService
 * with the in-memory API, exactly like the page does. The component is a thin
 * delegate, so these specs cover the real behaviour.
 */
describe('ChatNavActionsService', () => {
  let api: InMemoryChatApi;
  let service: ChatNavActionsService;
  let chatService: ChatService;
  let navSelection: ChatNavSelectionService;
  let navMenu: ChatNavMenuService;
  let clipboard: NodeClipboardService;

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
        ChatNavActionsService,
      ],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    navSelection = TestBed.inject(ChatNavSelectionService);
    navMenu = TestBed.inject(ChatNavMenuService);
    clipboard = TestBed.inject(NodeClipboardService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    service = TestBed.inject(ChatNavActionsService);
  }

  /** A three-node visible chain q1 → a1 → a2 (a1 = active continuation). */
  function story(): ReturnType<typeof makeNode>[] {
    return [
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true }),
      makeNode({ id: 'a2', parentId: 'a1', role: 'assistant', content: 'Answer two', isCurrent: true }),
    ];
  }

  /** A fork: q1 has two assistant siblings a1 (active) and a2. */
  function forkStory(): ReturnType<typeof makeNode>[] {
    return [
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true }),
      makeNode({ id: 'a2', parentId: 'q1', role: 'assistant', content: 'Answer two', isCurrent: true }),
    ];
  }

  /** Activate the chain q1 → a1 → a2. */
  function activateStory(): void {
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
  }

  /** Activate the fork q1 → a1. */
  function activateFork(): void {
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
  }

  /**
   * The menu service needs a bound host for its paste geometry (in the app the
   * nav-bar binds itself). Bind a minimal host that reports the active path.
   */
  function bindNavMenuHost(): void {
    const host: ChatNavMenuHost = {
      navPath: () => chatService.getActivePath(),
      navSelectedIds: () => navSelection.selectedIds(),
      navHasSelection: () => navSelection.hasSelection(),
      toggleNavSelection: (id) => navSelection.toggle(id, chatService.getActivePath(), () => false),
      clearNavSelection: () => navSelection.clear(),
      startBranchAt: () => undefined,
      switchNavSibling: () => undefined,
      copyNavNodes: () => undefined,
      cutNavNodes: () => undefined,
      deleteNavNodes: () => undefined,
      pasteNavSelectionBefore: () => undefined,
      pasteNavSelectionAfter: () => undefined,
      pasteChainInto: () => undefined,
    };
    navMenu.bind(host);
  }

  /** Confirm dialogs resolve immediately (no user interaction in specs). */
  function mockConfirm(ok = true): void {
    vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(ok);
  }

  /** Let fire-and-forget async operations (cut/delete via onKey) settle. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }

  beforeEach(() => {
    localStorage.clear();
  });

  // ----------------------------------------------------------------------
  // Selection clipboard
  // ----------------------------------------------------------------------

  it('copyNavSelection copies the selected chain to the node clipboard', async () => {
    await open(story());
    activateStory();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    service.copyNavSelection();

    expect(clipboard.hasContent()).toBe(true);
  });

  it('cutNavSelection cuts the selected chain and clears the selection', async () => {
    await open(story());
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    await service.cutNavSelection();

    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
    expect(navSelection.selectedIds()).toEqual([]);
  });

  it('deleteNavSelection deletes the selected chain keeping children', async () => {
    await open(story());
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    await service.deleteNavSelection();

    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
    expect(navSelection.selectedIds()).toEqual([]);
  });

  it('extractNavSelection creates a new chat with the selected chain and opens it', async () => {
    await open(story());
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    const before = chatService.chats().length;
    await service.extractNavSelection();

    expect(chatService.chats().length).toBe(before + 1);
    const newChat = chatService.chats().find(c => c.id !== CHAT_ID)!;
    expect(newChat).toBeDefined();
    expect(chatService.currentChatId()).toBe(newChat.id);
  });

  // ----------------------------------------------------------------------
  // Paste
  // ----------------------------------------------------------------------

  it('pasteNavSelectionAfter splices the clipboard chain into the active path', async () => {
    await open(story());
    activateStory();
    bindNavMenuHost();
    // Copy q1 → a1 → a2 into the clipboard.
    navSelection.toggle('q1', chatService.getActivePath(), () => false);
    navSelection.toggle('a2', chatService.getActivePath(), () => false);
    service.copyNavSelection();

    // Paste after a1 — the chain is inserted between a1 and a2.
    await service.pasteNavSelectionAfter('a1');

    const nodes = chatService.nodes();
    expect(nodes.some(n => n.id === 'q1')).toBe(true);
    expect(nodes.some(n => n.id === 'a1')).toBe(true);
    expect(nodes.some(n => n.id === 'a2')).toBe(true);
  });

  it('canPasteAfter is false when the clipboard is empty', async () => {
    await open(story());
    activateStory();
    bindNavMenuHost();
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    expect(service.canPasteAfter(a1)).toBe(false);
  });

  it('appendNavSelectionAfter appends the clipboard as a parallel branch', async () => {
    await open(story());
    activateStory();
    bindNavMenuHost();
    // Copy a two-node chain q1 → a1 into the clipboard.
    navSelection.toggle('q1', chatService.getActivePath(), () => false);
    navSelection.toggle('a1', chatService.getActivePath(), () => false);
    service.copyNavSelection();

    await service.appendNavSelectionAfter('a1');

    // The chain root hangs under the LEFT node (a1) as a sibling of the
    // right node (a2) — both children of a1 now.
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    expect(chatService.getChildren(a1.id).length).toBeGreaterThan(1);
  });

  it('pasteChainInto routes insert vs append through the same splice', async () => {
    await open(story());
    activateStory();
    bindNavMenuHost();
    navSelection.toggle('q1', chatService.getActivePath(), () => false);
    service.copyNavSelection();

    await service.pasteChainInto('insert', 'q1', 'a1');

    expect(chatService.nodes().length).toBeGreaterThan(3);
  });

  // ----------------------------------------------------------------------
  // Branch ops
  // ----------------------------------------------------------------------

  it('switchNavSibling switches the active continuation to the next/prev sibling', async () => {
    await open(forkStory());
    activateFork();
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;

    // a1 and a2 are siblings under q1 — switch to the other.
    service.switchNavSibling(a1, 1);

    expect(chatService.getActiveChildId('q1')).toBe('a2');
  });

  it('startBranchAt materializes an empty direction leaf in parallel', async () => {
    await open(story());
    activateStory();
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;

    await service.startBranchAt(a1);

    const siblings = chatService.getChildren('q1');
    const leaf = siblings.find(s => s.role === 'user' && s.content === '');
    expect(leaf).toBeTruthy();
    // The active path now picks up the new leaf.
    expect(chatService.getActiveChildId('q1')).toBe(leaf!.id);
  });

  // ----------------------------------------------------------------------
  // Node-menu variants
  // ----------------------------------------------------------------------

  it('copyNavNodes copies a single node when it is not part of a selection', async () => {
    await open(story());
    activateStory();
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;

    service.copyNavNodes(a1);

    expect(clipboard.hasContent()).toBe(true);
  });

  it('cutNavNodes cuts the whole selection when the node is part of one', async () => {
    await open(story());
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;

    await service.cutNavNodes(a1);

    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
    expect(navSelection.selectedIds()).toEqual([]);
  });

  it('deleteNavNodes deletes a single node keeping children', async () => {
    await open(story());
    activateStory();
    mockConfirm();
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;

    await service.deleteNavNodes(a1);

    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
  });

  // ----------------------------------------------------------------------
  // Keyboard dispatch
  // ----------------------------------------------------------------------

  it('onKey copies the selection with Ctrl+C', async () => {
    await open(story());
    activateStory();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    const prevent = vi.fn();
    const handled = service.onKey({ key: 'c', ctrlKey: true, preventDefault: prevent } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(prevent).toHaveBeenCalled();
    expect(clipboard.hasContent()).toBe(true);
  });

  it('onKey cuts the selection with Ctrl+X', async () => {
    await open(story());
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    const handled = service.onKey({ key: 'x', ctrlKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    await flushMicrotasks();

    expect(handled).toBe(true);
    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
  });

  it('onKey deletes the selection with Delete', async () => {
    await open(story());
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    const handled = service.onKey({ key: 'Delete', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    await flushMicrotasks();

    expect(handled).toBe(true);
    expect(chatService.deletedNodes().some(n => n.id === 'a1')).toBe(true);
  });

  it('onKey copies the hovered node when nothing is selected', async () => {
    await open(story());
    activateStory();
    // Hover a1 without selecting it.
    navSelection['clipboardTargetId'].set('a1');

    const handled = service.onKey({ key: 'c', ctrlKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(clipboard.hasContent()).toBe(true);
  });

  it('onKey pastes behind the hovered node with Ctrl+V', async () => {
    await open(story());
    activateStory();
    bindNavMenuHost();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);
    service.copyNavSelection();
    navSelection['clipboardTargetId'].set('a1');

    const handled = service.onKey({ key: 'v', ctrlKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
  });

  it('onKey returns false for unrelated keys', async () => {
    await open(story());
    activateStory();

    expect(service.onKey({ key: 'b', preventDefault: vi.fn() } as unknown as KeyboardEvent)).toBe(false);
    expect(service.onKey({ key: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent)).toBe(false);
  });
});
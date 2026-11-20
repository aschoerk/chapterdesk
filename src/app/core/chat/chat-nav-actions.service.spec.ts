import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat, makeProject, makeTopic } from '../../../../test-helpers/factories';
import { SettingsService } from '../settings/settings.service';
import { ProjectService } from '../settings/project.service';
import { TopicSelectionService } from '../settings/topic-selection.service';
import { I18nService } from '../i18n/i18n.service';
import { ChatService } from './chat.service';
import { NodeClipboardService } from '../clipboard/node-clipboard.service';
import { isChatLoreNode } from './chat-lore.service';
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

  async function open(
    nodes: ReturnType<typeof makeNode>[],
    environment: { project?: Partial<ReturnType<typeof makeProject>>; topics?: Partial<ReturnType<typeof makeTopic>>[] } = {},
  ): Promise<void> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    seedApi(api, {
      projects: environment.project ? [environment.project] : [],
      topics: environment.topics ?? [],
      providers: [{ id: 'prov-1' }],
      models: [{ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' }],
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', projectId: environment.project?.id ?? null }));
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
    await TestBed.inject(ProjectService).loadProjects();
    await TestBed.inject(ProjectService).loadTopics();
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

  /** Active-path ids without the auto-created trailing composer leaf. */
  function pathIds(): string[] {
    return chatService
      .getActivePath()
      .filter(n => !chatService.isDraftQuestion(n))
      .map(n => n.id);
  }

  /** The navbar's visibility rule (ChatNavBarComponent.isNavVisible). */
  function navVisibleIds(): string[] {
    return chatService.getActivePath()
      .filter(n => !chatService.isDraftQuestion(n))
      .filter(n => isChatLoreNode(n)
        || !n.excludeFromContext
        || chatService.getChildren(n.parentId ?? null).length > 1)
      .map(n => n.id);
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

  // --- off-path branches (nodes NOT on the active path) -----------------
  //
  //   q1 → p → { c1 (active continuation), c2 (off-path sibling) }
  //
  // `c2` exists in the tree but is NOT on the active path, so the navbar never
  // renders it. Cutting/deleting a node above it must not lose it.

  /** q1 → p → { c1 (active), c2 (off-path). } */
  function offPathStory(): ReturnType<typeof makeNode>[] {
    return [
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'p', parentId: 'q1', role: 'assistant', content: 'Parent', isCurrent: true }),
      makeNode({ id: 'c1', parentId: 'p', role: 'user', content: 'C1', isCurrent: true, position: 1 }),
      makeNode({ id: 'c2', parentId: 'p', role: 'assistant', content: 'C2 (off path)', isCurrent: true, position: 2 }),
    ];
  }

  /** Activate q1 → p → c1, leaving c2 off the active path. */
  function activateOffPathStory(): void {
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'p');
    chatService.setActiveChild('p', 'c1');
    // The chat selection auto-creates the empty composer leaf — not part of the chain.
    expect(pathIds()).toEqual(['q1', 'p', 'c1']);
    expect(chatService.getSiblingsOf(chatService.nodes().find(n => n.id === 'c1')!).map(n => n.id))
      .toEqual(['c1', 'c2']);
  }

  it('cutNavSelection of a parent re-hangs BOTH children — including the off-path one', async () => {
    await open(offPathStory());
    activateOffPathStory();
    mockConfirm();
    navSelection.toggle('p', chatService.getActivePath(), () => false);

    await service.cutNavSelection();

    expect(chatService.deletedNodes().some(n => n.id === 'p')).toBe(true);
    // The off-path branch is not part of the selection → it stays, re-hung.
    expect(chatService.nodes().some(n => n.id === 'c2')).toBe(true);
    expect(chatService.nodes().find(n => n.id === 'c2')?.parentId).toBe('q1');
    expect(chatService.nodes().find(n => n.id === 'c1')?.parentId).toBe('q1');
  });

  it('deleteNavSelection of a parent re-hangs BOTH children — including the off-path one', async () => {
    await open(offPathStory());
    activateOffPathStory();
    navSelection.toggle('p', chatService.getActivePath(), () => false);

    await service.deleteNavSelection();

    expect(chatService.deletedNodes().some(n => n.id === 'p')).toBe(true);
    expect(chatService.nodes().some(n => n.id === 'c2')).toBe(true);
    expect(chatService.nodes().find(n => n.id === 'c2')?.parentId).toBe('q1');
  });

  it('cutNavNodes on an off-path node cuts only that node (the active chain stays)', async () => {
    await open(offPathStory());
    activateOffPathStory();
    mockConfirm();
    const c2 = chatService.nodes().find(n => n.id === 'c2')!;

    await service.cutNavNodes(c2);

    expect(chatService.deletedNodes().some(n => n.id === 'c2')).toBe(true);
    expect(chatService.nodes().some(n => n.id === 'p')).toBe(true);
    expect(chatService.nodes().find(n => n.id === 'c1')?.parentId).toBe('p');
  });

  // --- cutting a GRANDPARENT above an off-path branch --------------------
  //
  //   q1 → g → p → { h1 (active), h2 (off-path) }
  //
  // `g` is a visible pill, so it can be selected and cut from the navbar. The
  // whole branch below it must survive — including the off-path child.

  /** q1 → g → p → { h1 (active), h2 (off-path). } */
  function grandparentStory(): ReturnType<typeof makeNode>[] {
    return [
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'g', parentId: 'q1', role: 'assistant', content: 'Grandparent' }),
      makeNode({ id: 'p', parentId: 'g', role: 'user', content: 'Parent' }),
      makeNode({ id: 'h1', parentId: 'p', role: 'assistant', content: 'H1', isCurrent: true, position: 1 }),
      makeNode({ id: 'h2', parentId: 'p', role: 'assistant', content: 'H2 (off path)', isCurrent: true, position: 2 }),
    ];
  }

  /** Activate q1 → g → p → h1, leaving h2 off the active path. */
  function activateGrandparentStory(): void {
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'g');
    chatService.setActiveChild('g', 'p');
    chatService.setActiveChild('p', 'h1');
    // The chat selection auto-creates the empty composer leaf — not part of the chain.
    expect(pathIds()).toEqual(['q1', 'g', 'p', 'h1']);
  }

  it('cutNavSelection of a grandparent promotes the parent and keeps its off-path child', async () => {
    await open(grandparentStory());
    activateGrandparentStory();
    mockConfirm();
    navSelection.toggle('g', chatService.getActivePath(), () => false);

    await service.cutNavSelection();

    expect(chatService.deletedNodes().some(n => n.id === 'g')).toBe(true);
    // The parent takes g's place in the chain…
    expect(chatService.nodes().find(n => n.id === 'p')?.parentId).toBe('q1');
    // …and keeps BOTH children, the off-path one included.
    expect(chatService.getChildren('p').map(n => n.id)).toEqual(['h1', 'h2']);
  });

  it('deleteNavNodes of a grandparent promotes the parent and keeps its off-path child', async () => {
    await open(grandparentStory());
    activateGrandparentStory();
    mockConfirm();
    const g = chatService.nodes().find(n => n.id === 'g')!;

    await service.deleteNavNodes(g);

    expect(chatService.deletedNodes().some(n => n.id === 'g')).toBe(true);
    expect(chatService.nodes().find(n => n.id === 'p')?.parentId).toBe('q1');
    expect(chatService.getChildren('p').map(n => n.id)).toEqual(['h1', 'h2']);
  });

  it('cutNavSelection of a grandparent AND its child cuts the whole chain, off-path child intact', async () => {
    await open(grandparentStory());
    activateGrandparentStory();
    mockConfirm();
    navSelection.toggle('g', chatService.getActivePath(), () => false);
    navSelection.toggle('p', chatService.getActivePath(), () => false);
    expect(navSelection.selectedIds()).toEqual(['g', 'p']);

    await service.cutNavSelection();

    // The whole selected chain leaves the story…
    expect(chatService.deletedNodes().some(n => n.id === 'g')).toBe(true);
    expect(chatService.deletedNodes().some(n => n.id === 'p')).toBe(true);
    expect(chatService.nodes().some(n => n.id === 'g' || n.id === 'p')).toBe(false);
    // …and lands on the clipboard in path order.
    expect(clipboard.clipboard()!.nodes.map(n => n.id)).toEqual(['g', 'p']);
    // Both children re-hang on the topmost surviving ancestor, the off-path one
    // included.
    expect(chatService.getChildren('q1').map(n => n.id)).toEqual(['h1', 'h2']);
    expect(chatService.nodes().find(n => n.id === 'h2')?.parentId).toBe('q1');
    expect(pathIds()).toEqual(['q1', 'h1']);
    expect(navSelection.selectedIds()).toEqual([]);
  });

  it('cutNavSelection of grandparent, parent AND the active node cuts to the fork, off-path child survives', async () => {
    await open(grandparentStory());
    activateGrandparentStory();
    mockConfirm();
    // Ctrl+click g then h1 → the selection normalises to the contiguous chain
    // g → p → h1 (the whole visible run down to where the story continued).
    navSelection.toggle('g', chatService.getActivePath(), () => false);
    navSelection.toggle('h1', chatService.getActivePath(), () => false);
    expect(navSelection.selectedIds()).toEqual(['g', 'p', 'h1']);

    await service.cutNavSelection();

    expect(chatService.deletedNodes().some(n => n.id === 'g')).toBe(true);
    expect(chatService.deletedNodes().some(n => n.id === 'p')).toBe(true);
    expect(chatService.deletedNodes().some(n => n.id === 'h1')).toBe(true);
    expect(clipboard.clipboard()!.nodes.map(n => n.id)).toEqual(['g', 'p', 'h1']);
    // Only the root and the branch that was NOT on the active path remain —
    // h2 hangs directly under q1 now (the composer leaf is not a story node).
    expect(chatService.nodes().filter(n => !chatService.isDraftQuestion(n)).map(n => n.id).sort())
      .toEqual(['h2', 'q1']);
    expect(chatService.nodes().find(n => n.id === 'h2')?.parentId).toBe('q1');
    // The active path no longer runs through any cut node.
    expect(pathIds()).toEqual(['q1']);
    expect(navSelection.selectedIds()).toEqual([]);
  });

  // --- arbitrary trees: ONLY a sequential chain is ever cut --------------
  //
  //   q1 ─┬─ a1 ─┬─ lore1 ── q2 ─┬─ a2 ─┬─ lore2 ── q3       (active path)
  //       │      │                │     └─ lore2b (identical lore, deduped)
  //       │      │                └─ a2b  (off-path, excluded)
  //       │      └─ a1d           (off-path)
  //       ├─ a1b                  (off-path, excluded → pill stays, it forks)
  //       └─ a1c                  (off-path)
  //
  // plus RETIRED VERSIONS (q2-old, a2-old) and every navbar visibility kind:
  // plain pills, a HIDDEN pill (q2 — excluded and its only current child), an
  // armed lore pill (lore1) and a documented lore pill (lore2 — excluded but
  // still visible because lore is the path's anatomy).

  /** A convoluted story: forks + retired versions + all visibility kinds. */
  function messyStory(): ReturnType<typeof makeNode>[] {
    return [
      makeNode({ id: 'q1', role: 'user', content: 'Q1', position: 1 }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', position: 1 }),
      makeNode({ id: 'a1b', parentId: 'q1', role: 'assistant', content: 'A1 sibling', position: 2, excludeFromContext: true }),
      makeNode({ id: 'a1c', parentId: 'q1', role: 'assistant', content: 'A1 other branch', position: 3 }),

      makeNode({ id: 'lore1', parentId: 'a1', role: 'lore', content: 'Ashley is married.', position: 1, excludeAfterSend: true }),
      makeNode({ id: 'a1d', parentId: 'a1', role: 'assistant', content: 'A1 off path', position: 2 }),

      makeNode({ id: 'q2', parentId: 'lore1', role: 'user', content: 'Q2', position: 1, excludeFromContext: true }),
      makeNode({ id: 'q2-old', parentId: 'lore1', role: 'user', content: 'Q2 (old)', position: 2, isCurrent: false }),

      makeNode({ id: 'a2', parentId: 'q2', role: 'assistant', content: 'A2', position: 1, previousVersionId: 'a2-old' }),
      makeNode({ id: 'a2-old', parentId: 'q2', role: 'assistant', content: 'A2 (old)', position: 2, isCurrent: false }),
      makeNode({ id: 'a2b', parentId: 'q2', role: 'assistant', content: 'A2 off path', position: 3, excludeFromContext: true }),

      makeNode({ id: 'lore2', parentId: 'a2', role: 'lore', content: 'Harvey is dead.', position: 1, excludeFromContext: true }),
      makeNode({ id: 'lore2b', parentId: 'a2', role: 'lore', content: 'Harvey is dead.', position: 2, excludeFromContext: true }),

      makeNode({ id: 'q3', parentId: 'lore2', role: 'user', content: 'Q3', position: 1 }),
    ];
  }

  /** Walk the active path of {@link messyStory}. */
  function activateMessyStory(): void {
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    chatService.setActiveChild('a1', 'lore1');
    chatService.setActiveChild('lore1', 'q2');
    chatService.setActiveChild('q2', 'a2');
    chatService.setActiveChild('a2', 'lore2');
    chatService.setActiveChild('lore2', 'q3');
    expect(pathIds()).toEqual(['q1', 'a1', 'lore1', 'q2', 'a2', 'lore2', 'q3']);
  }

  it('cuts only the contiguous run — across forks, versions and visibility kinds', async () => {
    await open(messyStory());
    activateMessyStory();

    // The bar really hides q2 (excluded, no sibling) and keeps BOTH lore pills.
    expect(navVisibleIds()).toEqual(['q1', 'a1', 'lore1', 'a2', 'lore2', 'q3']);
    expect(navVisibleIds()).not.toContain('q2');
    expect(navVisibleIds()).toContain('lore2'); // excluded, but lore stays visible

    mockConfirm();
    // Ctrl+click the two bounding PILLS: the hidden q2 in between is part of
    // the normalised chain, the off-path siblings are not.
    navSelection.toggle('a1', chatService.getActivePath(), () => false);
    navSelection.toggle('lore2', chatService.getActivePath(), () => false);
    expect(navSelection.selectedIds()).toEqual(['a1', 'lore1', 'q2', 'a2', 'lore2']);

    await service.cutNavSelection();

    // Exactly that run left the story, and it is what sits on the clipboard…
    expect(api.nodes.filter(n => !!n.deletedAt).map(n => n.id).sort())
      .toEqual(['a1', 'a2', 'lore1', 'lore2', 'q2'].sort());
    expect(clipboard.clipboard()!.nodes.map(n => n.id)).toEqual(['a1', 'lore1', 'q2', 'a2', 'lore2']);
    // …nothing else was touched: off-path siblings, the deduped lore repeat,
    // the still-running story tail and BOTH retired versions are intact.
    const survivors = ['a1b', 'a1c', 'a1d', 'a2b', 'lore2b', 'q3', 'q2-old', 'a2-old'];
    expect(chatService.nodes().filter(n => !chatService.isDraftQuestion(n)).map(n => n.id).sort())
      .toEqual(['q1', ...survivors].sort());
    // All of them now hang on the run's topmost surviving ancestor.
    for (const id of survivors) {
      expect(chatService.nodes().find(n => n.id === id)?.parentId).toBe('q1');
    }
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
    expect(newChat.title).toBe('Story (2)');
    expect(chatService.currentChatId()).toBe(newChat.id);
  });

  it('extract prepends the current topic system prompt', async () => {
    await open(story(), {
      project: { id: 'project-1', mainTopicId: 'topic-main' },
      topics: [
        { id: 'topic-main', projectIds: ['project-1'], defaultSystemPrompt: 'Main prompt' },
        { id: 'topic-current', projectIds: ['project-1'], defaultSystemPrompt: 'Current prompt' },
      ],
    });
    TestBed.inject(TopicSelectionService).selectTopic('topic-current');
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    await service.extractNavSelection();

    const extractedChat = api.chats.find(chat => chat.id !== CHAT_ID)!;
    const extractedNodes = api.nodes.filter(node => node.chatId === extractedChat.id);
    const systemNode = extractedNodes.find(node => node.role === 'system')!;
    const selectedNode = extractedNodes.find(node => node.content === 'Answer one')!;
    expect(systemNode.content).toBe('Current prompt');
    expect(systemNode.parentId).toBeNull();
    expect(selectedNode.parentId).toBe(systemNode.id);
  });

  it('extract subtree prepends the current topic system prompt before the visible continuation', async () => {
    await open(story(), {
      project: { id: 'project-1', mainTopicId: 'topic-main' },
      topics: [
        { id: 'topic-main', projectIds: ['project-1'], defaultSystemPrompt: 'Main prompt' },
        { id: 'topic-current', projectIds: ['project-1'], defaultSystemPrompt: 'Current prompt' },
      ],
    });
    TestBed.inject(TopicSelectionService).selectTopic('topic-current');
    activateStory();
    mockConfirm();
    navSelection.toggle('a1', chatService.getActivePath(), () => false);

    await service.extractNavSelection(true);

    const extractedChat = api.chats.find(chat => chat.id !== CHAT_ID)!;
    const extractedNodes = api.nodes.filter(node => node.chatId === extractedChat.id);
    const systemNode = extractedNodes.find(node => node.role === 'system')!;
    const firstAnswer = extractedNodes.find(node => node.content === 'Answer one')!;
    const continuation = extractedNodes.find(node => node.content === 'Answer two')!;
    expect(systemNode.content).toBe('Current prompt');
    expect(extractedChat.title).toBe('Story (2)');
    expect(firstAnswer.parentId).toBe(systemNode.id);
    expect(continuation.parentId).toBe(firstAnswer.id);
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
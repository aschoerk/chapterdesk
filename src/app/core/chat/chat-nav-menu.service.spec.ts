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
import { ChatNavMenuService, type ChatNavMenuHost } from './chat-nav-menu.service';
import type { ChatNode } from '../../models/chat';

const CHAT_ID = 'chat-1';

/**
 * The menu HOST contract: in the app the chat page is the host. The spec
 * provides a recording stub so the menu can be exercised without the page.
 */
function hostStub(path: ChatNode[], selected: string[] = []): ChatNavMenuHost & {
  calls: string[];
} {
  const calls: string[] = [];
  const rec = (name: string) => () => { calls.push(name); };
  return {
    calls,
    navPath: () => path,
    navSelectedIds: () => selected,
    navHasSelection: () => selected.length > 0,
    toggleNavSelection: (id: string) => calls.push(`toggle:${id}`),
    clearNavSelection: rec('clear'),
    startBranchAt: rec('branch'),
    switchNavSibling: (_n, dir) => calls.push(`sibling:${dir}`),
    copyNavNodes: rec('copy'),
    cutNavNodes: rec('cut'),
    deleteNavNodes: rec('delete'),
    pasteNavSelectionBefore: rec('pasteBefore'),
    pasteNavSelectionAfter: rec('pasteAfter'),
    pasteChainInto: (mode, leftId, rightId) => {
      calls.push(`chain:${mode}:${leftId}:${rightId ?? '-'}`);
    },
  };
}

describe('ChatNavMenuService', () => {
  let api: InMemoryChatApi;
  let service: ChatNavMenuService;
  let clipboard: NodeClipboardService;
  let chatService: ChatService;
  let i18n: I18nService;

  async function open(nodes: ReturnType<typeof makeNode>[]): Promise<void> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [{ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' }],
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = nodes.map(n => ({ ...n, chatId: CHAT_ID }));
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        ChatNavMenuService,
      ],
    }).compileComponents();
    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    clipboard = TestBed.inject(NodeClipboardService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    service = TestBed.inject(ChatNavMenuService);
  }

  /** A three-node visible chain q1 → a1 → q2. */
  function threeNodes(): ReturnType<typeof makeNode>[] {
    return [
      makeNode({ id: 'q1', role: 'user', content: 'Q1' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', isCurrent: true }),
      makeNode({ id: 'q2', parentId: 'a1', role: 'user', content: 'Q2', isCurrent: true }),
    ];
  }

  beforeEach(() => {
    localStorage.clear();
  });

  it('opening one menu closes the other', async () => {
    await open(threeNodes());
    const path = chatService.getActivePath();
    service.bind(hostStub(path));
    clipboard.copySequence([path[1]]);

    // The paste menu opens on any node that has a successor.
    service.openNavPasteMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 } as MouseEvent, path[0]);
    expect(service.navPasteMenu()?.leftId).toBe('q1');
    expect(service.navPasteMenu()?.rightId).toBe('a1');
    expect(service.isOpen()).toBe(true);

    service.openNavNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 20, clientY: 20 } as MouseEvent, path[1]);
    expect(service.navPasteMenu()).toBeNull(); // the paste menu was closed…
    expect(service.navNodeMenu()?.nodeId).toBe('a1'); // …and the node menu opened
  });

  it('the terminal empty direction gets no menu and no paste-to-its-left', async () => {
    await open([
      ...threeNodes(),
      makeNode({ id: 'draft', parentId: 'q2', role: 'user', content: '', isCurrent: true }),
    ]);
    const path = chatService.getActivePath();
    const host = hostStub(path);
    service.bind(host);
    clipboard.copySequence([path[1]]);

    // Right-click on the draft: suppressed (it is not a fork participant).
    service.openNavNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5 } as MouseEvent, path.at(-1)!);
    expect(service.navNodeMenu()).toBeNull();

    // Nothing may be pasted LEFT of the draft → the button after q2 is gone.
    expect(service.pasteTargets('q2')).toBeNull();
    // …but pasting behind a1 (its right neighbour is q2) is fine.
    expect(service.pasteTargets('a1')).toEqual({ leftId: 'a1', rightId: 'q2' });
    // Behind the draft itself is allowed (= at the very end): no right node.
    expect(service.pasteTargets('draft')).toEqual({ leftId: 'draft', rightId: null });
  });

  it('a terminal empty draft that is a fork participant can be switched from the bar', async () => {
    // q1 → a1 forks into { draft (the terminal empty composer) }, { q3 → a3 }.
    // The active path runs through a1 → the draft. The draft IS the terminal
    // empty direction AND a fork participant (a1 has draft + q3 as siblings):
    // it must open a menu with the fork-switch rows — but no selection /
    // clipboard / paste rows.
    await open([
      makeNode({ id: 'q1', role: 'user', content: 'Q1', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', isCurrent: true, createdAt: '2026-01-01T00:00:01.000Z' }),
      makeNode({ id: 'draft', parentId: 'a1', role: 'user', content: '', isCurrent: true, createdAt: '2026-01-01T00:00:03.000Z' }),
      makeNode({ id: 'q3', parentId: 'a1', role: 'user', content: 'Q3', isCurrent: true, createdAt: '2026-01-01T00:00:02.000Z' }),
      makeNode({ id: 'a3', parentId: 'q3', role: 'assistant', content: 'A3', isCurrent: true, createdAt: '2026-01-01T00:00:04.000Z' }),
    ]);
    const path = chatService.getActivePath();
    const host = hostStub(path);
    service.bind(host);
    const draft = path.at(-1)!;
    expect(draft.id).toBe('draft');
    expect(chatService.isDraftQuestion(draft)).toBe(true); // terminal empty direction

    // The draft IS a fork participant: its parent a1 has draft AND q3.
    expect(chatService.getChildren(draft.parentId).length).toBe(2);

    // Right-click on the draft opens the menu (fork participant).
    service.openNavNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5 } as MouseEvent, draft);
    expect(service.navNodeMenu()?.nodeId).toBe('draft');

    // Rows: branch-here + fork switch ONLY — no selection/clipboard/paste.
    const items = service.navNodeMenuItems();
    const labels = items.filter(i => !i.divider).map(i => i.label);
    expect(labels).toContain(i18n.t('node.prevBranch'));
    expect(labels).toContain(i18n.t('node.nextBranch'));
    expect(labels).not.toContain(i18n.t('node.copySelected'));
    expect(labels).not.toContain(i18n.t('node.cutSelected'));
    expect(labels).not.toContain(i18n.t('node.deleteSelected'));
    expect(labels).not.toContain(i18n.t('node.navSelect'));
  });

  it('paste menu rows dispatch insert vs append through the host', async () => {
    await open(threeNodes());
    const path = chatService.getActivePath();
    const host = hostStub(path);
    service.bind(host);
    clipboard.copySequence([path[1]]);
    service.openNavPasteMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 } as MouseEvent, path[0]);

    const items = service.navPasteMenuItems(service.navPasteMenu()!);
    expect(items.map(i => i.label)).toEqual(['Insert', 'Append']);

    service.runNavPasteAction(items[1]);
    expect(service.navPasteMenu()).toBeNull(); // closed before running
    expect(host.calls).toContain('chain:append:q1:a1');
  });

  it('node menu groups: branch, siblings, selection, clipboard, paste', async () => {
    await open([
      makeNode({ id: 'q1', role: 'user', content: 'Q1' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', isCurrent: true }),
      makeNode({ id: 'a2', parentId: 'q1', role: 'assistant', content: 'A2', isCurrent: true }),
    ]);
    const path = chatService.getActivePath();
    const host = hostStub(path, ['a1']);
    service.bind(host);
    // Look nodes up BY ID: the active path may also carry the auto-created
    // draft leaf (timestamp race in the newestChild pick), so `path[1]` is
    // not reliably `a1` — and the selection/host assertions need a1.
    const a1 = chatService.nodes().find(n => n.id === 'a1')!;
    const q1 = chatService.nodes().find(n => n.id === 'q1')!;
    clipboard.copySequence([q1]);

    service.openNavNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 } as MouseEvent, a1);
    const items = service.navNodeMenuItems();
    const labels = items.filter(i => !i.divider).map(i => i.label);

    expect(labels).toContain('Start branch here');
    // Two current siblings → the fork switches are offered.
    expect(labels).toContain('Previous fork');
    expect(labels).toContain('Next fork');
    // The node is part of the selection → "Unselect" is offered + clear.
    expect(labels).toContain('Unselect');
    expect(labels).toContain('Clear');
    expect(labels).toContain('Copy');
    expect(labels).toContain('Delete');
    // Clipboard has content → paste rows exist.
    expect(labels).toContain('Paste in front');
    expect(labels).toContain('Paste behind');

    // Dispatch: abort on a divider, close + run otherwise.
    const divider = items.find(i => i.divider)!;
    service.runNavNodeAction(divider);
    expect(service.navNodeMenu()).not.toBeNull(); // a divider does nothing

    const copy = items.find(i => i.label === 'Copy')!;
    service.runNavNodeAction(copy);
    expect(service.navNodeMenu()).toBeNull();
    expect(host.calls).toContain('copy');
  });

  it('clamps both menus into the viewport', async () => {
    await open(threeNodes());
    const path = chatService.getActivePath();
    service.bind(hostStub(path));
    // jsdom window is 1024×768; a click far right/bottom must be pulled in.
    service.openNavNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5000, clientY: 5000 } as MouseEvent, path[1]);
    expect(service.navNodeMenuLeftPx()).toBe(1024 - 260 - 8);
    expect(service.navNodeMenuTopPx()).toBe(768 - 300 - 8);
  });

  it('dismissAll closes both menus', async () => {
    await open(threeNodes());
    const path = chatService.getActivePath();
    service.bind(hostStub(path));
    clipboard.copySequence([path[1]]);
    service.openNavPasteMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 } as MouseEvent, path[0]);
    service.dismissAll();
    expect(service.isOpen()).toBe(false);
  });
});

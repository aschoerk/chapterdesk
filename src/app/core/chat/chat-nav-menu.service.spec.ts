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
    TestBed.inject(I18nService).setLocale('en');
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
    service.openPasteMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 } as MouseEvent, path[0]);
    expect(service.navPasteMenu()?.leftId).toBe('q1');
    expect(service.navPasteMenu()?.rightId).toBe('a1');
    expect(service.isOpen()).toBe(true);

    service.openNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 20, clientY: 20 } as MouseEvent, path[1]);
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

    // Right-click on the draft: suppressed.
    service.openNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5 } as MouseEvent, path.at(-1)!);
    expect(service.navNodeMenu()).toBeNull();

    // Nothing may be pasted LEFT of the draft → the button after q2 is gone.
    expect(service.pasteTargets('q2')).toBeNull();
    // …but pasting behind a1 (its right neighbour is q2) is fine.
    expect(service.pasteTargets('a1')).toEqual({ leftId: 'a1', rightId: 'q2' });
    // Behind the draft itself is allowed (= at the very end): no right node.
    expect(service.pasteTargets('draft')).toEqual({ leftId: 'draft', rightId: null });
  });

  it('paste menu rows dispatch insert vs append through the host', async () => {
    await open(threeNodes());
    const path = chatService.getActivePath();
    const host = hostStub(path);
    service.bind(host);
    clipboard.copySequence([path[1]]);
    service.openPasteMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 } as MouseEvent, path[0]);

    const items = service.pasteMenuItems(service.navPasteMenu()!);
    expect(items.map(i => i.label)).toEqual(['Insert', 'Append']);

    service.runPasteAction(items[1]);
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
    clipboard.copySequence([path[0]]);

    service.openNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 } as MouseEvent, path[1]);
    const items = service.nodeMenuItems();
    const labels = items.filter(i => !i.divider).map(i => i.label);

    expect(labels).toContain('Start branch here');
    // Two current siblings → the continuation switches are offered.
    expect(labels).toContain('Previous continuation');
    expect(labels).toContain('Next continuation');
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
    service.runNodeAction(divider);
    expect(service.navNodeMenu()).not.toBeNull(); // a divider does nothing

    const copy = items.find(i => i.label === 'Copy')!;
    service.runNodeAction(copy);
    expect(service.navNodeMenu()).toBeNull();
    expect(host.calls).toContain('copy');
  });

  it('clamps both menus into the viewport', async () => {
    await open(threeNodes());
    const path = chatService.getActivePath();
    service.bind(hostStub(path));
    // jsdom window is 1024×768; a click far right/bottom must be pulled in.
    service.openNodeMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5000, clientY: 5000 } as MouseEvent, path[1]);
    expect(service.nodeMenuLeftPx()).toBe(1024 - 260 - 8);
    expect(service.nodeMenuTopPx()).toBe(768 - 300 - 8);
  });

  it('dismissAll closes both menus', async () => {
    await open(threeNodes());
    const path = chatService.getActivePath();
    service.bind(hostStub(path));
    clipboard.copySequence([path[1]]);
    service.openPasteMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 } as MouseEvent, path[0]);
    service.dismissAll();
    expect(service.isOpen()).toBe(false);
  });
});

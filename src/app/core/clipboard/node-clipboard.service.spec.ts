import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { NodeClipboardService, type ClipboardEntry } from './node-clipboard.service';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../chat/chat.service';
import { ProjectService } from '../settings/project.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeAttachment, seedApi } from '../../../../test-helpers/factories';
import type { Chat, ChatNode } from '../../models/chat';

const CHAT_ID = 'chat-1';
const LS_KEY = 'chat.nodeClipboard.v1';

/**
 * NodeClipboardService — the node-level copy/cut/paste of the navbar.
 *
 * The specs are grouped by operation:
 *   - the clipboard payload (copy / copySubtree / copySequence, persistence),
 *   - cut (copy + delete; `keepChildren` vs. subtree),
 *   - paste / insertIntoPath / appendIntoPath (how a copied chain is spliced
 *     into the tree and which node becomes the active continuation),
 *   - extractSequence (move a chain into a NEW story; copy-only nodes whose
 *     branch stays behind).
 *
 * `open()` seeds a chat and only LOADS the nodes (no selection → no auto-draft,
 * so the tree stays exactly as seeded). `openSelected()` additionally selects
 * the chat, which is required for everything touching `currentChatId()` /
 * `getActivePath()` — selection runs the draft housekeeping, so callers of
 * those specs must tolerate the appended empty composer leaf.
 */
describe('NodeClipboardService', () => {
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let service: NodeClipboardService;

  // ------------------------------------------------------------------
  // Harness
  // ------------------------------------------------------------------

  async function wire(): Promise<void> {
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
      ],
    }).compileComponents();
    chatService = TestBed.inject(ChatService);
    service = TestBed.inject(NodeClipboardService);
  }

  /** Seed a chat + nodes and LOAD them (no chat selection, no auto-draft). */
  async function open(
    tree: Partial<ChatNode>[],
    chats: Partial<Chat>[] = [{ id: CHAT_ID, title: 'Story' }],
  ): Promise<void> {
    api = new InMemoryChatApi();
    localStorage.clear();
    seedApi(api, { chats, nodes: tree });
    // The in-memory API numbers chats and nodes from ONE counter (`chat-1`,
    // `node-1`, …) while seeded ids bypass it. Consume the seeded chat's id so
    // a chat created later on (extractSequence) gets a fresh one and cannot
    // collide with the seed.
    await api.createChat('__reserved__', null);
    api.chats = api.chats.filter(c => c.title !== '__reserved__');
    await wire();
    await chatService.loadChats();
    await chatService.loadNodes(CHAT_ID);
  }

  /** Seed + load + SELECT the chat (needed for currentChatId / active path). */
  async function openSelected(
    tree: Partial<ChatNode>[],
    chats?: Partial<Chat>[],
  ): Promise<void> {
    if (chats) {
      await open(tree, chats);
    } else {
      await open(tree);
    }
    await chatService.selectChat(CHAT_ID);
  }

  /** A fresh service instance over the same storage (persistence specs). */
  async function remount(): Promise<NodeClipboardService> {
    TestBed.resetTestingModule();
    await wire();
    return service;
  }

  /** The node of the shared state by id. */
  function nut(id: string): ChatNode {
    const node = chatService.nodes().find(n => n.id === id);
    expect(node).toBeDefined();
    return node!;
  }

  /** The live clipboard payload (asserts it is not empty). */
  function entry(): ClipboardEntry {
    const e = service.clipboard();
    expect(e).not.toBeNull();
    return e!;
  }

  /** Stored payload as plain JSON (persistence assertions). */
  function stored(): any {
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).toBeTruthy();
    return JSON.parse(raw!);
  }

  /** Node ids of a chat's nodes, whether or not they are still current. */
  function nodeIds(chatId: string): string[] {
    return api.nodes.filter(n => n.chatId === chatId && !n.deletedAt).map(n => n.id);
  }

  /** The chain contents of a chat, walked from its single root. */
  function contentChain(chatId: string): string[] {
    const nodes = api.nodes.filter(n => n.chatId === chatId && !n.deletedAt);
    const out: string[] = [];
    let cur = nodes.find(n => n.parentId === null);
    while (cur) {
      out.push(cur.content);
      const id: string = cur.id;
      cur = nodes.find(n => n.parentId === id);
    }
    return out;
  }

  /** A three-node chain q1 → a1 → q2. */
  function chain(): Partial<ChatNode>[] {
    return [
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' },
      { id: 'q2', parentId: 'a1', role: 'user', content: 'Q2' },
    ];
  }

  // ------------------------------------------------------------------
  // Empty state
  // ------------------------------------------------------------------

  it('is empty by default', async () => {
    await open([]);
    expect(service.hasContent()).toBe(false);
    expect(service.count()).toBe(0);
    expect(service.rootRole()).toBeNull();
    expect(service.action()).toBeNull();
    expect(service.clipboard()).toBeNull();
  });

  // ------------------------------------------------------------------
  // Copying
  // ------------------------------------------------------------------

  it('copy(node) stores a single-node payload and persists it', async () => {
    await open(chain());
    service.copy(nut('q1'));

    expect(service.hasContent()).toBe(true);
    expect(service.action()).toBe('copy');
    expect(service.count()).toBe(1);
    expect(service.rootRole()).toBe('user');

    expect(entry()).toMatchObject({
      format: 'chapterdesk.nodeClipboard',
      version: 1,
      action: 'copy',
      sourceChatId: CHAT_ID,
    });
    expect(entry().nodes[0]).toMatchObject({
      id: 'q1',
      parentId: null,
      role: 'user',
      content: 'Q1',
    });

    // The payload survives reloads: it is written to localStorage verbatim.
    expect(stored()).toMatchObject({
      format: 'chapterdesk.nodeClipboard',
      version: 1,
      action: 'copy',
      sourceChatId: CHAT_ID,
    });
    expect(stored().nodes).toHaveLength(1);
    expect(stored().nodes[0].id).toBe('q1');
  });

  it('copy(node) carries the node data (thinking, model, attachments, flags)', async () => {
    await open([
      {
        id: 'q1',
        parentId: null,
        role: 'user',
        content: 'Q1',
        thinking: 'plan',
        modelId: 'm-1',
        providerId: 'prov-1',
        attachments: [makeAttachment()],
        excludeFromContext: true,
        excludeAfterSend: true,
      },
    ]);
    service.copy(nut('q1'));

    expect(entry().nodes[0]).toMatchObject({
      thinking: 'plan',
      modelId: 'm-1',
      providerId: 'prov-1',
      excludeFromContext: true,
      excludeAfterSend: true,
    });
    expect(entry().nodes[0].attachments).toHaveLength(1);
    expect(entry().nodes[0].attachments![0].name).toBe('notes.txt');
  });

  it('copySubtree(node) copies the node and every descendant', async () => {
    await open(chain());
    service.copySubtree(nut('q1'));

    expect(service.count()).toBe(3);
    expect(entry().nodes.map(n => n.id)).toEqual(['q1', 'a1', 'q2']);
    // The parent links of the copied chain are kept as-is.
    expect(entry().nodes.map(n => n.parentId ?? null)).toEqual([null, 'q1', 'a1']);
  });

  it('copySubtree(node) only takes that node’s own subtree', async () => {
    await open(chain());
    service.copySubtree(nut('a1'));

    expect(entry().nodes.map(n => n.id)).toEqual(['a1', 'q2']);
  });

  it('copySequence(nodes) stores an ordered list WITHOUT subtrees', async () => {
    await open(chain());
    service.copySequence([nut('q1'), nut('a1')]);

    expect(service.count()).toBe(2);
    expect(entry().nodes.map(n => n.id)).toEqual(['q1', 'a1']);
    expect(entry().nodes.map(n => n.content)).toEqual(['Q1', 'A1']);
  });

  it('copySequence ignores an empty list (the previous payload stays)', async () => {
    await open(chain());
    service.copy(nut('a1'));
    service.copySequence([]);

    expect(service.count()).toBe(1);
    expect(entry().nodes[0].id).toBe('a1');
  });

  // ------------------------------------------------------------------
  // Cutting
  // ------------------------------------------------------------------

  it('cut(node) copies it and removes only that node — children stay in the thread', async () => {
    await open(chain());
    await service.cut(nut('a1'));

    // The staged payload is a plain COPY: the source node is removed right
    // away, so pasting it back must re-create it (never "move" it twice).
    expect(service.action()).toBe('copy');
    expect(entry().nodes.map(n => n.id)).toEqual(['a1']);

    expect(api.nodes.find(n => n.id === 'a1')?.deletedAt).toBeTruthy();
    const q2 = api.nodes.find(n => n.id === 'q2')!;
    expect(q2.deletedAt).toBeFalsy();
    // The orphaned child is re-hung under the cut node's parent.
    expect(q2.parentId).toBe('q1');
  });

  it('cutSubtree(node) copies the whole subtree and removes it entirely', async () => {
    await open(chain());
    await service.cutSubtree(nut('a1'));

    expect(entry().nodes.map(n => n.id)).toEqual(['a1', 'q2']);
    expect(api.nodes.find(n => n.id === 'a1')?.deletedAt).toBeTruthy();
    expect(api.nodes.find(n => n.id === 'q2')?.deletedAt).toBeTruthy();
  });

  it('cutSequence(nodes) removes the listed nodes but keeps their children', async () => {
    await open(chain());
    await service.cutSequence([nut('q1'), nut('a1')]);

    expect(entry().nodes.map(n => n.id)).toEqual(['q1', 'a1']);
    expect(nodeIds(CHAT_ID)).toEqual(['q2']);
    // q1 was the root: its surviving child becomes a root itself.
    expect(api.nodes.find(n => n.id === 'q2')?.parentId).toBeNull();
  });

  it('cutSequence ignores an empty list', async () => {
    await open(chain());
    await service.cutSequence([]);
    expect(service.hasContent()).toBe(false);
    expect(nodeIds(CHAT_ID)).toEqual(['q1', 'a1', 'q2']);
  });

  // --- off-path branches (nodes NOT on the active path) -----------------
  //
  //   q1 → p → { c1 (active continuation), c2 (off-path sibling) }
  //
  // `c2` is in the tree but never on the active path, so the navbar does not
  // render it. Cutting a node above it must not lose it.

  /** q1 → p → { c1 (active), c2 (off-path). } */
  function offPathChildChain(): Partial<ChatNode>[] {
    return [
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'p', parentId: 'q1', role: 'assistant', content: 'P' },
      { id: 'c1', parentId: 'p', role: 'user', content: 'C1', position: 1 },
      { id: 'c2', parentId: 'p', role: 'assistant', content: 'C2', position: 2 },
    ];
  }

  /** Load + select, then walk q1 → p → c1 (leaving c2 off the active path). */
  async function openOffPathChildChain(): Promise<void> {
    await openSelected(offPathChildChain());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'p');
    chatService.setActiveChild('p', 'c1');
    expect(chatService.getActivePath().map(n => n.id)).toEqual(['q1', 'p', 'c1']);
  }

  it('cut(node) re-hangs the off-path child too — only the cut node leaves', async () => {
    await openOffPathChildChain();

    await service.cut(nut('p'));

    // Only the cut node travels on the clipboard…
    expect(entry().nodes.map(n => n.id)).toEqual(['p']);
    expect(api.nodes.find(n => n.id === 'p')?.deletedAt).toBeTruthy();
    // …both children survive, including the one that is NOT on the active path.
    expect(chatService.getChildren('q1').map(n => n.id)).toEqual(['c1', 'c2']);
    expect(nut('c1').parentId).toBe('q1');
    expect(nut('c2').parentId).toBe('q1');
  });

  it('cutSequence of an ancestor + parent re-hangs the off-path child to the root', async () => {
    await openOffPathChildChain();

    await service.cutSequence([nut('q1'), nut('p')]);

    expect(entry().nodes.map(n => n.id)).toEqual(['q1', 'p']);
    // Both selected nodes are gone; both children become roots.
    expect(nodeIds(CHAT_ID)).toEqual(['c1', 'c2']);
    expect(nut('c1').parentId).toBeNull();
    expect(nut('c2').parentId).toBeNull();
  });

  it('cutSubtree(node) takes the off-path child with the subtree', async () => {
    await openOffPathChildChain();

    await service.cutSubtree(nut('p'));

    expect(entry().nodes.map(n => n.id)).toEqual(['p', 'c1', 'c2']);
    expect(nodeIds(CHAT_ID)).toEqual(['q1']);
  });

  // --- cutting a GRANDPARENT above an off-path branch -------------------
  //
  //   q1 → g → p → { h1 (active), h2 (off-path) }
  //
  // Cutting `g` must leave the whole branch underneath it intact — the
  // off-path child included.

  /** q1 → g → p → { h1 (active), h2 (off-path). } */
  function grandparentChain(): Partial<ChatNode>[] {
    return [
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'g', parentId: 'q1', role: 'assistant', content: 'G' },
      { id: 'p', parentId: 'g', role: 'user', content: 'P' },
      { id: 'h1', parentId: 'p', role: 'assistant', content: 'H1', position: 1 },
      { id: 'h2', parentId: 'p', role: 'assistant', content: 'H2', position: 2 },
    ];
  }

  /** Load + select, then walk q1 → g → p → h1 (h2 stays off the path). */
  async function openGrandparentChain(): Promise<void> {
    await openSelected(grandparentChain());
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'g');
    chatService.setActiveChild('g', 'p');
    chatService.setActiveChild('p', 'h1');
    expect(chatService.getActivePath().map(n => n.id)).toEqual(['q1', 'g', 'p', 'h1']);
  }

  it('cut(grandparent) promotes the parent and keeps its off-path child', async () => {
    await openGrandparentChain();

    await service.cut(nut('g'));

    // Only the cut node travels on the clipboard…
    expect(entry().nodes.map(n => n.id)).toEqual(['g']);
    expect(api.nodes.find(n => n.id === 'g')?.deletedAt).toBeTruthy();
    // …the parent is promoted to g's place, untouched…
    expect(api.nodes.find(n => n.id === 'p')?.deletedAt).toBeFalsy();
    expect(nut('p').parentId).toBe('q1');
    // …and BOTH children stay under it, the off-path one included.
    expect(chatService.getChildren('p').map(n => n.id)).toEqual(['h1', 'h2']);
  });

  it('cutSequence(grandparent + ancestor) promotes the parent to a root, off-path child intact', async () => {
    await openGrandparentChain();

    await service.cutSequence([nut('q1'), nut('g')]);

    expect(entry().nodes.map(n => n.id)).toEqual(['q1', 'g']);
    // q1 and g are gone; the parent becomes a root…
    expect(nodeIds(CHAT_ID)).toEqual(['p', 'h1', 'h2']);
    expect(nut('p').parentId).toBeNull();
    // …with both children intact.
    expect(chatService.getChildren('p').map(n => n.id)).toEqual(['h1', 'h2']);
  });

  it('cutSubtree(grandparent) takes the off-path child too', async () => {
    await openGrandparentChain();

    await service.cutSubtree(nut('g'));

    expect(entry().nodes.map(n => n.id)).toEqual(['g', 'p', 'h1', 'h2']);
    expect(nodeIds(CHAT_ID)).toEqual(['q1']);
  });

  // ------------------------------------------------------------------
  // Clear + persistence
  // ------------------------------------------------------------------

  it('clear() empties the payload and its localStorage entry', async () => {
    await open(chain());
    service.copy(nut('q1'));
    expect(service.hasContent()).toBe(true);

    service.clear();

    expect(service.hasContent()).toBe(false);
    expect(service.clipboard()).toBeNull();
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });

  it('restores a saved payload on a fresh service instance', async () => {
    await open(chain());
    service.copySequence([nut('q1'), nut('a1')]);
    const saved = localStorage.getItem(LS_KEY)!;

    // A brand-new service instance reads the same payload back.
    localStorage.clear();
    localStorage.setItem(LS_KEY, saved);
    const rebuilt = await remount();

    expect(rebuilt.hasContent()).toBe(true);
    expect(rebuilt.action()).toBe('copy');
    expect(rebuilt.count()).toBe(2);
    expect(rebuilt.clipboard()!.nodes.map(n => n.id)).toEqual(['q1', 'a1']);
  });

  it('ignores a malformed or foreign payload (unknown format / version / action)', async () => {
    await open([]);

    localStorage.setItem(LS_KEY, '{not json');
    expect((await remount()).hasContent()).toBe(false);

    localStorage.setItem(LS_KEY, JSON.stringify({ format: 'other.app', version: 1, action: 'copy', nodes: [] }));
    expect((await remount()).hasContent()).toBe(false);

    localStorage.setItem(LS_KEY, JSON.stringify({ format: 'chapterdesk.nodeClipboard', version: 99, action: 'copy', nodes: [] }));
    expect((await remount()).hasContent()).toBe(false);

    localStorage.setItem(LS_KEY, JSON.stringify({ format: 'chapterdesk.nodeClipboard', version: 1, action: 'move', nodes: [] }));
    expect((await remount()).hasContent()).toBe(false);
  });

  // ------------------------------------------------------------------
  // paste (general target parent)
  // ------------------------------------------------------------------

  it('paste(null) appends the copied chain at the end of the root siblings and activates it', async () => {
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' },
    ]);
    service.copy(nut('q1'));

    const created = await service.paste(null);

    expect(created).not.toBeNull();
    expect(chatService.getChildren(null).map(n => n.id)).toEqual(['q1', created!.id]);
    expect(chatService.getActiveChildId(null)).toBe(created!.id);
    expect(created!.content).toBe('Q1');
  });

  it('paste(parent, afterNode) inserts the copy right after that sibling', async () => {
    await openSelected([
      { id: 'r1', parentId: null, role: 'user', content: 'R1' },
      { id: 'a1', parentId: 'r1', role: 'assistant', content: 'A1', position: 1 },
      { id: 'a2', parentId: 'r1', role: 'assistant', content: 'A2', position: 2 },
      { id: 'x1', parentId: null, role: 'user', content: 'X1', position: 2 },
    ]);
    service.copy(nut('x1'));

    const created = await service.paste('r1', 'a1');

    expect(created).not.toBeNull();
    expect(created!.parentId).toBe('r1');
    expect(chatService.getChildren('r1').map(n => n.id)).toEqual(['a1', created!.id, 'a2']);
  });

  it('paste remaps the copied parent pointers and drops the version history', async () => {
    await openSelected([
      {
        id: 's1',
        parentId: null,
        role: 'user',
        content: 'S1',
        thinking: 'plan',
        modelId: 'm-1',
        providerId: 'prov-1',
        attachments: [makeAttachment()],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 's2',
        parentId: 's1',
        role: 'assistant',
        content: 'S2',
        excludeFromContext: true,
        excludeAfterSend: true,
        isCurrent: true,
        version: 3,
        previousVersionId: 's2-old',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 's2-old',
        parentId: 's1',
        role: 'assistant',
        content: 'old',
        isCurrent: false,
        version: 2,
        createdAt: '2026-01-01T00:00:00.500Z',
      },
    ]);
    service.copySequence([nut('s1'), nut('s2')]);

    const created = await service.paste(null);

    expect(created).toMatchObject({
      role: 'user',
      content: 'S1',
      thinking: 'plan',
      modelId: 'm-1',
      providerId: 'prov-1',
    });
    expect(created!.attachments).toHaveLength(1);
    // A pasted node starts its own history: version 1, no previous version.
    expect(created!.version).toBe(1);
    expect(created!.previousVersionId ?? null).toBeNull();

    const child = chatService.nodes().find(n => n.parentId === created!.id);
    expect(child).toBeDefined();
    expect(child).toMatchObject({
      role: 'assistant',
      content: 'S2',
      excludeFromContext: true,
      excludeAfterSend: true,
      version: 1,
    });
    expect(child!.previousVersionId ?? null).toBeNull();
  });

  it('paste is a no-op with an empty clipboard', async () => {
    await openSelected(chain());
    const before = nodeIds(CHAT_ID);

    expect(await service.paste(null)).toBeNull();
    expect(nodeIds(CHAT_ID)).toEqual(before);
  });

  it('paste is a no-op without a current chat', async () => {
    await open(chain()); // loaded, NOT selected → currentChatId() is null
    service.copy(nut('q1'));

    expect(service.hasContent()).toBe(true);
    expect(await service.paste(null)).toBeNull();
  });

  // --- pasting under an off-path branch ---------------------------------

  it('paste under an off-path branch node attaches the copy there and activates it', async () => {
    await openOffPathChildChain();
    service.copy(nut('q1'));

    const created = await service.paste('c2');

    expect(created).not.toBeNull();
    expect(created!.parentId).toBe('c2');
    expect(chatService.getChildren('c2').map(n => n.id)).toEqual([created!.id]);
    expect(chatService.getActiveChildId('c2')).toBe(created!.id);
    // The active path is untouched — c2 is still off the path.
    expect(chatService.getActivePath().map(n => n.id)).toEqual(['q1', 'p', 'c1']);
  });

  it('the exclude-from-context flag travels with a copied chain through paste', async () => {
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'n1', parentId: 'q1', role: 'user', content: 'hint', excludeFromContext: true },
    ]);
    service.copySequence([nut('q1'), nut('n1')]);

    const created = await service.paste(null);

    const copiedChild = chatService.nodes().find(n => n.parentId === created!.id)!;
    expect(copiedChild.content).toBe('hint');
    expect(copiedChild.excludeFromContext).toBe(true);
  });

  // ------------------------------------------------------------------
  // insertIntoPath — splice into the visible chain:  left → [chain] → right
  // ------------------------------------------------------------------

  it('insertIntoPath splices the chain between the left and the right node', async () => {
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' },
      { id: 'q2', parentId: 'a1', role: 'user', content: 'Q2', position: 1 },
      { id: 'q3', parentId: 'a1', role: 'user', content: 'Q3', position: 2 },
      { id: 's1', parentId: null, role: 'user', content: 'S1', position: 2 },
      { id: 's2', parentId: 's1', role: 'assistant', content: 'S2' },
    ]);
    chatService.setActiveChild('a1', 'q2');
    service.copySequence([nut('s1'), nut('s2')]);

    const created = await service.insertIntoPath('a1', 'q2');

    expect(created).not.toBeNull();
    // The copied chain hangs under the left node…
    const copyLast = chatService.nodes().find(n => n.parentId === created!.id)!;
    expect(copyLast.content).toBe('S2');
    // …and the right node now continues under the chain's LAST node.
    expect(nut('q2').parentId).toBe(copyLast.id);
    // The chain root leads the left node's children and is the active one.
    expect(chatService.getChildren('a1').map(n => n.id)).toEqual([created!.id, 'q3']);
    expect(chatService.getActiveChildId('a1')).toBe(created!.id);
  });

  it('insertIntoPath without a right node appends the chain behind the left node', async () => {
    await openSelected([
      { id: 'a1', parentId: null, role: 'assistant', content: 'A1' },
      { id: 'q2', parentId: 'a1', role: 'user', content: 'Q2', position: 1 },
      { id: 's1', parentId: null, role: 'user', content: 'S1', position: 2 },
    ]);
    service.copy(nut('s1'));

    const created = await service.insertIntoPath('a1', null);

    expect(created).not.toBeNull();
    expect(created!.parentId).toBe('a1');
    expect(chatService.getChildren('a1').map(n => n.id)).toEqual([created!.id, 'q2']);
    expect(chatService.getActiveChildId('a1')).toBe(created!.id);
  });

  it('insertIntoPath is a no-op without a clipboard', async () => {
    await openSelected(chain());

    expect(await service.insertIntoPath('a1', 'q2')).toBeNull();
    expect(nut('q2').parentId).toBe('a1');
  });

  it('insertIntoPath is a no-op without a current chat', async () => {
    await open(chain()); // loaded, NOT selected → currentChatId() is null
    service.copy(nut('q1'));

    expect(service.hasContent()).toBe(true);
    expect(await service.insertIntoPath('a1', 'q2')).toBeNull();
    expect(nut('q2').parentId).toBe('a1');
  });

  // ------------------------------------------------------------------
  // appendIntoPath — parallel branch instead of splicing
  // ------------------------------------------------------------------

  it('appendIntoPath with a right node adds a parallel branch and keeps the right node active', async () => {
    await openSelected([
      { id: 'a1', parentId: null, role: 'assistant', content: 'A1' },
      { id: 'q2', parentId: 'a1', role: 'user', content: 'Q2', position: 1 },
      { id: 'q3', parentId: 'a1', role: 'user', content: 'Q3', position: 2 },
      { id: 's1', parentId: null, role: 'user', content: 'S1', position: 2 },
    ]);
    chatService.setActiveChild('a1', 'q2');
    service.copy(nut('s1'));

    const created = await service.appendIntoPath('a1', 'q3');

    expect(created).not.toBeNull();
    // The copy sits right where the paste button is — before the right node…
    expect(chatService.getChildren('a1').map(n => n.id)).toEqual(['q2', created!.id, 'q3']);
    // …but the visible continuation stays the existing right node.
    expect(nut('q2').parentId).toBe('a1');
    expect(chatService.getActiveChildId('a1')).toBe('q2');
  });

  it('appendIntoPath at the very end makes the chain the active continuation', async () => {
    await openSelected([
      { id: 'a1', parentId: null, role: 'assistant', content: 'A1' },
      { id: 'q2', parentId: 'a1', role: 'user', content: 'Q2', position: 1 },
      { id: 's1', parentId: null, role: 'user', content: 'S1', position: 2 },
    ]);
    chatService.setActiveChild('a1', 'q2');
    service.copy(nut('s1'));

    const created = await service.appendIntoPath('a1', null);

    expect(created).not.toBeNull();
    expect(chatService.getChildren('a1').map(n => n.id)).toEqual(['q2', created!.id]);
    expect(chatService.getActiveChildId('a1')).toBe(created!.id);
  });

  it('appendIntoPath is a no-op without a clipboard', async () => {
    await openSelected(chain());
    expect(await service.appendIntoPath('a1', null)).toBeNull();
  });

  // ------------------------------------------------------------------
  // extractSequence — move a chain into a NEW story
  // ------------------------------------------------------------------

  it('extractSequence returns null for an empty selection or an unknown source chat', async () => {
    await openSelected(chain());
    expect(await service.extractSequence([])).toBeNull();

    const ghost: ChatNode = {
      id: 'ghost',
      chatId: 'no-such-chat',
      parentId: null,
      role: 'user',
      content: 'G',
      version: 1,
      isCurrent: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(await service.extractSequence([ghost])).toBeNull();
  });

  it('extractSequence creates a new story with the selected chain and copies the lore', async () => {
    await openSelected(
      [
        { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
        { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' },
        { id: 'q2', parentId: 'a1', role: 'user', content: 'Q2' },
        { id: 'a2', parentId: 'q2', role: 'assistant', content: 'A2' },
      ],
      [{ id: CHAT_ID, title: 'Story', lore: 'Canon facts' }],
    );

    const newChat = await service.extractSequence([nut('a1'), nut('q2')]);

    expect(newChat).not.toBeNull();
    // a1 is the 2nd node of the active path → the title gets that index.
    expect(newChat!.title).toBe('Story (2)');
    expect(newChat!.lore).toBe('Canon facts');
    expect(contentChain(newChat!.id)).toEqual(['A1', 'Q2']);
  });

  it('extractSequence uses the title option when given', async () => {
    await openSelected(chain());
    const newChat = await service.extractSequence([nut('a1')], { title: 'Moved' });

    expect(newChat!.title).toBe('Moved (2)');
  });

  it('extractSequence keeps (copies) a node whose branch stays behind, and only cuts the fully moved nodes', async () => {
    // q1 → a1 → { a2, a3 }. Extracting a1 + a2: a3 stays in the source, so a1
    // must be COPIED (removing it would orphan a3) — only a2 is really cut.
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'a2', parentId: 'a1', role: 'assistant', content: 'A2', position: 1, createdAt: '2026-01-01T00:00:03.000Z' },
      { id: 'a3', parentId: 'a1', role: 'assistant', content: 'A3', position: 2, createdAt: '2026-01-01T00:00:02.000Z' },
    ]);

    const newChat = await service.extractSequence([nut('a1'), nut('a2')]);

    expect(contentChain(newChat!.id)).toEqual(['A1', 'A2']);
    // Source: a1 kept, a2 moved away, a3 still attached to a1.
    const ids = nodeIds(CHAT_ID);
    expect(ids).toContain('a1');
    expect(ids).toContain('a3');
    expect(ids).not.toContain('a2');
    expect(nut('a3').parentId).toBe('a1');
  });

  it('extractSequence cuts every node whose whole subtree moved', async () => {
    // q1 → a1 → a2 (nothing else): the whole selected subtree moves.
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' },
      { id: 'a2', parentId: 'a1', role: 'assistant', content: 'A2' },
    ]);

    const newChat = await service.extractSequence([nut('a1'), nut('a2')]);

    expect(contentChain(newChat!.id)).toEqual(['A1', 'A2']);
    const ids = nodeIds(CHAT_ID);
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('a2');
    // The terminal empty composer leaf is not content — it re-hangs on q1 and
    // never counts as a branch that keeps a1 alive.
    const draft = api.nodes.find(n => n.chatId === CHAT_ID && !n.deletedAt && n.parentId === 'q1');
    expect(draft).toBeDefined();
    expect(draft!.role).toBe('user');
    expect(draft!.content).toBe('');
  });

  it('extractSequence with withVisibleSubtree takes the visible continuation but not the terminal draft', async () => {
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' },
      { id: 'q2', parentId: 'a1', role: 'user', content: 'Q2' },
      { id: 'a2', parentId: 'q2', role: 'assistant', content: 'A2' },
    ]);

    const newChat = await service.extractSequence([nut('a1')], { withVisibleSubtree: true });

    // The new story continues past the selection (a1 → q2 → a2)…
    expect(contentChain(newChat!.id)).toEqual(['A1', 'Q2', 'A2']);
    // …and the empty composer leaf was NOT dragged into it.
    const newNodes = api.nodes.filter(n => n.chatId === newChat!.id);
    expect(newNodes.every(n => n.content.trim().length > 0)).toBe(true);
    // Source: everything visible moved, the empty draft stays under q1.
    const remaining = api.nodes.filter(n => n.chatId === CHAT_ID && !n.deletedAt);
    expect(remaining.map(n => n.id)).not.toContain('a1');
    const draft = remaining.find(n => n.content === '');
    expect(draft).toBeDefined();
    expect(draft!.parentId).toBe('q1');
  });

  it('extractSequence does not stage the extraction on the clipboard', async () => {
    await openSelected(chain());
    expect(service.hasContent()).toBe(false);

    await service.extractSequence([nut('a1')]);

    // Extract is not a clipboard operation — nothing is staged for pasting.
    expect(service.hasContent()).toBe(false);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });

  // --- extract: off-path branches below the selection ------------------
  //
  //   q1 → a1 → { a2 (active continuation), x (off-path sibling) }
  //
  // Whether `a1` may really move depends on that off-path sibling: an EMPTY
  // one is a placeholder (it never keeps the branch alive), one WITH content
  // does.

  /** q1 → a1 → { a2 (active), x (off-path sibling with `content`) }. */
  async function openWithOffPathSibling(content: string): Promise<void> {
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'a2', parentId: 'a1', role: 'assistant', content: 'A2', position: 1, createdAt: '2026-01-01T00:00:02.000Z' },
      { id: 'x', parentId: 'a1', role: 'user', content, position: 2, createdAt: '2026-01-01T00:00:03.000Z' },
    ]);
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    chatService.setActiveChild('a1', 'a2');
    expect(chatService.getActivePath().map(n => n.id)).toEqual(['q1', 'a1', 'a2']);
  }

  it('an EMPTY off-path sibling does not keep the selected parent in the source', async () => {
    await openWithOffPathSibling('');

    const newChat = await service.extractSequence([nut('a1'), nut('a2')]);

    expect(contentChain(newChat!.id)).toEqual(['A1', 'A2']);
    const ids = nodeIds(CHAT_ID);
    // The whole selected subtree moved: the empty off-path leaf is a
    // placeholder and never keeps a1 alive, so a1 (and a2) were really CUT.
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('a2');
    expect(ids).toContain('x');
    expect(nut('x').parentId).toBe('q1');
  });

  it('an off-path sibling WITH content keeps the selected parent in the source (copied, not cut)', async () => {
    await openWithOffPathSibling('Continue the scene');

    const newChat = await service.extractSequence([nut('a1'), nut('a2')]);

    expect(contentChain(newChat!.id)).toEqual(['A1', 'A2']);
    const ids = nodeIds(CHAT_ID);
    // Removing a1 would orphan the off-path sibling that stays behind → a1 is
    // COPIED into the new story and keeps its place here; only a2 was cut.
    expect(ids).toContain('a1');
    expect(ids).toContain('x');
    expect(ids).not.toContain('a2');
    expect(nut('x').parentId).toBe('a1');
  });

  // --- extract: GRANDPARENT above an off-path branch --------------------
  //
  //   q1 → g → p → { h1 (active), h2 (off-path) }
  //
  // Extracting only `g` leaves that whole branch behind, so `g` must be
  // COPIED. With `withVisibleSubtree` (g → p → h1) the parent `p` is still
  // copied because its off-path child h2 stays — only h1 is really cut.

  it('extract of a grandparent whose off-path branch stays behind is a copy, not a cut', async () => {
    await openGrandparentChain();

    const before = nodeIds(CHAT_ID);
    const newChat = await service.extractSequence([nut('g')]);

    expect(contentChain(newChat!.id)).toEqual(['G']);
    // The source keeps everything: g was copied and the branch below it —
    // including the off-path child — is untouched.
    expect(nodeIds(CHAT_ID)).toEqual(before);
    expect(nut('g').parentId).toBe('q1');
    expect(nut('p').parentId).toBe('g');
    expect(chatService.getChildren('p').map(n => n.id)).toEqual(['h1', 'h2']);
  });

  it('extract with withVisibleSubtree copies the parent whose off-path sibling stays behind', async () => {
    await openGrandparentChain();

    const newChat = await service.extractSequence([nut('p')], { withVisibleSubtree: true });

    // The new story gets the visible continuation p → h1…
    expect(contentChain(newChat!.id)).toEqual(['P', 'H1']);
    const ids = nodeIds(CHAT_ID);
    // …the source keeps p (its off-path child h2 stays behind) and h2…
    expect(ids).toContain('p');
    expect(ids).toContain('h2');
    // …while the fully moved leaf h1 was really cut.
    expect(ids).not.toContain('h1');
    expect(nut('p').parentId).toBe('g');
    expect(chatService.getChildren('p').map(n => n.id)).toEqual(['h2']);
  });

  // --- extract: a GRANDPARENT above an empty connector ------------------

  it('extract of a grandparent whose only child is an EMPTY placeholder really cuts it', async () => {
    // `p` is an empty childless leaf → a placeholder, never a staying branch.
    await openSelected([
      { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
      { id: 'g', parentId: 'q1', role: 'assistant', content: 'G' },
      { id: 'p', parentId: 'g', role: 'user', content: '' },
    ]);

    const newChat = await service.extractSequence([nut('g')]);

    expect(contentChain(newChat!.id)).toEqual(['G']);
    // `g` left the source; the empty placeholder was re-hung on q1.
    const ids = nodeIds(CHAT_ID);
    expect(ids).toEqual(['q1', 'p']);
    expect(nut('p').parentId).toBe('q1');
  });

  it('extractSequence adds the environment system prompt as the new story’s root', async () => {
    api = new InMemoryChatApi();
    localStorage.clear();
    seedApi(api, {
      projects: [{ id: 'p-1', name: 'Env A', mainTopicId: 't-1', systemPrompt: '' }],
      topics: [{ id: 't-1', name: 'Topic A', defaultSystemPrompt: 'You write chapters.', projectIds: ['p-1'] }],
      chats: [{ id: CHAT_ID, title: 'Story', projectId: 'p-1' }],
      nodes: [
        { id: 'q1', parentId: null, role: 'user', content: 'Q1' },
        { id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' },
      ],
    });
    await wire();
    await chatService.loadChats();
    const projects = TestBed.inject(ProjectService);
    await projects.loadProjects();
    await projects.loadTopics();
    await chatService.selectChat(CHAT_ID);

    const newChat = await service.extractSequence([nut('a1')]);

    expect(newChat).not.toBeNull();
    expect(contentChain(newChat!.id)).toEqual(['You write chapters.', 'A1']);
  });
});

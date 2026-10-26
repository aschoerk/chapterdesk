import { beforeEach, describe, expect, it } from 'vitest';
// Provide a working in-memory IndexedDB (jsdom has none) so the REAL
// IdbChatApiService runs against an actual object store / index.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IdbChatApiService } from './idb-chat-api.service';

/**
 * IdbChatApiService is the IndexedDB-backed implementation used for the
 * `indexeddb-all` / `chats-idb` / `content-idb` storage profiles. Previously
 * coverage flagged this file as ~100% purely from module evaluation, when in
 * fact NO test ever called a method. These tests exercise the real CRUD
 * against fake-indexeddb.
 */

describe('IdbChatApiService (IndexedDB data layer)', () => {
  let svc: IdbChatApiService;

  beforeEach(async () => {
    // Swap in a brand-new IDBFactory: the service keeps its connection open
    // forever (it has no close()), so a fresh factory — rather than
    // deleteDatabase, which would block on that open connection — resets state.
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    svc = new IdbChatApiService();
    // The eager dbPromise opened on construction must be resolved before use.
    await svc.getProjects(); // touch the db (projects store is empty)
  });

  describe('projects', () => {
    it('creates, lists, updates and deletes a project', async () => {
      const created = await svc.createProject({ name: 'Alpha', greeting: 'Hi', topicIds: [] });
      expect(created.id).toBeTruthy();
      expect(created.name).toBe('Alpha');

      const list = await svc.getProjects();
      expect(list).toHaveLength(1);
      expect(list[0].greeting).toBe('Hi');

      const updated = await svc.updateProject(created.id, { name: 'Beta' });
      expect(updated.name).toBe('Beta');
      expect((await svc.getProjects())[0].name).toBe('Beta');

      await svc.deleteProject(created.id);
      expect(await svc.getProjects()).toEqual([]);
    });

    it('throws 404 when updating a missing project', async () => {
      await expect(svc.updateProject('missing', { name: 'X' })).rejects.toThrow();
    });

    it('deleteProject with deleteChats=true removes the chats', async () => {
      const p = await svc.createProject({ name: 'P', greeting: '' });
      const c = await svc.createChat('Under', p.id);
      await svc.deleteProject(p.id, true);
      expect(await svc.getProjects()).toEqual([]);
      expect((await svc.getChats()).some((x) => x.id === c.id)).toBe(false);
    });

    it('deleteProject without deleteChats detaches the chats', async () => {
      const p = await svc.createProject({ name: 'P', greeting: '' });
      const c = await svc.createChat('Under', p.id);
      await svc.deleteProject(p.id);
      const chats = await svc.getChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].projectId).toBeNull();
    });
  });

  describe('chats', () => {
    it('lists newest-first and searches by title / node content', async () => {
      const first = await svc.createChat('Older');
      // Ensure a distinctly newer updated_at so the ordering assertion is stable
      // (timestamps have ms precision and IDB writes are fast).
      await new Promise((r) => setTimeout(r, 5));
      const second = await svc.createChat('Motley Crue');
      const list = await svc.getChats();
      expect(list.map((c) => c.id)).toEqual([second.id, first.id]); // newest first

      expect(await svc.searchChatIds('motley')).toEqual([second.id]);
      expect(await svc.searchChatIds('   ')).toEqual([]);
    });

    it('searches current node content', async () => {
      const chat = await svc.createChat('Chat');
      await svc.createNode(chat.id, { role: 'user', content: 'needle here' });
      expect(await svc.searchChatIds('needle')).toEqual([chat.id]);
    });

    it('patches title / project / lore / autoExcludeDirections', async () => {
      const chat = await svc.createChat('Title');
      const updated = await svc.patchChat(chat.id, {
        title: 'Renamed',
        lore: 'lore text',
        autoExcludeDirections: true,
      });
      expect(updated.title).toBe('Renamed');
      expect(updated.lore).toBe('lore text');
      expect(updated.autoExcludeDirections).toBe(true);
    });

    it('cloneChat deep-copies nodes with remapped ids', async () => {
      const chat = await svc.createChat('Original');
      const q = await svc.createNode(chat.id, { role: 'user', content: 'Q?' });
      await svc.createNode(chat.id, { role: 'assistant', content: 'A.', parentId: q.id });

      const copy = await svc.cloneChat(chat.id);
      expect(copy.id).not.toBe(chat.id);
      expect(copy.title).toContain('(copy)');
      const nodes = await svc.getNodes(copy.id);
      expect(nodes).toHaveLength(2);
      const q2 = nodes.find((n) => n.role === 'user')!;
      const a2 = nodes.find((n) => n.role === 'assistant')!;
      expect(a2.parentId).toBe(q2.id);
      expect(a2.content).toBe('A.');
      // Original untouched.
      expect(await svc.getNodes(chat.id)).toHaveLength(2);
    });

    it('cloneChat throws on a missing chat', async () => {
      const chat = await svc.createChat('X');
      await svc.deleteChat(chat.id);
      await expect(svc.cloneChat(chat.id)).rejects.toThrow();
    });

    it('deleteChat removes the chat and its nodes', async () => {
      const chat = await svc.createChat('X');
      await svc.createNode(chat.id, { role: 'user', content: 'c' });
      await svc.deleteChat(chat.id);
      expect((await svc.getChats()).some((c) => c.id === chat.id)).toBe(false);
      expect(await svc.getNodes(chat.id)).toEqual([]);
    });
  });

  describe('nodes', () => {
    it('creates and lists nodes ordered by position then creation', async () => {
      const chat = await svc.createChat('C');
      const root = await svc.createNode(chat.id, { role: 'user', content: 'root', position: 1 });
      const a = await svc.createNode(chat.id, { role: 'assistant', content: 'A', parentId: root.id, position: 2 });
      const b = await svc.createNode(chat.id, { role: 'user', content: 'b', parentId: root.id, position: 3 });
      const c = await svc.createNode(chat.id, { role: 'user', content: 'c', parentId: root.id, position: 4 });
      const nodes = await svc.getNodes(chat.id);
      expect(nodes.map((n) => n.content)).toEqual(['root', 'A', 'b', 'c']);
      expect(nodes.find((n) => n.id === b.id)!.parentId).toBe(root.id);
      expect(nodes.find((n) => n.id === c.id)!.parentId).toBe(root.id);
      expect(nodes.find((n) => n.id === a.id)!.parentId).toBe(root.id);
      // Nodes without positions fall back to creation order (distinct timestamps
      // via a small delay, since index getAll returns by primary key on ties).
      const chat2 = await svc.createChat('C2');
      const q = await svc.createNode(chat2.id, { role: 'user', content: 'q' });
      await new Promise((r) => setTimeout(r, 5));
      await svc.createNode(chat2.id, { role: 'assistant', content: 'a', parentId: q.id });
      const list2 = await svc.getNodes(chat2.id);
      expect(list2.map((n) => n.content)).toEqual(['q', 'a']);
    });

    it('reorderSiblings persists the given order and filters to the parent', async () => {
      const chat = await svc.createChat('R');
      const root = await svc.createNode(chat.id, { role: 'user', content: 'root' });
      const n1 = await svc.createNode(chat.id, { role: 'user', content: '1', parentId: root.id });
      const n2 = await svc.createNode(chat.id, { role: 'user', content: '2', parentId: root.id });
      const n3 = await svc.createNode(chat.id, { role: 'user', content: '3', parentId: root.id });

      const ordered = await svc.reorderSiblings(chat.id, root.id, [n3.id, n1.id, n2.id]);
      expect(ordered.map((n) => n.id)).toEqual([n3.id, n1.id, n2.id]);
      const again = await svc.getNodes(chat.id);
      const siblings = again.filter((n) => n.parentId === root.id);
      expect(siblings.map((n) => n.id)).toEqual([n3.id, n1.id, n2.id]);
    });

    it('editAssistant / editUser create a new version and reparent children', async () => {
      const chat = await svc.createChat('V');
      const q = await svc.createNode(chat.id, { role: 'user', content: 'Q?' });
      const a = await svc.createNode(chat.id, { role: 'assistant', content: 'Old A', parentId: q.id });
      await svc.createNode(chat.id, { role: 'user', content: 'child', parentId: a.id });

      const v2 = await svc.editAssistant(chat.id, a.id, 'New A', undefined, 'thinking');
      expect(v2.id).not.toBe(a.id);
      expect(v2.content).toBe('New A');
      expect(v2.thinking).toBe('thinking');

      const nodes = await svc.getNodes(chat.id);
      const child = nodes.find((n) => n.content === 'child')!;
      expect(child.parentId).toBe(v2.id);

      const u2 = await svc.editUser(chat.id, q.id, 'New Q');
      expect(u2.id).not.toBe(q.id);
      expect(u2.content).toBe('New Q');
    });

    it('branchUser adds a sibling question at the parent, rejects non-user nodes', async () => {
      const chat = await svc.createChat('B');
      const q = await svc.createNode(chat.id, { role: 'user', content: 'Q?' });
      const a = await svc.createNode(chat.id, { role: 'assistant', content: 'A.', parentId: q.id });
      const branch = await svc.branchUser(chat.id, q.id, { content: 'B?' });
      expect(branch.parentId).toBeNull(); // q was root
      await expect(svc.branchUser(chat.id, a.id, { content: 'nope' })).rejects.toThrow();
    });

    it('patchNode updates content and validates reparent cycles', async () => {
      const chat = await svc.createChat('P');
      const root = await svc.createNode(chat.id, { role: 'user', content: 'root' });
      const other = await svc.createNode(chat.id, { role: 'user', content: 'other' });
      const child = await svc.createNode(chat.id, { role: 'user', content: 'child', parentId: root.id });

      const patched = await svc.patchNode(chat.id, child.id, { content: 'patched' });
      expect(patched.content).toBe('patched');

      await expect(svc.patchNode(chat.id, child.id, { parentId: child.id })).rejects.toThrow();
      await expect(svc.patchNode(chat.id, root.id, { parentId: child.id })).rejects.toThrow();
      await expect(svc.patchNode(chat.id, other.id, { parentId: 'missing' })).rejects.toThrow();
    });

    it('soft-deletes a subtree, lists deleted roots, restores and purges', async () => {
      const chat = await svc.createChat('T');
      const q = await svc.createNode(chat.id, { role: 'user', content: 'Q' });
      const a = await svc.createNode(chat.id, { role: 'assistant', content: 'A', parentId: q.id });
      const child = await svc.createNode(chat.id, { role: 'user', content: 'C', parentId: a.id });

      await svc.deleteNode(chat.id, a.id);
      expect((await svc.getNodes(chat.id)).some((n) => n.id === a.id)).toBe(false);
      expect((await svc.getNodes(chat.id)).some((n) => n.id === child.id)).toBe(false);
      expect(await svc.getDeletedNodes(chat.id)).toHaveLength(1);

      await svc.restoreNode(chat.id, a.id);
      expect((await svc.getNodes(chat.id)).some((n) => n.id === child.id)).toBe(true);
      expect(await svc.getDeletedNodes(chat.id)).toEqual([]);

      await svc.deleteNode(chat.id, a.id);
      await svc.purgeNode(chat.id, a.id);
      expect(await svc.getDeletedNodes(chat.id)).toEqual([]);
      expect((await svc.getNodes(chat.id)).some((n) => n.id === a.id)).toBe(false);
    });

    it('deleteNode with keepChildren reparents the children', async () => {
      const chat = await svc.createChat('K');
      const q = await svc.createNode(chat.id, { role: 'user', content: 'Q' });
      const a = await svc.createNode(chat.id, { role: 'assistant', content: 'A', parentId: q.id });
      const child = await svc.createNode(chat.id, { role: 'user', content: 'C', parentId: a.id });

      await svc.deleteNode(chat.id, a.id, { keepChildren: true });
      const nodes = await svc.getNodes(chat.id);
      expect(nodes.some((n) => n.id === a.id)).toBe(false);
      expect(nodes.find((n) => n.id === child.id)!.parentId).toBe(q.id);
    });
  });

  describe('personas / topics / providers / models / parameters', () => {
    it('personas CRUD', async () => {
      const p = await svc.createPersona({ name: 'Hero', shortName: 'H', description: 'protagonist' });
      expect(p.name).toBe('Hero');
      const updated = await svc.updatePersona(p.id, { description: 'lead' });
      expect(updated.description).toBe('lead');
      expect(await svc.getPersonas()).toHaveLength(1);
      await svc.deletePersona(p.id);
      expect(await svc.getPersonas()).toEqual([]);
    });

    it('topics CRUD + project membership', async () => {
      const t = await svc.createTopic({ name: 'World', description: 'd' });
      const p = await svc.createProject({ name: 'P', greeting: '' });
      const withProject = await svc.addProjectToTopic(t.id, p.id);
      expect(withProject.projectIds).toContain(p.id);

      const removed = await svc.removeProjectFromTopic(t.id, p.id);
      expect(removed.projectIds).not.toContain(p.id);

      const updated = await svc.updateTopic(t.id, { description: 'new' });
      expect(updated.description).toBe('new');
      await svc.deleteTopic(t.id);
      expect(await svc.getTopics()).toEqual([]);
    });

    it('providers + models CRUD and toggle', async () => {
      const prov = await svc.createProvider({
        name: 'P',
        type: 'custom',
        baseUrl: 'http://p',
        apiKey: 'k',
        enabled: true,
      });
      expect((await svc.getProviders())[0].id).toBe(prov.id);

      const model = await svc.createModel({
        displayName: 'Model',
        modelId: 'm/1',
        providerId: prov.id,
        type: 'preset',
        enabled: true,
      });
      expect((await svc.getModels())[0].displayName).toBe('Model');

      const toggled = await svc.toggleModelEnabled(model.id);
      expect(toggled.enabled).toBe(false);

      const updated = await svc.updateModel(model.id, { displayName: 'Model 2' });
      expect(updated.displayName).toBe('Model 2');

      await svc.deleteModel(model.id);
      expect(await svc.getModels()).toEqual([]);
      await svc.deleteProvider(prov.id);
      expect(await svc.getProviders()).toEqual([]);
    });

    it('chatParameters CRUD and deletion clears owners', async () => {
      const params = await svc.createChatParameters({
        name: 'Creative',
        temperature: 0.7,
        topK: 50,
        topM: 0.9,
        stream: true,
        thinking: true,
        thinkingLevel: 'high',
      });
      expect(params.temperature).toBe(0.7);
      expect((await svc.getChatParameters())[0].id).toBe(params.id);
      expect((await svc.getChatParameter(params.id)).id).toBe(params.id);

      const updated = await svc.updateChatParameters(params.id, {
        temperature: 0.2,
        topK: 10,
        topM: 0.5,
        stream: false,
        thinking: false,
        thinkingLevel: 'low',
      });
      expect(updated.temperature).toBe(0.2);

      const project = await svc.createProject({ name: 'Owns', greeting: '', chatParametersId: params.id });
      await svc.deleteChatParameters(params.id);
      expect((await svc.getProjects()).find((p) => p.id === project.id)?.chatParametersId).toBeNull();
      expect(await svc.getChatParameters()).toEqual([]);
    });
  });

  describe('usage persistence', () => {
    it('saveChatUsage writes per-node usage and recomputes chat totals', async () => {
      const chat = await svc.createChat('Usage');
      const q = await svc.createNode(chat.id, { role: 'user', content: 'Q' });
      const a = await svc.createNode(chat.id, { role: 'assistant', content: 'A', parentId: q.id });

      const updated = await svc.saveChatUsage(chat.id, [
        { nodeId: a.id, usage: { input: 100, output: 50, total: 150, cost: 0.01 } },
      ]);
      expect(updated.promptTokens).toBe(100);
      expect(updated.completionTokens).toBe(50);
      expect(updated.totalCost).toBeCloseTo(0.01);
    });
  });
});
import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import {
  provideHttpClientTesting,
  HttpTestingController,
} from '@angular/common/http/testing';
import { ChatApiService } from './chat-api.service';

/**
 * ChatApiService is the thin HTTP client used by CompositeChatApiService for
 * the `sqlite-all` storage profile. These tests drive the real HttpClient with
 * HttpTestingController so every request method/URL/body is asserted. This is
 * the "fake 100%" file flagged by coverage: previously NO spec actually called
 * the service (all specs override CHAT_API with InMemoryChatApi).
 */

describe('ChatApiService (HTTP data layer)', () => {
  let service: ChatApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(ChatApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it('builds URLs under /api and GETs projects', async () => {
    const promise = service.getProjects();
    const req = http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/projects'));
    req.flush([{ id: 'p1', name: 'P' }]);
    const projects = await promise;
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('p1');
  });

  it('POSTs project create with the request body', async () => {
    const promise = service.createProject({ name: 'New', greeting: 'Hi' });
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/projects'));
    expect(req.request.body).toEqual({ name: 'New', greeting: 'Hi' });
    req.flush({ id: 'p2', name: 'New', greeting: 'Hi' });
    await expect(promise).resolves.toMatchObject({ id: 'p2' });
  });

  it('PUTs project update', async () => {
    const promise = service.updateProject('p1', { name: 'Renamed' });
    const req = http.expectOne((r) => r.method === 'PUT' && r.url.endsWith('/api/projects/p1'));
    req.flush({ id: 'p1', name: 'Renamed' });
    await expect(promise).resolves.toMatchObject({ name: 'Renamed' });
  });

  it('DELETEs a project, appending deleteChats when requested', async () => {
    const plain = service.deleteProject('p1');
    const req1 = http.expectOne((r) => r.method === 'DELETE' && r.url.endsWith('/api/projects/p1'));
    req1.flush(null);
    await plain;

    const withChats = service.deleteProject('p1', true);
    const req2 = http.expectOne((r) => r.method === 'DELETE' && r.url.endsWith('/api/projects/p1?deleteChats=true'));
    req2.flush(null);
    await withChats;
  });

  it('gets chats and searches chat ids with a q param', async () => {
    const chats = service.getChats();
    const req = http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/chats'));
    req.flush([{ id: 'c1', title: 'Chat' }]);
    await expect(chats).resolves.toHaveLength(1);

    const search = service.searchChatIds('needle');
    const sreq = http.expectOne(
      (r) => r.method === 'GET' && r.url.endsWith('/api/chats/search-ids') && r.params.get('q') === 'needle',
    );
    sreq.flush(['c1']);
    await expect(search).resolves.toEqual(['c1']);
  });

  it('searchChatIds short-circuits on an empty query', async () => {
    await expect(service.searchChatIds('   ')).resolves.toEqual([]);
  });

  it('creates, clones, patches and deletes chats', async () => {
    const create = service.createChat('Title', 'proj-1');
    const creq = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats'));
    expect(creq.request.body).toEqual({ title: 'Title', projectId: 'proj-1' });
    creq.flush({ id: 'c1', title: 'Title' });
    await expect(create).resolves.toMatchObject({ id: 'c1' });

    const clone = service.cloneChat('c1');
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats/c1/clone')).flush({ id: 'c2' });
    await expect(clone).resolves.toMatchObject({ id: 'c2' });

    const patch = service.patchChat('c1', { title: 'New' });
    const preq = http.expectOne((r) => r.method === 'PATCH' && r.url.endsWith('/api/chats/c1'));
    expect(preq.request.body).toEqual({ title: 'New' });
    preq.flush({ id: 'c1', title: 'New' });
    await expect(patch).resolves.toMatchObject({ title: 'New' });

    const del = service.deleteChat('c1');
    http.expectOne((r) => r.method === 'DELETE' && r.url.endsWith('/api/chats/c1')).flush(null);
    await del;
  });

  it('manages nodes: get/create/reorder/edit-assistant/edit-user/branch/patch/delete', async () => {
    const nodes = service.getNodes('c1');
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/chats/c1/nodes')).flush([]);
    await expect(nodes).resolves.toEqual([]);

    const create = service.createNode('c1', { role: 'user', content: 'Q?' });
    const creq = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats/c1/nodes'));
    expect(creq.request.body).toMatchObject({ role: 'user', content: 'Q?' });
    creq.flush({ id: 'n1', role: 'user', content: 'Q?' });
    await expect(create).resolves.toMatchObject({ id: 'n1' });

    const reorder = service.reorderSiblings('c1', null, ['n2', 'n1']);
    const rreq = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats/c1/nodes/reorder'));
    expect(rreq.request.body).toEqual({ parentId: null, orderedNodeIds: ['n2', 'n1'] });
    rreq.flush([{ id: 'n2' }, { id: 'n1' }]);
    await expect(reorder).resolves.toHaveLength(2);

    const editA = service.editAssistant('c1', 'n1', 'new A', undefined, 'thinking', undefined);
    const areq = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats/c1/nodes/n1/edit-assistant'));
    expect(areq.request.body).toMatchObject({ content: 'new A', thinking: 'thinking' });
    areq.flush({ id: 'n1-v2', content: 'new A' });
    await expect(editA).resolves.toMatchObject({ content: 'new A' });

    const editU = service.editUser('c1', 'n1', 'new Q');
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats/c1/nodes/n1/edit-user')).flush({ id: 'n1-v2' });
    await expect(editU).resolves.toBeTruthy();

    const branch = service.branchUser('c1', 'n1', { content: 'Branch' });
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats/c1/nodes/n1/branch-user')).flush({ id: 'nB' });
    await expect(branch).resolves.toMatchObject({ id: 'nB' });

    const patch = service.patchNode('c1', 'n1', { content: 'Patched' });
    const preq = http.expectOne((r) => r.method === 'PATCH' && r.url.endsWith('/api/chats/c1/nodes/n1'));
    expect(preq.request.body).toEqual({ content: 'Patched' });
    preq.flush({ id: 'n1', content: 'Patched' });
    await expect(patch).resolves.toMatchObject({ content: 'Patched' });

    const del = service.deleteNode('c1', 'n1', { keepChildren: true });
    http.expectOne((r) => r.method === 'DELETE' && r.url.endsWith('/api/chats/c1/nodes/n1?keepChildren=true')).flush(null);
    await del;
  });

  it('handles trash: get deleted, restore, purge', async () => {
    const deleted = service.getDeletedNodes('c1');
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/chats/c1/nodes/deleted')).flush([{ id: 'n1' }]);
    await expect(deleted).resolves.toHaveLength(1);

    const restore = service.restoreNode('c1', 'n1');
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/chats/c1/nodes/n1/restore')).flush(null);
    await restore;

    const purge = service.purgeNode('c1', 'n1');
    http.expectOne((r) => r.method === 'DELETE' && r.url.endsWith('/api/chats/c1/nodes/n1/purge')).flush(null);
    await purge;
  });

  it('manages personas, topics and providers/models and chat-parameters', async () => {
    const personas = service.getPersonas();
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/personas')).flush([]);
    await expect(personas).resolves.toEqual([]);

    const createPersona = service.createPersona({ name: 'Hero', shortName: 'Hero' });
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/personas')).flush({ id: 'pe1' });
    await expect(createPersona).resolves.toBeTruthy();

    const updatePersona = service.updatePersona('pe1', { description: 'd' });
    http.expectOne((r) => r.method === 'PUT' && r.url.endsWith('/api/personas/pe1')).flush({ id: 'pe1' });
    await expect(updatePersona).resolves.toBeTruthy();

    const deletePersona = service.deletePersona('pe1');
    http.expectOne((r) => r.method === 'DELETE' && r.url.endsWith('/api/personas/pe1')).flush(null);
    await deletePersona;

    const topics = service.getTopics();
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/topics')).flush([]);
    await expect(topics).resolves.toEqual([]);

    const createTopic = service.createTopic({ name: 'T' });
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/topics')).flush({ id: 't1' });
    await expect(createTopic).resolves.toMatchObject({ id: 't1' });

    const providers = service.getProviders();
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/providers')).flush([]);
    await expect(providers).resolves.toEqual([]);

    const models = service.getModels();
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/models')).flush([]);
    await expect(models).resolves.toEqual([]);

    const getParams = service.getChatParameters();
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/chat-parameters')).flush([]);
    await expect(getParams).resolves.toEqual([]);
  });

  it('propagates a non-2xx response as a rejected promise', async () => {
    const promise = service.getProjects();
    const req = http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/projects'));
    req.flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    await expect(promise).rejects.toBeTruthy();
  });
});
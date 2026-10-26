/**
 * Coverage gap-closing tests for chapterdesk-api-server endpoints that no
 * existing suite exercised:
 *   - GET  /api/health
 *   - GET  /api/chats/search-ids
 *   - POST /api/chats/:id/clone
 *   - POST /api/chats/:id/nodes/reorder
 *   - GET  /api/chat-parameters?ownerType=&ownerId= (topic/chat/model/chat_node
 *     lookups + 400 validation)
 *   - PUT  /api/models/:id
 *   - DELETE /api/projects/:id?deleteChats=true
 *
 * Each test starts from a fresh in-memory SQLite database (like
 * node-edit-ops.test.ts).
 */

import { beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeApp } from './helpers/app.js';

let app: Express;

beforeEach(async () => {
  ({ app } = await makeApp());
});

async function createChat(title: string): Promise<string> {
  const res = await request(app).post('/api/chats').send({ title });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function addNode(
  chatId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; [k: string]: unknown }> {
  const res = await request(app).post(`/api/chats/${chatId}/nodes`).send(body);
  expect(res.status).toBe(201);
  return res.body;
}

async function createParameters(name: string, temperature: number): Promise<string> {
  const res = await request(app).post('/api/chat-parameters').send({ name, temperature });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('GET /api/health', () => {
  test('reports ok and the persistence kind', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.persistence).toBe('string');
    expect(res.body.persistence.length).toBeGreaterThan(0);
  });
});

describe('GET /api/chats/search-ids', () => {
  test('finds a chat by title fragment', async () => {
    const id = await createChat('Unicorn Quest');
    const res = await request(app).get('/api/chats/search-ids?q=Unicorn');
    expect(res.status).toBe(200);
    expect(res.body).toContain(id);
  });

  test('finds a chat by current node content', async () => {
    const id = await createChat('Node Search Chat');
    await addNode(id, { content: 'needle-in-the-haystack', role: 'user' });
    const res = await request(app).get('/api/chats/search-ids?q=needle-in-the');
    expect(res.status).toBe(200);
    expect(res.body).toContain(id);
  });

  test('does not match soft-deleted nodes', async () => {
    const id = await createChat('Trash search chat');
    const node = await addNode(id, { content: 'bury-me', role: 'user' });
    await request(app).delete(`/api/chats/${id}/nodes/${node.id}`);

    const res = await request(app).get('/api/chats/search-ids?q=bury-me');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(id);
  });

  test('returns [] for an empty query and for no matches', async () => {
    await createChat('Search absent chat');
    const empty = await request(app).get('/api/chats/search-ids');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const blank = await request(app).get('/api/chats/search-ids?q=%20%20');
    expect(blank.status).toBe(200);
    expect(blank.body).toEqual([]);

    const none = await request(app).get('/api/chats/search-ids?q=zzz-no-such-content');
    expect(none.status).toBe(200);
    expect(none.body).toEqual([]);
  });
});

describe('POST /api/chats/:id/clone', () => {
  test('deep-copies the chat tree under fresh ids', async () => {
    const id = await createChat('Cloneable Story');
    const q = await addNode(id, { content: 'Who goes there?', role: 'user' });
    const a = await addNode(id, { content: 'A friend.', role: 'assistant', parentId: q.id });

    const res = await request(app).post(`/api/chats/${id}/clone`);
    expect(res.status).toBe(201);
    const copy = res.body;
    expect(copy.id).not.toBe(id);
    expect(copy.title).toContain('Cloneable Story');

    const copyNodes = await request(app).get(`/api/chats/${copy.id}/nodes`);
    expect(copyNodes.status).toBe(200);
    expect(copyNodes.body).toHaveLength(2);
    const copyQ = copyNodes.body.find((n: { role: string }) => n.role === 'user');
    const copyA = copyNodes.body.find((n: { role: string }) => n.role === 'assistant');
    expect(copyQ.id).not.toBe(q.id);
    expect(copyA.id).not.toBe(a.id);
    expect(copyA.parentId).toBe(copyQ.id);
    expect(copyQ.content).toBe('Who goes there?');
    expect(copyA.content).toBe('A friend.');

    // The original chat is untouched.
    const origNodes = await request(app).get(`/api/chats/${id}/nodes`);
    expect(origNodes.status).toBe(200);
    expect(origNodes.body).toHaveLength(2);
    expect(origNodes.body[0].id).toBe(q.id);
  });

  test('404 when the chat does not exist', async () => {
    const res = await request(app).post('/api/chats/missing/clone');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chats/:id/nodes/reorder', () => {
  test('persists the requested sibling order', async () => {
    const id = await createChat('Reorder Chat');
    const q = await addNode(id, { content: 'Q?', role: 'user' });
    const a = await addNode(id, { content: 'A.', role: 'assistant', parentId: q.id });
    const u1 = await addNode(id, { content: 'U1', role: 'user', parentId: a.id });
    const u2 = await addNode(id, { content: 'U2', role: 'user', parentId: a.id });
    const u3 = await addNode(id, { content: 'U3', role: 'user', parentId: a.id });

    const res = await request(app)
      .post(`/api/chats/${id}/nodes/reorder`)
      .send({ parentId: a.id, orderedNodeIds: [u3.id, u1.id, u2.id] });
    expect(res.status).toBe(200);
    expect(res.body.map((n: { id: string }) => n.id)).toEqual([u3.id, u1.id, u2.id]);

    // Re-query: the order is persisted, not just reported.
    const again = await request(app).get(`/api/chats/${id}/nodes`);
    const siblings = again.body.filter(
      (n: { parentId: string | null }) => n.parentId === a.id,
    );
    expect(siblings.map((n: { id: string }) => n.id)).toEqual([u3.id, u1.id, u2.id]);
  });

  test('reorder at the root (parentId null)', async () => {
    const id = await createChat('Root Reorder');
    const r1 = await addNode(id, { content: 'R1', role: 'user' });
    const r2 = await addNode(id, { content: 'R2', role: 'user' });
    const r3 = await addNode(id, { content: 'R3', role: 'user' });

    const res = await request(app)
      .post(`/api/chats/${id}/nodes/reorder`)
      .send({ parentId: null, orderedNodeIds: [r3.id, r2.id, r1.id] });
    expect(res.status).toBe(200);
    expect(res.body.map((n: { id: string }) => n.id)).toEqual([r3.id, r2.id, r1.id]);

    const again = await request(app).get(`/api/chats/${id}/nodes`);
    const roots = again.body.filter(
      (n: { parentId: string | null }) => n.parentId === null,
    );
    expect(roots.map((n: { id: string }) => n.id)).toEqual([r3.id, r2.id, r1.id]);
  });
});

describe('GET /api/chat-parameters owner lookup', () => {
  test('ownerType=project finds the project-owned set', async () => {
    const pid = await createParameters('Owner project params', 0.5);
    const project = await request(app)
      .post('/api/projects')
      .send({ name: 'Owner project', chatParametersId: pid });
    expect(project.status).toBe(201);

    const res = await request(app).get(
      `/api/chat-parameters?ownerType=project&ownerId=${project.body.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([pid]);
  });

  test('ownerType=topic finds the topic-owned set', async () => {
    const pid = await createParameters('Owner topic params', 0.5);
    const topic = await request(app)
      .post('/api/topics')
      .send({ name: 'Owner topic', chatParametersId: pid });
    expect(topic.status).toBe(201);

    const res = await request(app).get(
      `/api/chat-parameters?ownerType=topic&ownerId=${topic.body.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([pid]);
  });

  test('ownerType=chat finds the chat-owned set (nested create)', async () => {
    const chat = await request(app).post('/api/chats').send({
      title: 'Owner chat',
      chatParameters: { temperature: 0.3 },
    });
    expect(chat.status).toBe(201);
    const cpid = chat.body.chatParametersId as string;
    expect(cpid).toBeTruthy();

    const res = await request(app).get(
      `/api/chat-parameters?ownerType=chat&ownerId=${chat.body.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([cpid]);
  });

  test('ownerType=model finds the model-owned set (attached via PUT)', async () => {
    const provider = await request(app).post('/api/providers').send({
      name: 'Owner provider',
      type: 'custom',
      baseUrl: 'http://p',
      apiKey: 'k',
    });
    const model = await request(app).post('/api/models').send({
      displayName: 'Owner model',
      modelId: 'm/owner',
      providerId: provider.body.id,
      type: 'preset',
    });
    const pid = await createParameters('Owner model params', 0.6);
    const updated = await request(app)
      .put(`/api/models/${model.body.id}`)
      .send({ chatParametersId: pid });
    expect(updated.status).toBe(200);

    const res = await request(app).get(
      `/api/chat-parameters?ownerType=model&ownerId=${model.body.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([pid]);
  });

  test('ownerType=chat_node finds the node-owned set', async () => {
    const chatId = await createChat('Node owner chat');
    const pid = await createParameters('Owner node params', 0.7);
    const node = await addNode(chatId, { content: 'Q?', role: 'user', chatParametersId: pid });

    const res = await request(app).get(
      `/api/chat-parameters?ownerType=chat_node&ownerId=${node.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([pid]);
  });

  test('unknown owner resolves to an empty list', async () => {
    const res = await request(app).get('/api/chat-parameters?ownerType=project&ownerId=missing-id');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('ownerType without ownerId is a 400', async () => {
    const res = await request(app).get('/api/chat-parameters?ownerType=project');
    expect(res.status).toBe(400);
  });

  test('ownerId without ownerType is a 400', async () => {
    const res = await request(app).get('/api/chat-parameters?ownerId=abc');
    expect(res.status).toBe(400);
  });

  test('invalid ownerType is a 400', async () => {
    const res = await request(app).get('/api/chat-parameters?ownerType=bogus&ownerId=abc');
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/models/:id', () => {
  test('updates display fields, type, enabled and parameters', async () => {
    const provider = await request(app).post('/api/providers').send({
      name: 'Update provider',
      type: 'custom',
      baseUrl: 'http://p',
      apiKey: 'k',
    });
    const model = await request(app).post('/api/models').send({
      displayName: 'Before',
      modelId: 'm/before',
      providerId: provider.body.id,
      type: 'preset',
      contextLength: 8000,
    });
    const pid = await createParameters('Update model params', 0.9);

    const res = await request(app).put(`/api/models/${model.body.id}`).send({
      displayName: 'After',
      modelId: 'm/after',
      type: 'discontinued',
      enabled: false,
      contextLength: 16000,
      description: 'updated description',
      chatParametersId: pid,
    });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('After');
    expect(res.body.modelId).toBe('m/after');
    expect(res.body.type).toBe('discontinued');
    expect(res.body.enabled).toBe(false);
    expect(res.body.contextLength).toBe(16000);
    expect(res.body.description).toBe('updated description');
    expect(res.body.chatParametersId).toBe(pid);
  });

  test('404 for an unknown model', async () => {
    const res = await request(app).put('/api/models/missing').send({ displayName: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  test('?deleteChats=true removes the project and its chats', async () => {
    const project = await request(app).post('/api/projects').send({ name: 'Doomed project' });
    expect(project.status).toBe(201);
    const chat = await request(app)
      .post('/api/chats')
      .send({ title: 'under project', projectId: project.body.id });
    expect(chat.status).toBe(201);

    const res = await request(app).delete(`/api/projects/${project.body.id}?deleteChats=true`);
    expect(res.status).toBe(204);
    expect((await request(app).get(`/api/projects/${project.body.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/chats/${chat.body.id}`)).status).toBe(404);
  });

  test('without deleteChats the chats survive but are detached from the project', async () => {
    const project = await request(app).post('/api/projects').send({ name: 'Kept project' });
    expect(project.status).toBe(201);
    const chat = await request(app)
      .post('/api/chats')
      .send({ title: 'kept chat', projectId: project.body.id });
    expect(chat.status).toBe(201);

    const res = await request(app).delete(`/api/projects/${project.body.id}`);
    expect(res.status).toBe(204);
    expect((await request(app).get(`/api/projects/${project.body.id}`)).status).toBe(404);

    const after = await request(app).get(`/api/chats/${chat.body.id}`);
    expect(after.status).toBe(200);
    expect(after.body.projectId).toBeNull();
  });
});
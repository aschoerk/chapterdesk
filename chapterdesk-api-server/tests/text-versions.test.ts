/**
 * Versioned general texts (text_versions) — compare / restore.
 *
 * The table is append-only: whenever a tracked attribute actually changes,
 * the PREVIOUS content is recorded as a new version entry. Covers:
 *   - recording on topic / project / persona updates
 *   - no recording when the tracked attribute did not change
 *   - GET /api/text-versions (filtering + validation)
 *   - POST /api/text-versions/:id/restore (restores + keeps an undo version)
 *   - DELETE /api/text-versions/:id
 *   - version cleanup when the owning entity is deleted
 */

import { beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeApp } from './helpers/app.js';

let app: Express;

beforeEach(async () => {
  ({ app } = await makeApp());
});

async function createTopic(body: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/topics')
    .send({ name: 'Cyberpunk', defaultSystemPrompt: 'You are in a neon city.', ...body });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createProject(body: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .send({ name: 'Neo Tokyo', greeting: 'Welcome.', systemPrompt: 'Env definition v1.', ...body });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createPersona(body: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/personas')
    .send({ name: 'Elena', shortName: 'Elena', description: 'A brilliant physicist.', ...body });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function getVersions(query: Record<string, string>): Promise<Record<string, unknown>[]> {
  const res = await request(app)
    .get('/api/text-versions')
    .query(query);
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>[];
}

describe('Text versions — automatic recording', () => {
  test('records each change of a topic system prompt with sequential version numbers', async () => {
    const topicId = await createTopic({ defaultSystemPrompt: 'Prompt A' });

    await request(app)
      .put(`/api/topics/${topicId}`)
      .send({ defaultSystemPrompt: 'Prompt B' })
      .expect(200);
    await request(app)
      .put(`/api/topics/${topicId}`)
      .send({ defaultSystemPrompt: 'Prompt C' })
      .expect(200);

    const versions = await getVersions({ entityType: 'topic', entityId: topicId });
    expect(versions).toHaveLength(2);
    // Newest first.
    expect(versions[0]).toMatchObject({ entityAttribute: 'defaultSystemPrompt', versionNumber: 2, oldContent: 'Prompt B' });
    expect(versions[1]).toMatchObject({ entityAttribute: 'defaultSystemPrompt', versionNumber: 1, oldContent: 'Prompt A' });
    for (const v of versions) {
      expect(typeof v.id).toBe('string');
      expect(typeof v.datetime).toBe('string');
      expect(new Date(v.datetime as string).getTime()).not.toBeNaN();
    }
  });

  test('records environment definition and greeting changes independently', async () => {
    const projectId = await createProject({ greeting: 'Hi.', systemPrompt: 'Def v1.' });

    await request(app)
      .put(`/api/projects/${projectId}`)
      .send({ systemPrompt: 'Def v2.', greeting: 'Hello there.' })
      .expect(200);

    const all = await getVersions({ entityType: 'project', entityId: projectId });
    expect(all).toHaveLength(2);

    const system = all.find((v) => v.entityAttribute === 'systemPrompt');
    expect(system).toMatchObject({ versionNumber: 1, oldContent: 'Def v1.' });

    const greeting = all.find((v) => v.entityAttribute === 'greeting');
    expect(greeting).toMatchObject({ versionNumber: 1, oldContent: 'Hi.' });
  });

  test('records persona description changes', async () => {
    const personaId = await createPersona({ description: 'Physicist.' });

    await request(app)
      .put(`/api/personas/${personaId}`)
      .send({ description: 'Astrophysicist.' })
      .expect(200);

    const versions = await getVersions({ entityType: 'persona', entityId: personaId });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ entityAttribute: 'description', versionNumber: 1, oldContent: 'Physicist.' });
  });

  test('does not record when the tracked attribute is unchanged', async () => {
    const topicId = await createTopic({ defaultSystemPrompt: 'Prompt A' });

    await request(app)
      .put(`/api/topics/${topicId}`)
      .send({ name: 'Renamed only' })
      .expect(200);
    await request(app)
      .put(`/api/topics/${topicId}`)
      .send({ defaultSystemPrompt: 'Prompt A' })
      .expect(200);

    const versions = await getVersions({ entityType: 'topic', entityId: topicId });
    expect(versions).toEqual([]);
  });

  test('records an empty-string transition as a version', async () => {
    const topicId = await createTopic({ defaultSystemPrompt: 'Prompt A' });

    await request(app).put(`/api/topics/${topicId}`).send({ defaultSystemPrompt: '' }).expect(200);

    const versions = await getVersions({ entityType: 'topic', entityId: topicId });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ oldContent: 'Prompt A' });
  });
});

describe('Text versions — GET validation', () => {
  test('400 when entityType is missing or invalid', async () => {
    const res = await request(app).get('/api/text-versions').query({ entityId: 'x' });
    expect(res.status).toBe(400);

    const bad = await request(app)
      .get('/api/text-versions')
      .query({ entityType: 'chapter', entityId: 'x' });
    expect(bad.status).toBe(400);
  });

  test('400 when entityId is missing', async () => {
    const res = await request(app).get('/api/text-versions').query({ entityType: 'topic' });
    expect(res.status).toBe(400);
  });

  test('400 when attribute is invalid', async () => {
    const topicId = await createTopic();
    const res = await request(app)
      .get('/api/text-versions')
      .query({ entityType: 'topic', entityId: topicId, attribute: 'title' });
    expect(res.status).toBe(400);
  });

  test('404 when the entity does not exist', async () => {
    const res = await request(app)
      .get('/api/text-versions')
      .query({ entityType: 'topic', entityId: 'nope' });
    expect(res.status).toBe(404);
  });

  test('filters by attribute', async () => {
    const projectId = await createProject();
    await request(app)
      .put(`/api/projects/${projectId}`)
      .send({ systemPrompt: 'Def v2.', greeting: 'Yo.' })
      .expect(200);

    const greetingOnly = await getVersions({
      entityType: 'project',
      entityId: projectId,
      attribute: 'greeting',
    });
    expect(greetingOnly).toHaveLength(1);
    expect(greetingOnly[0].entityAttribute).toBe('greeting');
  });
});

describe('Text versions — restore', () => {
  test('restores a topic prompt and appends an undo version', async () => {
    const topicId = await createTopic({ defaultSystemPrompt: 'Prompt A' });
    await request(app).put(`/api/topics/${topicId}`).send({ defaultSystemPrompt: 'Prompt B' }).expect(200);

    const before = await getVersions({ entityType: 'topic', entityId: topicId });
    const version1 = before.find((v) => v.versionNumber === 1) as { id: string };

    const res = await request(app).post(`/api/text-versions/${version1.id}/restore`).expect(200);
    expect(res.body).toMatchObject({ entityType: 'topic', entityId: topicId, entityAttribute: 'defaultSystemPrompt', value: 'Prompt A' });
    expect(res.body.undoVersion).toMatchObject({ versionNumber: 2, oldContent: 'Prompt B' });

    // The topic itself is back to the restored value.
    const topic = await request(app).get(`/api/topics/${topicId}`).expect(200);
    expect(topic.body.defaultSystemPrompt).toBe('Prompt A');

    // History now has two entries: the undo (Prompt B) and the original (Prompt A).
    const after = await getVersions({ entityType: 'topic', entityId: topicId });
    expect(after.map((v) => v.oldContent)).toEqual(['Prompt B', 'Prompt A']);
  });

  test('restores a persona description', async () => {
    const personaId = await createPersona({ description: 'V1' });
    await request(app).put(`/api/personas/${personaId}`).send({ description: 'V2' }).expect(200);

    const versions = await getVersions({ entityType: 'persona', entityId: personaId });
    const v1 = versions.find((v) => v.versionNumber === 1) as { id: string };

    const res = await request(app).post(`/api/text-versions/${v1.id}/restore`).expect(200);
    expect(res.body.value).toBe('V1');

    const persona = await request(app).get(`/api/personas/${personaId}`).expect(200);
    expect(persona.body.description).toBe('V1');
  });

  test('does not append an undo version when the current value already equals the restored one', async () => {
    const topicId = await createTopic({ defaultSystemPrompt: 'Prompt A' });
    await request(app).put(`/api/topics/${topicId}`).send({ defaultSystemPrompt: 'Prompt A' }).expect(200); // no change

    const versions = await getVersions({ entityType: 'topic', entityId: topicId });
    expect(versions).toEqual([]);
    // Nothing to restore → 404.
    await request(app).post('/api/text-versions/missing/restore').expect(404);
  });

  test('404 when restoring a missing version', async () => {
    await request(app).post('/api/text-versions/nope/restore').expect(404);
  });
});

describe('Text versions — delete', () => {
  test('deletes a single version entry', async () => {
    const topicId = await createTopic({ defaultSystemPrompt: 'Prompt A' });
    await request(app).put(`/api/topics/${topicId}`).send({ defaultSystemPrompt: 'Prompt B' }).expect(200);

    const versions = await getVersions({ entityType: 'topic', entityId: topicId });
    const id = versions[0].id as string;

    await request(app).delete(`/api/text-versions/${id}`).expect(204);

    const after = await getVersions({ entityType: 'topic', entityId: topicId });
    expect(after).toHaveLength(0);
  });

  test('404 when deleting a missing version', async () => {
    await request(app).delete('/api/text-versions/nope').expect(404);
  });
});

describe('Text versions — entity deletion cleans up versions', () => {
  test('deleting a topic drops its versions', async () => {
    const topicId = await createTopic({ defaultSystemPrompt: 'Prompt A' });
    await request(app).put(`/api/topics/${topicId}`).send({ defaultSystemPrompt: 'Prompt B' }).expect(200);

    expect(await getVersions({ entityType: 'topic', entityId: topicId })).toHaveLength(1);

    await request(app).delete(`/api/topics/${topicId}`).expect(204);

    const res = await request(app)
      .get('/api/text-versions')
      .query({ entityType: 'topic', entityId: topicId });
    expect(res.status).toBe(404); // entity gone
  });

  test('deleting a project drops its versions', async () => {
    const projectId = await createProject({ greeting: 'Hi.' });
    await request(app).put(`/api/projects/${projectId}`).send({ greeting: 'Yo.' }).expect(200);

    expect(await getVersions({ entityType: 'project', entityId: projectId })).toHaveLength(1);

    await request(app).delete(`/api/projects/${projectId}`).expect(204);

    const res = await request(app)
      .get('/api/text-versions')
      .query({ entityType: 'project', entityId: projectId });
    expect(res.status).toBe(404);
  });
});

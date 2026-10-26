/**
 * SnapshotPersistence tests.
 *
 * SnapshotPersistence keeps the domain in MemoryPersistence and mirrors every
 * write to a SnapshotBackend as a topic/provider snapshot. These tests use an
 * in-memory fake backend so the full snapshot lifecycle runs without Firebase:
 *   - init() loads persisted snapshots back into memory
 *   - every create/update mutation flushes through to the backend
 *   - close() flushes pending writes and closes the backend
 *   - a full round-trip (write -> close -> reload) preserves all data
 *   - a deliberately seeded backend is imported by init()
 */

import { describe, expect, test } from 'vitest';
import type { PersistenceKind } from '../src/domain/chat-api.port.js';
import {
  SnapshotPersistence,
  emptySnapshot,
  type SnapshotBackend,
} from '../src/persistence/snapshot-store.js';
import type { ProviderSnapshot, TopicSnapshot } from '../src/persistence/memory/memory-persistence.js';

/** In-memory SnapshotBackend recording every call against plain maps. */
class MemoryBackend implements SnapshotBackend {
  readonly kind: PersistenceKind = 'firebase';
  readonly topics = new Map<string, TopicSnapshot>();
  readonly providers = new Map<string, ProviderSnapshot>();
  closed = false;
  saveTopicCalls = 0;
  saveProviderCalls = 0;

  async listTopicIds(): Promise<string[]> {
    return [...this.topics.keys()];
  }
  async listProviderIds(): Promise<string[]> {
    return [...this.providers.keys()];
  }
  async loadTopic(topicId: string): Promise<TopicSnapshot | null> {
    return this.topics.get(topicId) ?? null;
  }
  async loadProvider(providerId: string): Promise<ProviderSnapshot | null> {
    return this.providers.get(providerId) ?? null;
  }
  async saveTopic(snapshot: TopicSnapshot): Promise<{ revision: number; updateId: string }> {
    this.saveTopicCalls += 1;
    const revision = snapshot.revision + 1;
    this.topics.set(
      snapshot.topicId,
      structuredClone({ ...snapshot, revision, updateId: `t-${snapshot.topicId}-${this.saveTopicCalls}` }),
    );
    return { revision, updateId: `t-${snapshot.topicId}-${this.saveTopicCalls}` };
  }
  async saveProvider(snapshot: ProviderSnapshot): Promise<{ revision: number; updateId: string }> {
    this.saveProviderCalls += 1;
    const revision = snapshot.revision + 1;
    this.providers.set(
      snapshot.providerId,
      structuredClone({ ...snapshot, revision, updateId: `p-${snapshot.providerId}-${this.saveProviderCalls}` }),
    );
    return { revision, updateId: `p-${snapshot.providerId}-${this.saveProviderCalls}` };
  }
  async deleteTopic(topicId: string): Promise<void> {
    this.topics.delete(topicId);
  }
  async deleteProvider(providerId: string): Promise<void> {
    this.providers.delete(providerId);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

async function makeStore(backend: MemoryBackend): Promise<SnapshotPersistence> {
  const store = new SnapshotPersistence(backend);
  await store.init();
  return store;
}

describe('SnapshotPersistence', () => {
  test('init() imports a pre-seeded backend snapshot', async () => {
    const backend = new MemoryBackend();
    backend.providers.set('prov-1', {
      providerId: 'prov-1',
      provider: {
        id: 'prov-1',
        name: 'Seeded',
        type: 'custom',
        baseUrl: 'http://seed.local',
        apiKey: 'k',
        enabled: true,
      },
      models: [
        {
          id: 'mod-1',
          displayName: 'Seed model',
          modelId: 'seed/m',
          providerId: 'prov-1',
          type: 'preset',
          enabled: true,
          chatParametersId: null,
        },
      ],
      parameters: [],
      revision: 3,
      updateId: 'seed-u',
    });

    const store = await makeStore(backend);

    const providers = await store.getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('prov-1');

    const models = await store.getModels();
    expect(models).toHaveLength(1);
    expect(models[0].displayName).toBe('Seed model');
    expect(models[0].providerId).toBe('prov-1');
  });

  test('writes flush to the backend immediately', async () => {
    const backend = new MemoryBackend();
    const store = await makeStore(backend);

    const provider = await store.createProvider({
      name: 'F',
      type: 'custom',
      baseUrl: 'http://flush',
      apiKey: 'k',
      enabled: true,
    });
    expect(backend.providers.has(provider.id)).toBe(true);
    expect(backend.saveProviderCalls).toBe(1);

    const topic = await store.createTopic({ name: 'Topic' });
    expect(backend.topics.has(topic.id)).toBe(true);
    expect(backend.saveTopicCalls).toBe(1);
  });

  test('a deleted item disappears from the API surface', async () => {
    const backend = new MemoryBackend();
    const store = await makeStore(backend);

    const provider = await store.createProvider({
      name: 'F',
      type: 'custom',
      baseUrl: 'http://flush',
      apiKey: 'k',
      enabled: true,
    });
    const topic = await store.createTopic({ name: 'Topic' });

    await store.deleteProvider(provider.id);
    await store.deleteTopic(topic.id);

    expect(await store.getProviders()).toEqual([]);
    expect(await store.getTopics()).toEqual([]);
  });

  test('close() closes the backend', async () => {
    const backend = new MemoryBackend();
    const store = await makeStore(backend);
    await store.createProvider({
      name: 'F',
      type: 'custom',
      baseUrl: 'http://flush',
      apiKey: 'k',
      enabled: true,
    });
    await store.close();
    expect(backend.closed).toBe(true);
  });

  test('full round-trip: write, close, reload preserves all data', async () => {
    const backend = new MemoryBackend();
    const store = await makeStore(backend);

    // ---- write side ----
    const topic = await store.createTopic({ name: 'Round Trip Topic' });
    const project = await store.createProject({ name: 'Round Trip Project', topicId: topic.id });
    const chat = await store.createChat('Round Trip Chat', project.id);
    const q = await store.createNode(chat.id, { role: 'user', content: 'Q?' });
    await store.createNode(chat.id, { role: 'assistant', content: 'A.', parentId: q.id });
    await store.createPersona({
      name: 'Hero',
      shortName: 'Hero',
      description: 'protagonist',
      mainTopicId: topic.id,
    });
    const provider = await store.createProvider({
      name: 'Round Trip Provider',
      type: 'custom',
      baseUrl: 'http://roundtrip',
      apiKey: 'k',
      enabled: true,
    });
    await store.createModel({
      displayName: 'Round Trip Model',
      modelId: 'rt/model',
      providerId: provider.id,
      type: 'preset',
      enabled: true,
    });

    await store.close();

    // ---- reload side (same backend = same remote store) ----
    const reloaded = await makeStore(backend);
    expect(await reloaded.getTopics()).toHaveLength(1);
    expect((await reloaded.getTopics())[0].name).toBe('Round Trip Topic');

    const projects = await reloaded.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(project.id);
    expect(projects[0].mainTopicId).toBe(topic.id);

    const chats = await reloaded.getChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].projectId).toBe(project.id);

    const nodes = await reloaded.getNodes(chat.id);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.role)).toEqual(
      expect.arrayContaining(['user', 'assistant']),
    );

    const personas = await reloaded.getPersonas();
    expect(personas).toHaveLength(1);
    expect(personas[0].name).toBe('Hero');

    const providers = await reloaded.getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('Round Trip Provider');
    const models = await reloaded.getModels();
    expect(models).toHaveLength(1);
    expect(models[0].displayName).toBe('Round Trip Model');
    expect(models[0].providerId).toBe(provider.id);
  });

  test('chat parameters attached to a project survive the round-trip', async () => {
    const backend = new MemoryBackend();
    const store = await makeStore(backend);

    const topic = await store.createTopic({ name: 'Params Topic' });
    const params = await store.createChatParameters({
      name: 'Story',
      temperature: 0.7,
      topK: 50,
      topM: 0.9,
      stream: true,
      thinking: true,
      thinkingLevel: 'high',
    });
    const project = await store.createProject({
      name: 'Params Project',
      topicId: topic.id,
    });
    await store.updateProject(project.id, { chatParametersId: params.id });
    await store.close();

    const reloaded = await makeStore(backend);
    const [reloadedProject] = await reloaded.getProjects();
    expect(reloadedProject.chatParametersId).toBe(params.id);
    const allParams = await reloaded.getChatParameters();
    expect(allParams.map((p) => p.id)).toContain(params.id);
  });
});

describe('emptySnapshot', () => {
  test('returns an empty structure', () => {
    expect(emptySnapshot()).toEqual({ topics: [], providers: [] });
  });
});
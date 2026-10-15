import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeProject } from '../../../../test-helpers/factories';
import { ChatService } from '../chat.service';
import { ProjectService } from '../project.service';
import { SettingsService } from '../settings.service';
import { GenerationSettingsService } from '../generation-settings.service';
import { DemoDataService, DEMO_PROJECT_NAME } from './demo-data.service';
import { MOCK_PROVIDER_NAME, MOCK_MODEL_ID } from '../mock-llm/mock-llm-config';

describe('DemoDataService', () => {
  let api: InMemoryChatApi;
  let service: DemoDataService;
  let chatService: ChatService;
  let projectService: ProjectService;
  let settings: SettingsService;
  let generation: GenerationSettingsService;

  beforeEach(() => {
    localStorage.removeItem('chat.demoData.loadedV1');
    api = new InMemoryChatApi();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    });
    service = TestBed.inject(DemoDataService);
    chatService = TestBed.inject(ChatService);
    projectService = TestBed.inject(ProjectService);
    settings = TestBed.inject(SettingsService);
    generation = TestBed.inject(GenerationSettingsService);
  });

  afterEach(() => {
    localStorage.removeItem('chat.demoData.loadedV1');
  });

  it('registers the key-free mock provider + model exactly once', async () => {
    expect(service.mockProviderExists()).toBe(false);

    await service.ensureMockProvider();

    expect(service.mockProviderExists()).toBe(true);
    const mockProviders = settings.providers().filter(p => p.name === MOCK_PROVIDER_NAME);
    expect(mockProviders).toHaveLength(1);
    // preset model is enabled and text-only so no image features are offered
    const [mockProvider] = mockProviders;
    const model = settings.models().find(
      m => m.providerId === mockProvider.id && m.modelId === MOCK_MODEL_ID
    );
    expect(model).toBeDefined();
    expect(model?.enabled).toBe(true);

    // Idempotent — a second call creates no duplicates.
    await service.ensureMockProvider();
    expect(settings.providers().filter(p => p.name === MOCK_PROVIDER_NAME)).toHaveLength(1);
    expect(settings.models().filter(m => m.modelId === MOCK_MODEL_ID)).toHaveLength(1);
  });

  it('repairs an existing mock provider that has no mock model', async () => {
    api.providers.push({
      id: 'mock-provider',
      name: MOCK_PROVIDER_NAME,
      type: 'custom',
      baseUrl: 'http://localhost',
      apiKey: 'local',
      enabled: true,
    });
    await settings.loadAll();

    await service.ensureMockProvider();

    expect(settings.providers().filter(p => p.name === MOCK_PROVIDER_NAME)).toHaveLength(1);
    expect(settings.models().some(m => m.providerId === 'mock-provider' && m.modelId === MOCK_MODEL_ID)).toBe(true);
  });

  it('sets Mock Writer as the default only for authoring tasks without a selection', async () => {
    generation.update('title', { providerId: 'custom-provider', modelId: 'custom-model' });

    await service.ensureMockWriterDefaults();

    const mockProvider = settings.providers().find(p => p.name === MOCK_PROVIDER_NAME)!;
    const mockModel = settings.models().find(
      m => m.providerId === mockProvider.id && m.modelId === MOCK_MODEL_ID
    );
    expect(mockModel?.enabled).toBe(true);
    for (const kind of ['title', 'headings', 'overview', 'language-check'] as const) {
      if (kind === 'title') {
        expect(generation.get(kind)).toMatchObject({ providerId: 'custom-provider', modelId: 'custom-model' });
      } else {
        expect(generation.get(kind)).toMatchObject({ providerId: mockProvider.id, modelId: MOCK_MODEL_ID });
      }
    }
  });

  it('loads the demo bundle exactly once on an empty workspace', async () => {
    expect(service.isLoaded()).toBe(false);

    const chatId = await service.ensureDemoData();

    expect(chatId).not.toBeNull();
    expect(service.isLoaded()).toBe(true);
    expect(service.loaded()).toBe(true);

    // Both demo chats plus the demo project exist.
    expect(chatService.chats().length).toBe(2);
    expect(chatService.chats().some(c => c.title === 'Reader & Editor Tour')).toBe(true);
    expect(chatService.chats().some(c => c.title === 'The Lantern Keeper')).toBe(true);
    const demoProjects = projectService.projects().filter(p => p.name === DEMO_PROJECT_NAME);
    expect(demoProjects.length).toBe(1);

    // The story chat has demo structure: system premise, directions, chapters.
    const story = chatService.chats().find(c => c.title === 'The Lantern Keeper')!;
    await chatService.selectChat(story.id);
    const nodes = chatService.currentNodes();
    expect(nodes.some(n => n.role === 'system')).toBe(true);
    expect(nodes.some(n => n.role === 'assistant')).toBe(true);
    expect(nodes.some(n => n.role === 'user' && n.content.trim() === '')).toBe(true);

    // Idempotent: a second call imports nothing.
    const again = await service.ensureDemoData();
    expect(again).toBeNull();
    expect(chatService.chats().length).toBe(2);
  });

  it('does not auto-load when the workspace already has data', async () => {
    api.projects.push(makeProject({ name: 'My own project' }));

    const chatId = await service.ensureDemoData();

    expect(chatId).toBeNull();
    expect(service.isLoaded()).toBe(false);
    expect(chatService.chats().length).toBe(0);
  });

  it('loadDemoData is a no-op when the demo project already exists by name', async () => {
    api.projects.push(makeProject({ name: DEMO_PROJECT_NAME }));

    const chatId = await service.loadDemoData();

    expect(chatId).toBeNull();
    expect(service.isLoaded()).toBe(true); // demo project present by name
    expect(chatService.chats().length).toBe(0);
  });

  it('demo becomes loadable again after the demo project is deleted', async () => {
    // Import once…
    await service.loadDemoData();
    expect(service.isLoaded()).toBe(true);

    // …then the user deletes the demo workspace: no stale flag may block a
    // reload (there is deliberately no localStorage marker anymore).
    api.projects = api.projects.filter(p => p.name !== DEMO_PROJECT_NAME);
    api.chats = [];
    api.topics = [];
    api.personas = [];
    await projectService.loadProjects();

    expect(service.isLoaded()).toBe(false);
    const again = await service.loadDemoData();
    expect(again).not.toBeNull();
    expect(service.isLoaded()).toBe(true);
    expect(chatService.chats().length).toBe(2);
  });

  it('implements the full public write path through the port', async () => {
    const created = await service.loadDemoData();

    // The bundle import goes through the real BundleService + ChatService/…
    // (all backed by the in-memory ChatApiPort).
    expect(created).not.toBeNull();
    expect(chatService.chats().length).toBe(2);
    expect(projectService.projects().some(p => p.name === DEMO_PROJECT_NAME)).toBe(true);

    // openFirstDemoChat selects one of the demo chats and loads its nodes.
    await service.openFirstDemoChat();
    expect(chatService.currentChatId()).not.toBeNull();
    expect(chatService.currentNodes().length).toBeGreaterThan(0);
  });
});
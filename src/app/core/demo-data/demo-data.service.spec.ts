import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeProject } from '../../../../test-helpers/factories';
import { ChatService } from '../chat.service';
import { ProjectService } from '../project.service';
import { DemoDataService, DEMO_PROJECT_NAME } from './demo-data.service';

const LS_DEMO = 'chat.demoData.loadedV1';

describe('DemoDataService', () => {
  let api: InMemoryChatApi;
  let service: DemoDataService;
  let chatService: ChatService;
  let projectService: ProjectService;

  beforeEach(() => {
    localStorage.removeItem(LS_DEMO);
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
  });

  afterEach(() => {
    localStorage.removeItem(LS_DEMO);
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
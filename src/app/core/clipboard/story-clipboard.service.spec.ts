import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { StoryClipboardService } from './story-clipboard.service';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../chat/chat.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeChat, makeProject } from '../../../../test-helpers/factories';

const LS_KEY = 'chat.storyClipboard.v1';

describe('StoryClipboardService', () => {
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let service: StoryClipboardService;

  beforeEach(async () => {
    api = new InMemoryChatApi();
    localStorage.clear();
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        StoryClipboardService,
        ChatService,
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    chatService = TestBed.inject(ChatService);
    service = TestBed.inject(StoryClipboardService);
  });

  it('is empty by default', () => {
    expect(service.hasContent()).toBe(false);
    expect(service.count()).toBe(0);
  });

  it('stages a cut without touching the chats', async () => {
    api.chats.push(makeChat({ id: 'c1', projectId: 'p-1' }));
    await chatService.loadChats();
    service.cut(['c1']);
    expect(service.action()).toBe('cut');
    expect(service.count()).toBe(1);
    expect(service.isCutChat('c1')).toBe(true);
    // The story is untouched until it is actually pasted somewhere.
    expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-1');
    expect(service.hasContent()).toBe(true);
  });

  it('pasteInto with action=cut moves the staged stories (a real move)', async () => {
    api.chats.push(makeChat({ id: 'c1', projectId: 'p-1' }));
    api.chats.push(makeChat({ id: 'c2', projectId: 'p-1' }));
    await chatService.loadChats();
    service.cut(['c1', 'c2']);
    await service.pasteInto('p-2');
    expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-2');
    expect(chatService.chats().find(c => c.id === 'c2')?.projectId).toBe('p-2');
    expect(chatService.chats().length).toBe(2);
    expect(service.hasContent()).toBe(false);
  });

  it('pasteInto with action=copy clones the stories (originals stay)', async () => {
    api.chats.push(makeChat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
    await chatService.loadChats();
    service.copy(['c1']);
    await service.pasteInto('p-2');
    expect(chatService.chats().filter(c => c.id === 'c1').length).toBe(1);
    const clones = chatService.chats().filter(c => c.projectId === 'p-2');
    expect(clones.length).toBe(1);
    expect(clones[0].id).not.toBe('c1');
    expect(clones[0].title).toContain('Story 1');
    expect(service.hasContent()).toBe(false);
  });

  it('pasting a cut into the same environment is a no-op yet clears the staging', async () => {
    api.chats.push(makeChat({ id: 'c1', projectId: 'p-1' }));
    await chatService.loadChats();
    service.cut(['c1']);
    await service.pasteInto('p-1');
    expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-1');
    expect(service.hasContent()).toBe(false);
  });

  it('clear() drops a staged cut', () => {
    service.cut(['c1']);
    expect(service.hasContent()).toBe(true);
    service.clear();
    expect(service.hasContent()).toBe(false);
    expect(service.isCutChat('c1')).toBe(false);
  });

  it('persists the staged cut to localStorage', () => {
    service.cut(['c1', 'c2']);
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.action).toBe('cut');
    expect(parsed.chatIds).toEqual(['c1', 'c2']);
  });

  it('restores a staged cut from localStorage on a fresh service instance', async () => {
    service.cut(['c1', 'c2']);
    const raw = localStorage.getItem(LS_KEY)!;
    localStorage.clear();
    localStorage.setItem(LS_KEY, raw);

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        StoryClipboardService,
        ChatService,
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    const rebuilt = TestBed.inject(StoryClipboardService);
    expect(rebuilt.hasContent()).toBe(true);
    expect(rebuilt.count()).toBe(2);
    expect(rebuilt.action()).toBe('cut');
    expect(rebuilt.isCutChat('c1')).toBe(true);
    expect(rebuilt.isCutChat('c2')).toBe(true);
  });
});
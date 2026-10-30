import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeAttachment } from '../../../../test-helpers/factories';
import { ChatService } from './chat.service';
import { ChatImagesService } from './chat-images.service';
import { I18nService } from '../i18n/i18n.service';

describe('ChatImagesService', () => {
  let chatService: ChatService;
  let service: ChatImagesService;
  let api: InMemoryChatApi;

  beforeEach(async () => {
    localStorage.clear();
    api = new InMemoryChatApi();
    seedApi(api, {});
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    chatService = TestBed.inject(ChatService);
    service = TestBed.inject(ChatImagesService);
  });

  it('collects image attachments from the current chat in node order', async () => {
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 3, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({
        id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant',
        content: 'A chapter with pictures.',
        attachments: [
          makeAttachment({ id: 'img1', name: 'one.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUFB' }),
          makeAttachment({ id: 'pdf', name: 'note.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,QUFB' }),
          makeAttachment({ id: 'img2', name: 'two.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,QkJC' })
        ] as never
      })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const images = service.imagesInCurrentChat();
    expect(images.map(e => e.attachment.id)).toEqual(['img1', 'img2']);
    expect(images[0].nodeRole).toBe('assistant');
    expect(images[0].nodeLabel).toContain('A chapter with pictures');
  });

  it('returns an empty list when the chat has no image attachments', async () => {
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 1, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    expect(service.imagesInCurrentChat()).toEqual([]);
  });
});
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat } from '../../../../test-helpers/factories';
import { SettingsService } from '../../core/settings/settings.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ChatService } from '../../core/chat/chat.service';
import { NodeEditSession } from '../../core/chat/node-edit-session';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { NodeActionState } from './node-action-state';
import { EditorController, type EditorHost } from './editor-controller';
import type { ChatNode } from '../../models/chat';

const CHAT_ID = 'chat-1';

describe('EditorController', () => {
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let editor: EditorController;
  let actions: NodeActionState;
  let node: ChatNode;
  let host: EditorHost;
  let closeSpy: ReturnType<typeof vi.fn>;
  let activated: string[];

  async function open(): Promise<void> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [{ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' }],
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = [
      makeNode({ id: 'q1', role: 'user', content: 'A direction' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A chapter', isCurrent: true }),
    ].map(n => ({ ...n, chatId: CHAT_ID }));
    await TestBed.configureTestingModule({
      // The controllers are normally provided by the chat-node CARD; the spec
      // provides them at the injector root instead.
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        NodeActionState,
        EditorController,
      ],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    node = chatService.nodes().find(n => n.id === 'a1')!;

    actions = TestBed.inject(NodeActionState);
    editor = TestBed.inject(EditorController);
    closeSpy = vi.fn();
    activated = [];
    host = {
      node: () => node,
      editSession: TestBed.inject(NodeEditSession),
      enabledModels: () => TestBed.inject(SettingsService).enabledModels(),
      resolvePreferredModelId: () => 'alpha/model',
      clearAttachmentSelection: vi.fn(),
      onEditorTargetCleared: vi.fn(),
      onDraftReplaced: vi.fn(),
      isUnsentQuestion: () => false,
      sendDraft: vi.fn(async () => undefined),
      runDirectionBatch: vi.fn(async () => undefined),
      onActivated: id => activated.push(id),
    };
    editor.bind(host);
  }

  beforeEach(() => localStorage.clear());

  it('openDraft seeds text, attachments and the model from the node', async () => {
    await open();
    editor.openDraft(node);
    expect(editor.contentDraft()).toBe('A chapter');
    expect(editor.branchModelId()).toBe('alpha/model');
    expect(editor.editDismissed()).toBe(false);
    expect(editor.isDraftEmpty()).toBe(false);
  });

  it('isDraftEmpty is true only without text AND attachments', async () => {
    await open();
    editor.openDraft(node);
    expect(editor.isDraftEmpty()).toBe(false);
    editor.contentDraft.set('   ');
    expect(editor.isDraftEmpty()).toBe(true);
  });

  it('saveAsVersion persists a new version and re-targets the card', async () => {
    await open();
    editor.openDraft(node);
    editor.contentDraft.set('A revised chapter');
    await editor.saveAsVersion();

    // The versioned node carries the new text and is the CURRENT one…
    const current = chatService.nodes().find(n => n.role === 'assistant' && n.isCurrent)!;
    expect(current.content).toBe('A revised chapter');
    // …and the card was told about the new id (then the editor closed).
    expect(activated).toEqual([current.id]);
    expect(editor.contentDraft()).toBe('');
    expect(editor.editAttachments()).toEqual([]);
    // The busy state was released (one action at a time).
    expect(actions.idle).toBe(true);
  });

  it('saveAsVersion with an unchanged draft only closes (no new version)', async () => {
    await open();
    editor.openDraft(node);
    await editor.saveAsVersion();
    expect(activated).toEqual([]);
    expect(chatService.nodes().filter(n => n.role === 'assistant')).toHaveLength(1);
  });

  it('cancelEdit asks before discarding a dirty draft and keeps it on refusal', async () => {
    await open();
    const confirm = TestBed.inject(ConfirmService);
    const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
    const session = TestBed.inject(NodeEditSession);

    // A REAL edit session is what makes the draft "dirty" (draft ≠ baseline).
    await session.begin(
      { chatId: CHAT_ID, nodeId: node.id, text: 'A chapter', attachments: [] }, 'user',
    );
    editor.openDraft(node);
    editor.onDraftText('typed but unsaved');
    await editor.cancelEdit();
    expect(ask).toHaveBeenCalled();
    // Refused → the draft survives, the editor stays.
    expect(editor.contentDraft()).toBe('typed but unsaved');

    ask.mockResolvedValue(true);
    await editor.cancelEdit();
    expect(editor.contentDraft()).toBe('');
    expect(editor.editDismissed()).toBe(true);
  });

  it('decRepeat / incRepeat clamp the batch size to 1..20', async () => {
    await open();
    for (let i = 0; i < 30; i++) editor.incRepeat();
    expect(editor.repeatCount()).toBe(20);
    for (let i = 0; i < 30; i++) editor.decRepeat();
    expect(editor.repeatCount()).toBe(1);
  });

  it('onDraftText keeps the edit session in sync', async () => {
    await open();
    const session = TestBed.inject(NodeEditSession);
    await session.begin({ chatId: CHAT_ID, nodeId: node.id, text: 'A chapter', attachments: [] }, 'user');
    editor.openDraft(node);
    editor.onDraftText('changed');
    expect(session.state()?.draftText).toBe('changed');
  });

  it('setDraftFromSearch is ignored while the editor is closed', async () => {
    await open();
    const replaced = vi.fn();
    editor.bind({ ...host, onDraftReplaced: replaced });
    editor.setDraftFromSearch('ignored');
    expect(editor.contentDraft()).toBe('');
    expect(replaced).not.toHaveBeenCalled();
  });
});

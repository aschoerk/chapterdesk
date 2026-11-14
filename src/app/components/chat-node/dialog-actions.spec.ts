import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat } from '../../../../test-helpers/factories';
import { SettingsService } from '../../core/settings/settings.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ChatService } from '../../core/chat/chat.service';
import { NodeEditSession } from '../../core/chat/node-edit-session';
import { NodeVersionDiffDialogService } from '../../core/dialogs/node-version-diff-dialog.service';
import { ChapterDescriptionsDialogService } from '../../core/dialogs/chapter-descriptions-dialog.service';
import { NodeActionState } from './node-action-state';
import { EditorController } from './editor-controller';
import { DialogActionsController, type DialogActionsHost } from './dialog-actions';
import type { ChatNode } from '../../models/chat';

const CHAT_ID = 'chat-1';

describe('DialogActionsController', () => {
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let controller: DialogActionsController;
  let actions: NodeActionState;
  let editor: EditorController;
  let node: ChatNode;
  let host: DialogActionsHost & { host: DialogActionsHost };
  let ranFlows: { usecase: string; pending: string; vars: Record<string, unknown> }[];
  let activated: string[];
  let resizeCount: number;
  let session: NodeEditSession;

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
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        NodeActionState,
        EditorController,
        DialogActionsController,
      ],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    node = chatService.nodes().find(n => n.id === 'q1')!;

    actions = TestBed.inject(NodeActionState);
    editor = TestBed.inject(EditorController);
    session = TestBed.inject(NodeEditSession);
    controller = TestBed.inject(DialogActionsController);
    ranFlows = [];
    activated = [];
    resizeCount = 0;

    host = {
      node: () => node,
      actions,
      editor,
      editSession: session,
      enabledModels: () => TestBed.inject(SettingsService).enabledModels(),
      providers: () => TestBed.inject(SettingsService).providers(),
      resolvePreferredModelId: () => 'alpha/model',
      isEditing: () => false,
      resizeTextarea: () => { resizeCount++; },
      onActivated: (id: string) => activated.push(id),
      runFlow: async (
        usecase: string,
        pending: string,
        builder?: (build: { vars: Record<string, unknown> }) => void,
      ) => {
        const vars: Record<string, unknown> = {};
        builder?.({ vars });
        ranFlows.push({ usecase, pending, vars });
        return true;
      },
      prependEnabled: signal(false),
      prependText: signal(''),
      comparableSiblings: () => chatService.getChildren(node.parentId ?? null)
        .filter(n => n.id !== node.id && !!n.content?.trim()),
      replaceDraft: (text: string) => {
        editor.contentDraft.set(text);
        session.patch(node.id, text, editor.editAttachments());
        resizeCount++;
      },
    } as unknown as DialogActionsHost & { host: DialogActionsHost };
    controller.bind(host);
  }

  beforeEach(() => localStorage.clear());

  it('prepend state round-trips through localStorage', async () => {
    await open();
    expect(controller.isPrependStored('q1')).toBe(false);
    localStorage.setItem('chat.prependByNodeId', JSON.stringify({ q1: 'be brief' }));
    expect(controller.isPrependStored('q1')).toBe(true);
    expect(controller.storedPrependText('q1')).toBe('be brief');
  });

  it('followingAssistantContent caps at the whole-chapter token budget', async () => {
    await open();
    node = chatService.nodes().find(n => n.id === 'a1')!;
    // Only one chapter follows a1? None — a1 is the leaf.
    expect(controller.followingAssistantContent('a1')).toBe('');
    // From the direction, the chapter after it travels along.
    expect(controller.followingAssistantContent('q1')).toContain('A chapter');
  });

  it('openVersionDiffDialog applies to the DRAFT while editing', async () => {
    await open();
    // The in-memory API does not link `previousVersionId` (only the real
    // backends version rows), so the prior versions are stubbed here.
    const prior = makeNode({ id: 'q0', role: 'user', content: 'An older direction' });
    vi.spyOn(chatService, 'getPriorVersions').mockReturnValue([{ ...prior, chatId: CHAT_ID }]);

    const dialog = TestBed.inject(NodeVersionDiffDialogService);
    const openSpy = vi.spyOn(dialog, 'open').mockResolvedValue('merged text');
    await session.begin(
      { chatId: CHAT_ID, nodeId: node.id, text: 'A direction', attachments: [] }, 'user',
    );
    editor.openDraft(node);
    host.isEditing = () => true;

    await controller.openVersionDiffDialog();
    expect(openSpy).toHaveBeenCalled();
    // Draft path: no new node, the draft holds the result.
    expect(editor.contentDraft()).toBe('merged text');
    expect(activated).toEqual([]);
    expect(resizeCount).toBeGreaterThan(0);
  });

  it('persistDialogAsVersion writes a new version from the read-only view', async () => {
    await open();
    await controller.persistDialogAsVersion(node, 'revised direction');
    // editUser versions the node: the old one is retired, a NEW current one
    // carries the edited text, and the card was re-targeted to it.
    const current = chatService.nodes()
      .find(n => n.role === 'user' && n.isCurrent && n.content === 'revised direction');
    expect(current).toBeDefined();
    expect(current!.id).not.toBe('q1');
    expect(activated).toEqual([current!.id]);
    expect(actions.idle).toBe(true);
  });

  it('persistDialogAsVersion is a no-op when the text did not change', async () => {
    await open();
    await controller.persistDialogAsVersion(node, 'A direction');
    expect(activated).toEqual([]);
  });

  it('openChapterDescriptionsDialog runs the flow with the dialog parameters', async () => {
    await open();
    const dialog = TestBed.inject(ChapterDescriptionsDialogService);
    vi.spyOn(dialog, 'open').mockResolvedValue({
      chapterCount: 3,
      sentencesPerChapter: 2,
      firstChapter: 7,
      goal: 'Detective story',
      modelId: 'alpha/model',
      providerId: 'prov-1',
    });

    await controller.openChapterDescriptionsDialog();
    expect(ranFlows).toHaveLength(1);
    expect(ranFlows[0].usecase).toBe('send-chapter-descriptions');
    expect(ranFlows[0].vars).toMatchObject({
      chapterCount: 3,
      sentencesPerChapter: 2,
      firstChapter: 7,
      goal: 'Detective story',
      modelId: 'alpha/model',
      providerId: 'prov-1',
    });
  });

  it('openChapterDescriptionsDialog does nothing while another action runs', async () => {
    await open();
    actions.begin('send');
    await controller.openChapterDescriptionsDialog();
    expect(ranFlows).toEqual([]);
    actions.end();
  });
});

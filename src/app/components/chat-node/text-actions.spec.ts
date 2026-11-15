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
import { ToastService } from '../../core/toast/toast.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { RewriteDialogService } from '../../core/dialogs/rewrite-dialog.service';
import { CreateImageDialogService } from '../../core/dialogs/create-image-dialog.service';
import { NodeActionState } from './node-action-state';
import { EditorController } from './editor-controller';
import { IllustrationController } from './illustration-controller';
import { TextActionsController, type TextActionsHost, type EditorSelection } from './text-actions';
import type { ChatNode } from '../../models/chat';

const CHAT_ID = 'chat-1';

describe('TextActionsController', () => {
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let controller: TextActionsController;
  let actions: NodeActionState;
  let editor: EditorController;
  let runnerStub: { run: ReturnType<typeof vi.fn> };
  let rewriteStub: { open: ReturnType<typeof vi.fn> };
  let createImageStub: { open: ReturnType<typeof vi.fn> };
  let generationStub: { modelFor: ReturnType<typeof vi.fn>; providerFor: ReturnType<typeof vi.fn> };
  let host: TextActionsHost;
  let toastError: ReturnType<typeof vi.spyOn>;
  let toastInfo: ReturnType<typeof vi.spyOn>;

  // Host spies (kept as standalone refs so tests can assert on them).
  let resizeEditor: ReturnType<typeof vi.fn>;
  let focusEditorAt: ReturnType<typeof vi.fn>;
  let writeDraft: ReturnType<typeof vi.fn>;

  // Per-test mutable host state.
  let nodeRef: ChatNode;
  let editingRef: boolean;
  let selectionRef: EditorSelection | null;
  let readSelectionRef: string | null;
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
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'The cat sat.', isCurrent: true }),
    ].map(n => ({ ...n, chatId: CHAT_ID }));

    runnerStub = { run: vi.fn() };
    rewriteStub = { open: vi.fn() };
    createImageStub = { open: vi.fn() };
    generationStub = { modelFor: vi.fn(() => null), providerFor: vi.fn(() => null) };

    await TestBed.configureTestingModule({
      // The controllers are normally provided by the chat-node CARD; the spec
      // provides them at the injector root instead (as the other controller specs do).
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        { provide: LlmUseCaseRunner, useValue: runnerStub },
        { provide: RewriteDialogService, useValue: rewriteStub },
        { provide: CreateImageDialogService, useValue: createImageStub },
        { provide: GenerationSettingsService, useValue: generationStub },
        NodeActionState,
        EditorController,
        TextActionsController,
      ],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);

    actions = TestBed.inject(NodeActionState);
    editor = TestBed.inject(EditorController);
    controller = TestBed.inject(TextActionsController);

    nodeRef = chatService.nodes().find(n => n.id === 'a1')!;
    editingRef = false;
    selectionRef = null;
    readSelectionRef = null;
    activated = [];
    resizeEditor = vi.fn();
    focusEditorAt = vi.fn();
    writeDraft = vi.fn((text: string) => {
      editor.contentDraft.set(text);
    });

    host = {
      node: () => nodeRef,
      isEditing: () => editingRef,
      actions,
      editor,
      illustration: { imageProgress: signal<number | null>(null) } as unknown as IllustrationController,
      editSession: TestBed.inject(NodeEditSession),
      enabledModels: () => TestBed.inject(SettingsService).enabledModels(),
      providers: () => TestBed.inject(SettingsService).providers(),
      resolvePreferredModelId: () => 'alpha/model',
      onActivated: (id: string) => activated.push(id),
      editorSelection: () => selectionRef,
      readSelection: () => readSelectionRef,
      resizeEditor,
      focusEditorAt,
      writeDraft,
    } as unknown as TextActionsHost;
    controller.bind(host);

    toastError = vi.spyOn(TestBed.inject(ToastService), 'error');
    toastInfo = vi.spyOn(TestBed.inject(ToastService), 'info');
  }

  beforeEach(() => localStorage.clear());

  // ------------------------------------------------------------------
  // Check my English
  // ------------------------------------------------------------------

  it('checkMyEnglish runs language-check with the fallback model and parses variants', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = true;
    editor.branchModelId.set('');
    editor.contentDraft.set('Some direction text.');
    runnerStub.run.mockResolvedValue({
      text: { status: 'ok', value: 'Variant one.\nVariant two.\nVariant three.' },
    });

    await controller.checkMyEnglish();

    expect(runnerStub.run).toHaveBeenCalledWith(expect.objectContaining({
      usecase: 'language-check',
      vars: expect.objectContaining({ content: 'Some direction text.' }),
    }));
    expect(controller.englishSuggestions()).toEqual([
      'Variant one.', 'Variant two.', 'Variant three.',
    ]);
    expect(controller.checkingEnglish()).toBe(false);
  });

  it('checkMyEnglish surfaces an error when the answer has no variants', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = true;
    editor.contentDraft.set('Some direction text.');
    runnerStub.run.mockResolvedValue({ text: { status: 'ok', value: '   ' } });

    await controller.checkMyEnglish();

    expect(toastError).toHaveBeenCalled();
    expect(controller.englishSuggestions()).toBeNull();
  });

  it('checkMyEnglish refuses an empty fragment', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = true;
    editor.contentDraft.set('   ');

    await controller.checkMyEnglish();

    expect(toastError).toHaveBeenCalled();
    expect(runnerStub.run).not.toHaveBeenCalled();
  });

  it('checkMyEnglish bails out when not editing or not a direction', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = false;
    await controller.checkMyEnglish();
    expect(runnerStub.run).not.toHaveBeenCalled();

    nodeRef = chatService.nodes().find(n => n.id === 'a1')!; // assistant, not a direction
    editingRef = true;
    await controller.checkMyEnglish();
    expect(runnerStub.run).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Apply / dismiss a suggestion
  // ------------------------------------------------------------------

  it('applyEnglishSuggestion replaces only the marked range and restores focus', async () => {
    await open();
    (controller as any).englishSelection.set({ start: 2, end: 5 });
    editor.contentDraft.set('Hello world');

    controller.applyEnglishSuggestion('NEW');

    expect(writeDraft).toHaveBeenCalledWith('HeNEW world');
    expect(resizeEditor).toHaveBeenCalled();
    expect(focusEditorAt).toHaveBeenCalledWith(2, 3);
  });

  it('applyEnglishSuggestion replaces the whole draft when nothing was marked', async () => {
    await open();
    (controller as any).englishSelection.set(null);
    controller.englishSuggestions.set(['x']);
    editor.contentDraft.set('Hello world');

    controller.applyEnglishSuggestion('NEW');

    expect(writeDraft).toHaveBeenCalledWith('NEW');
    expect(focusEditorAt).not.toHaveBeenCalled();
    expect(controller.englishSuggestions()).toBeNull();
  });

  it('dismissEnglishCheck clears the suggestion state', async () => {
    await open();
    controller.englishSuggestions.set(['x']);
    (controller as any).englishSelection.set({ start: 0, end: 1 });

    controller.dismissEnglishCheck();

    expect(controller.englishSuggestions()).toBeNull();
    expect((controller as any).englishSelection()).toBeNull();
  });

  // ------------------------------------------------------------------
  // Rewrite (inside the editor)
  // ------------------------------------------------------------------

  it('openRewriteDialog replaces the marked editor range through the draft', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = true;
    selectionRef = { start: 2, end: 5 };
    editor.contentDraft.set('Hello world');
    rewriteStub.open.mockResolvedValue('NEW');

    await controller.openRewriteDialog();

    expect(rewriteStub.open).toHaveBeenCalled();
    expect(writeDraft).toHaveBeenCalledWith('HeNEW world');
    expect(focusEditorAt).toHaveBeenCalledWith(2, 3);
  });

  it('openRewriteDialog requires a marked range before opening the dialog', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = true;
    selectionRef = null; // collapsed caret → nothing marked
    editor.contentDraft.set('Hello');

    await controller.openRewriteDialog();

    expect(toastError).toHaveBeenCalled();
    expect(rewriteStub.open).not.toHaveBeenCalled();
  });

  it('openRewriteDialog refuses a whitespace-only marked range', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = true;
    selectionRef = { start: 1, end: 4 };
    editor.contentDraft.set('a   b'); // slice(1,4) === '   '

    await controller.openRewriteDialog();

    expect(toastError).toHaveBeenCalled();
    expect(rewriteStub.open).not.toHaveBeenCalled();
  });

  it('openRewriteDialog does nothing when the dialog is cancelled', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!;
    editingRef = true;
    selectionRef = { start: 0, end: 5 };
    editor.contentDraft.set('Hello');
    rewriteStub.open.mockResolvedValue(null);

    await controller.openRewriteDialog();

    expect(writeDraft).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Rewrite from the read-only view
  // ------------------------------------------------------------------

  it('openReadRewriteDialog maps the fragment and persists a new version', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'a1')!; // 'The cat sat.'
    editingRef = false;
    readSelectionRef = 'cat';
    rewriteStub.open.mockResolvedValue('REWRITTEN');
    const editSpy = vi.spyOn(chatService, 'editAssistant').mockResolvedValue({ id: 'v2' } as ChatNode);

    await controller.openReadRewriteDialog();

    expect(editSpy).toHaveBeenCalledWith(CHAT_ID, 'a1', 'The REWRITTEN sat.', expect.anything());
    expect(activated).toEqual(['v2']);
  });

  it('openReadRewriteDialog appends the rewrite when the fragment cannot be mapped', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'a1')!; // 'The cat sat.'
    editingRef = false;
    readSelectionRef = 'gone missing';
    rewriteStub.open.mockResolvedValue('REWRITTEN');
    const editSpy = vi.spyOn(chatService, 'editAssistant').mockResolvedValue({ id: 'v2' } as ChatNode);

    await controller.openReadRewriteDialog();

    expect(editSpy).toHaveBeenCalledWith(CHAT_ID, 'a1', 'The cat sat.\n\nREWRITTEN', expect.anything());
    expect(toastInfo).toHaveBeenCalled();
    expect(activated).toEqual(['v2']);
  });

  // ------------------------------------------------------------------
  // Chapter heading
  // ------------------------------------------------------------------

  it('generateHeading runs structure-heading and activates the new node', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'a1')!;
    editingRef = false;
    runnerStub.run.mockResolvedValue({
      flow: { status: 'ok', value: { structureNodeId: 'struct-1' } },
    });

    await controller.generateHeading();

    expect(runnerStub.run).toHaveBeenCalledWith(expect.objectContaining({
      usecase: 'structure-heading',
    }));
    expect(activated).toEqual(['struct-1']);
  });

  it('generateHeading reports a missing model without calling the LLM', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'a1')!;
    editingRef = false;
    generationStub.modelFor.mockReturnValue({ id: 'm-9', modelId: 'x', providerId: 'no-such' });

    await controller.generateHeading();

    expect(toastError).toHaveBeenCalled();
    expect(runnerStub.run).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Create image from the read-only view (guards)
  // ------------------------------------------------------------------

  it('openReadCreateImageDialog bails for a non-assistant node', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'q1')!; // user
    editingRef = false;
    readSelectionRef = 'some script';

    await controller.openReadCreateImageDialog();

    expect(createImageStub.open).not.toHaveBeenCalled();
    expect(runnerStub.run).not.toHaveBeenCalled();
  });

  it('openReadCreateImageDialog refuses when nothing is marked', async () => {
    await open();
    nodeRef = chatService.nodes().find(n => n.id === 'a1')!;
    editingRef = false;
    readSelectionRef = null;

    await controller.openReadCreateImageDialog();

    expect(toastError).toHaveBeenCalled();
    expect(createImageStub.open).not.toHaveBeenCalled();
  });
});

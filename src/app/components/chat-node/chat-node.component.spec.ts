import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { ChatNodeComponent } from './chat-node.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat/chat.service';
import { SettingsService } from '../../core/settings/settings.service';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { NodeEditSession } from '../../core/chat/node-edit-session';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeAttachment, makeModel, makeNode, seedApi } from '../../../../test-helpers/factories';
import { ChatNode } from '../../models/chat';
import { ModelEntry } from '../../models/chat-config';
import { AttachmentClipboardService } from '../../core/clipboard/attachment-clipboard.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { LightboxService } from '../../core/dialogs/lightbox.service';
import { decodeDataUrlToText } from '../../core/llm/llm-message';
import { IllustrateDialogService } from '../../core/dialogs/illustrate-dialog.service';
import { PrependDialogService } from '../../core/dialogs/prepend-dialog.service';
import { RewriteDialogService } from '../../core/dialogs/rewrite-dialog.service';
import { CreateImageDialogService } from '../../core/dialogs/create-image-dialog.service';
import { LlmUseCaseRunner, LlmOrchestratorService } from '../../core/llm/orchestration';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';

/** Thin aliases over the shared test-helpers factories. */
const node = makeNode;
const attachment = makeAttachment;

function seedSettings(api: InMemoryChatApi): void {
  seedApi(api, {
    providers: [{ id: 'prov-1' }],
    models: [{ id: 'm-1' }, { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }],
  });
}

describe('ChatNodeComponent', () => {
  let fixture: ComponentFixture<ChatNodeComponent>;
  let component: ChatNodeComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let settings: SettingsService;
  let confirm: ConfirmService;
  let toast: ToastService;
  let llm: {
    streamAnswer: ReturnType<typeof vi.fn>;
    askLlm: ReturnType<typeof vi.fn>;
    resolveForCurrentChat: ReturnType<typeof vi.fn>;
    toLlmExtras: ReturnType<typeof vi.fn>;
    generateImage: ReturnType<typeof vi.fn>;
  };
  let illustrateDialog: { open: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
  let prependDialog: { open: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
  let rewriteDialog: { open: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
  let createImageDialog: { open: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
  let runner: { run: ReturnType<typeof vi.fn> };
  let orch: {
    completion: ReturnType<typeof vi.fn>;
    completeImage: ReturnType<typeof vi.fn>;
    images: ReturnType<typeof vi.fn>;
  };
  let emitted: string[];

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    seedSettings(api);
    localStorage.clear();

    vi.spyOn(window, 'alert').mockImplementation(() => {});
    if (typeof window.requestAnimationFrame !== 'function') {
      (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      };
    }
    if (typeof window.cancelAnimationFrame !== 'function') {
      (window as any).cancelAnimationFrame = () => {};
    }

    await TestBed.configureTestingModule({
      imports: [ChatNodeComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        {
          provide: IllustrateDialogService,
          useValue: {
            // Default: a simple single-scene, no-style run.
            open: vi.fn(async () => ({ count: 1, style: '', storyboardPrompt: '', purePictures: false, historyMode: 'single', historyNodes: 4, storyboardHistoryNodes: 4, planDescriptions: true })),
            current: vi.fn(() => null)
          }
        },
        {
          provide: PrependDialogService,
          useValue: {
            open: vi.fn(async () => null),
            current: vi.fn(() => null)
          }
        },
        {
          provide: RewriteDialogService,
          useValue: {
            open: vi.fn(async () => null),
            current: vi.fn(() => null)
          }
        },
        {
          provide: CreateImageDialogService,
          useValue: {
            open: vi.fn(async () => null),
            current: vi.fn(() => null)
          }
        },
        {
          provide: LlmUseCaseRunner,
          useValue: {
            // Default: a successful streamed answer "Generated". Mirrors the
            // legacy streamAnswer mock so send tests keep their expectations.
            // For append-with-images it also returns the merged direction so
            // the chat-node can persist it onto the user node. For IMAGE
            // usecases it returns a storyboard slot so the postprocessor
            // places illustration + prompt attachments on the chapter.
            run: vi.fn(async (
              build: {
                usecase?: string;
                vars?: { content?: string; promptText?: string; count?: number };
              },
              opts?: { onChunk?: (c: unknown) => void },
            ) => {
              opts?.onChunk?.({ content: 'Generated' });
              const slots: Record<string, unknown> = { text: { status: 'ok', value: 'Generated' } };
              const imgUse = (build?.usecase ?? '').startsWith('storyboard')
                || (build?.usecase ?? '').startsWith('planned')
                || (build?.usecase ?? '').startsWith('render')
                || (build?.usecase ?? '').startsWith('image');
              if (imgUse) {
                const count = build.vars?.count ?? 1;
                const sceneText = build.vars?.promptText ?? build.vars?.content ?? 'Scene';
                if (count > 1) {
                  // Storyboard: one scene per picture (each 1 image).
                  slots['storyboard'] = {
                    status: 'ok',
                    value: Array.from({ length: count }).map((_, i) => ({
                      scene: i + 1,
                      prompt: `scene ${i + 1}: ${sceneText}`,
                      images: [{ url: `data:image/png;base64,QQ${'A'.repeat(i)}` }],
                      refused: false
                    }))
                  };
                } else {
                  const one = { url: 'data:image/png;base64,QQ==' };
                  slots['images'] = { status: 'ok', value: [one] };
                  slots['storyboard'] = {
                    status: 'ok',
                    value: [{ scene: 1, prompt: sceneText, images: [one], refused: false }]
                  };
                }
              } else if (build?.usecase === 'append-with-images' && build.vars?.content) {
                slots['direction'] = {
                  status: 'ok',
                  value: `${build.vars.content}\n\na red ball.`,
                };
              }
              return slots;
            })
          }
        },
        {
          // Mock the ORCHESTRATOR (transport), NOT the flow runner: the real
          // flows then create + stream against the real (in-memory) ChatService,
          // so node-shape assertions in the branch/insert/regenerate/prepend
          // tests keep working.
          provide: LlmOrchestratorService,
          useValue: {
            completion: vi.fn(async (
              _cx: unknown,
              _req: unknown,
              opts?: { onChunk?: (c: unknown) => void },
            ) => {
              opts?.onChunk?.({ content: 'Generated' });
              return { text: { status: 'ok', value: 'Generated' } };
            }),
            completeImage: vi.fn(async () => ({ images: { status: 'refused', value: null } })),
            images: vi.fn(async () => ({ images: { status: 'refused', value: null } }))
          }
        },
      ],
    }).compileComponents();

    chatService = TestBed.inject(ChatService);
    settings = TestBed.inject(SettingsService);
    confirm = TestBed.inject(ConfirmService);
    toast = TestBed.inject(ToastService);
    toast.clear();
    runner = TestBed.inject(LlmUseCaseRunner) as unknown as {
      run: ReturnType<typeof vi.fn>;
    };
    orch = TestBed.inject(LlmOrchestratorService) as unknown as {
      completion: ReturnType<typeof vi.fn>;
      completeImage: ReturnType<typeof vi.fn>;
      images: ReturnType<typeof vi.fn>;
    };
    illustrateDialog = TestBed.inject(IllustrateDialogService) as unknown as {
      open: ReturnType<typeof vi.fn>;
      current: ReturnType<typeof vi.fn>;
    };
    prependDialog = TestBed.inject(PrependDialogService) as unknown as {
      open: ReturnType<typeof vi.fn>;
      current: ReturnType<typeof vi.fn>;
    };
    rewriteDialog = TestBed.inject(RewriteDialogService) as unknown as {
      open: ReturnType<typeof vi.fn>;
      current: ReturnType<typeof vi.fn>;
    };
    createImageDialog = TestBed.inject(CreateImageDialogService) as unknown as {
      open: ReturnType<typeof vi.fn>;
      current: ReturnType<typeof vi.fn>;
    };
    TestBed.inject(I18nService).setLocale('en');

    await settings.loadAll();
  });

  /** Render the component for a single node. */
  function createFixture(cn: ChatNode, activeChildId: string | null = null): void {
    fixture = TestBed.createComponent(ChatNodeComponent);
    component = fixture.componentInstance;
    emitted = [];
    component.activate.subscribe((id: string) => emitted.push(id));
    fixture.componentRef.setInput('node', cn);
    if (activeChildId !== null) fixture.componentRef.setInput('activeChildId', activeChildId);
    fixture.detectChanges();
  }

  /** Seed a chat + tree and make it the active chat (mirrors real navigation). */
  async function openChat(tree: ChatNode[], chatId = 'chat-1', title = 'Story'): Promise<void> {
    const now = new Date().toISOString();
    api.chats.push({
      id: chatId,
      title,
      projectId: null,
      node_number: tree.length,
      created_at: now,
      updated_at: now,
    });
    api.nodes = tree;
    await chatService.loadChats();
    await chatService.selectChat(chatId);
  }

  async function startEditing(_cn?: ChatNode): Promise<void> {
    await component.startEdit();
    fixture.detectChanges();
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
  }

  function findButton(text: string): HTMLButtonElement | null {
    return buttons().find((b) => (b.textContent || '').includes(text)) ?? null;
  }

  function titleButton(title: string): HTMLButtonElement | null {
    return buttons().find((b) => b.getAttribute('title') === title) ?? null;
  }

  function confirmResolves(value: boolean): void {
    vi.spyOn(confirm, 'ask').mockResolvedValue(value);
  }

  /** Make the next Prepend dialog resolve with the given director text. */
  function prependConfirm(text: string | null): void {
    (prependDialog.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce(text);
  }

  function expectButtonDisabled(btn: HTMLButtonElement | null): void {
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
  }

  // ------------------------------------------------------------------
  // Node chrome
  // ------------------------------------------------------------------

  describe('node chrome', () => {
    it('shows the Dir badge for a user node and the Ch badge for an assistant', () => {
      createFixture(node({ role: 'user', content: 'Hello' }));
      expect(fixture.nativeElement.querySelector('.badge.question')).not.toBeNull();

      createFixture(node({ role: 'assistant', content: 'Hi' }));
      expect(fixture.nativeElement.querySelector('.badge.answer')).not.toBeNull();
    });

    it('shows the version and char count metadata', () => {
      createFixture(node({ role: 'assistant', content: '12345', version: 3 }));
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('v3');
      expect(text).toContain('5 chars');
    });

    it('applies role and draft CSS classes to the container', () => {
      createFixture(node({ role: 'user', content: 'Hello' }));
      let el = fixture.nativeElement.querySelector('.node');
      expect(el).not.toBeNull();
      expect((el as HTMLElement).classList).toContain('question-node');
      expect((el as HTMLElement).classList).not.toContain('answer-node');

      createFixture(node({ role: 'assistant', content: 'Hi' }));
      el = fixture.nativeElement.querySelector('.node');
      expect((el as HTMLElement).classList).toContain('answer-node');
    });

    it('emits the data-node-id attribute', () => {
      createFixture(node({ id: 'custom-42' }));
      expect(fixture.nativeElement.querySelector('.node')?.getAttribute('data-node-id')).toBe(
        'custom-42',
      );
    });

    it('exposes the node through the node input signal', () => {
      const cn = node({ id: 'abc', role: 'assistant' });
      createFixture(cn);
      expect(component.node()).toEqual(cn);
    });
  });

  // ------------------------------------------------------------------
  // Branch switcher
  // ------------------------------------------------------------------

  describe('branch switcher', () => {
    it('is hidden when the node has no siblings', () => {
      createFixture(node({ content: 'Only child' }));
      expect(fixture.nativeElement.querySelector('.branch-switcher')).toBeNull();
    });

    it('shows the branch count when siblings exist', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      await openChat([q1, q2]);
      createFixture(q1, q2.id);
      expect(fixture.nativeElement.querySelector('.branch-switcher')).not.toBeNull();
      const text =
        (fixture.nativeElement.querySelector('.branch-count') as HTMLElement).textContent ?? '';
      expect(text).toContain('2 / 2');
    });

    it('navigates to the previous sibling via prevSibling()', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      await openChat([q1, q2]);
      createFixture(q1, q2.id);
      component.prevSibling();
      expect(emitted).toEqual(['q1']);
    });

    it('navigates to the next sibling via nextSibling()', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      await openChat([q1, q2]);
      createFixture(q2, q1.id);
      component.nextSibling();
      expect(emitted).toEqual(['q2']);
    });

    it('does nothing for a single node', () => {
      createFixture(node({ content: 'Solo' }));
      component.prevSibling();
      component.nextSibling();
      expect(emitted).toEqual([]);
    });

    it('prev/next buttons call prevSibling/nextSibling', async () => {
      const q1 = node({ id: 'q1', content: 'First' });
      const q2 = node({ id: 'q2', content: 'Second' });
      const q3 = node({ id: 'q3', content: 'Third' });
      await openChat([q1, q2, q3]);
      createFixture(q1, q2.id);
      const prev = titleButton('Previous continuation');
      const next = titleButton('Next continuation');
      expect(prev).not.toBeNull();
      expect(next).not.toBeNull();

      prev!.click();
      expect(emitted).toEqual(['q1']);

      emitted.length = 0;
      next!.click();
      expect(emitted).toEqual(['q3']);
    });
  });

  // ------------------------------------------------------------------
  // Delete / remove
  // ------------------------------------------------------------------

  describe('delete & remove buttons', () => {
    it('renders delete and remove buttons for a user node', () => {
      createFixture(node({ content: 'Hello' }));
      expect(titleButton('Delete this section and all following text')).not.toBeNull();
      expect(
        titleButton(
          'Delete this section only. Following text stays and attaches to its predecessor.',
        ),
      ).not.toBeNull();
    });

    it('deletes the node and its subtree after confirmation', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      await openChat([q1]);
      confirmResolves(true);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')).toBeUndefined();
      // the app guarantees the active path ends on an empty question
      expect(chatService.nodes().some((n) => n.role === 'user' && !n.content?.trim())).toBe(true);
    });

    it('keeps the node when confirmation is declined', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      await openChat([q1]);
      confirmResolves(false);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')).not.toBeUndefined();
    });

    it('does not ask for confirmation on a trivial (empty) node', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      createFixture(q1);

      await component.deleteNode();
      fixture.detectChanges();

      expect(confirm.ask).not.toHaveBeenCalled();
      expect(chatService.nodes().find((n) => n.id === 'q1')).toBeUndefined();
    });

    it('remove keeps the children and reparents them to the parent', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      confirmResolves(true);
      createFixture(q1);

      await component.deleteNodeOnly();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')).toBeUndefined();
      expect(chatService.nodes().find((n) => n.id === 'a1')?.parentId).toBeNull();
      // after removal the remaining child becomes active
      expect(emitted).toContain('a1');
    });

    it('disables the delete button while a generation is running', () => {
      chatService.startGeneration('n1');
      createFixture(node({ id: 'n1', content: 'Hello' }));
      expectButtonDisabled(titleButton('Delete this section and all following text'));
      chatService.stopGeneration();
    });
  });

  // ------------------------------------------------------------------
  // Copy
  // ------------------------------------------------------------------

  describe('copy button', () => {
    it('copies the node content to the clipboard and shows the copied state', async () => {
      const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
      (navigator as any).clipboard = clipboard;
      createFixture(node({ content: 'Copy me' }));

      await component.copyContent();
      fixture.detectChanges();

      expect(clipboard.writeText).toHaveBeenCalledWith('Copy me');
      expect(component.copied()).toBe(true);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Copied');
    });
  });

  // ------------------------------------------------------------------
  // Thinking + prior versions toggles
  // ------------------------------------------------------------------

  describe('thinking toggle', () => {
    it('exposes hasThinking and shows the thinking body once opened', () => {
      const cn = node({ role: 'assistant', content: 'Answer', thinking: 'Chain of thought' });
      createFixture(cn);

      expect(component.hasThinking()).toBe(true);
      expect(fixture.nativeElement.querySelector('.thinking-body')).toBeNull();

      const toggle = fixture.nativeElement.querySelector('.thinking-toggle') as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      toggle.click();
      fixture.detectChanges();

      expect(component.thinkingClosed()).toBe(false);
      expect(fixture.nativeElement.querySelector('.thinking-body')).not.toBeNull();
    });

    it('hides the toggle when there is no thinking text', () => {
      createFixture(node({ role: 'assistant', content: 'Answer', thinking: null }));
      expect(component.hasThinking()).toBe(false);
      expect(fixture.nativeElement.querySelector('.thinking-toggle')).toBeNull();
    });
  });

  describe('prior versions toggle', () => {
    it('shows prior versions when opened', async () => {
      const prev = node({
        id: 'v1',
        chatId: 'chat-1',
        parentId: null,
        role: 'assistant',
        content: 'Older',
        previousVersionId: null,
        version: 1,
      });
      const cur = node({
        id: 'v2',
        chatId: 'chat-1',
        parentId: null,
        role: 'assistant',
        content: 'Newer',
        previousVersionId: 'v1',
        version: 2,
      });

      api.nodes = [prev, cur];
      await chatService.loadNodes('chat-1');
      createFixture(cur);

      expect(component.priorVersions().map((v) => v.id)).toEqual(['v1']);

      const toggle = fixture.nativeElement.querySelector('.prior-toggle') as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      toggle.click();
      fixture.detectChanges();

      expect(component.showPriorVersions()).toBe(true);
      expect(fixture.nativeElement.querySelectorAll('.prior-version').length).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // Editing: enter / cancel
  // ------------------------------------------------------------------

  describe('editing: enter & cancel', () => {
    it('starts editing and opens the inline editor', async () => {
      createFixture(node({ content: 'Hello' }));
      expect(component.isEditing()).toBe(false);
      expect(fixture.nativeElement.querySelector('.inline-content-editor')).toBeNull();

      await startEditing(node({ content: 'Hello' }));
      expect(component.isEditing()).toBe(true);
      expect(fixture.nativeElement.querySelector('.inline-content-editor')).not.toBeNull();
    });

    it('opens the editor from the edit button', async () => {
      createFixture(node({ content: 'Hello' }));
      const edit = titleButton('Edit this section in place');
      expect(edit).not.toBeNull();
      edit!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.isEditing()).toBe(true);
    });

    it('starts editing when the empty question content is clicked', async () => {
      createFixture(node({ role: 'user', content: '' }));
      const area = fixture.nativeElement.querySelector('.empty-draft.click-to-edit') as HTMLElement;
      expect(area).not.toBeNull();
      area.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.isEditing()).toBe(true);
    });

    it('prefills the draft with the current content', async () => {
      createFixture(node({ content: 'Original' }));
      await startEditing(node({ content: 'Original' }));
      expect(component.contentDraft()).toBe('Original');
    });

    it('cancel clears the draft and closes the editor', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      component.onDraftText('Changed');
      expect(component.isDraftEmpty()).toBe(false);
      confirmResolves(true);

      await component.cancelEdit();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      expect(component.contentDraft()).toBe('');
      expect(fixture.nativeElement.querySelector('.inline-content-editor')).toBeNull();
    });

    it('asks for confirmation when cancelling a dirty editor', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      component.onDraftText('Changed');
      confirmResolves(false);

      await component.cancelEdit();
      fixture.detectChanges();

      expect(confirm.ask).toHaveBeenCalled();
      expect(component.isEditing()).toBe(true);
    });

    it('manual typing goes through onDraftText and syncs the edit session', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      component.onDraftText('Typed text');
      const session = TestBed.inject(NodeEditSession);
      expect(component.contentDraft()).toBe('Typed text');
      expect(session.isDirty()).toBe(true);
    });

    it('setDraftFromSearch updates the live draft and the edit session', async () => {
      createFixture(node({ content: 'Hello world' }));
      await startEditing(node({ content: 'Hello world' }));

      component.setDraftFromSearch('Hello evening');

      const session = TestBed.inject(NodeEditSession);
      expect(component.isEditing()).toBe(true);
      expect(component.contentDraft()).toBe('Hello evening');
      expect(session.state()?.draftText).toBe('Hello evening');
      // The textarea shows exactly what the next search will match against.
      // (ngModel pushes the new value to the DOM in a microtask.)
      fixture.detectChanges();
      await fixture.whenStable();
      const ta = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      expect(ta.value).toBe('Hello evening');
    });

    it('setDraftFromSearch is a no-op while the editor is closed', async () => {
      createFixture(node({ content: 'Hello' }));
      component.setDraftFromSearch('Changed');
      expect(component.isEditing()).toBe(false);
      expect(component.contentDraft()).toBe('');
      const session = TestBed.inject(NodeEditSession);
      expect(session.state()).toBeNull();
    });

    it('Ctrl+Enter saves a version from the editor', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Edited via shortcut');

      const textarea = fixture.nativeElement.querySelector(
        '.editor-textarea',
      ) as HTMLTextAreaElement;
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
      await fixture.whenStable();
      fixture.detectChanges();

      expect(
        chatService.nodes().some((n) => n.role === 'user' && n.content === 'Edited via shortcut'),
      ).toBe(true);
    });

    it('Escape cancels the editor', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      const textarea = fixture.nativeElement.querySelector(
        '.editor-textarea',
      ) as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.isEditing()).toBe(false);
    });

    it('Ctrl+S saves the node and closes the editor', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Edited via Ctrl+S');

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
      );
      await fixture.whenStable();
      fixture.detectChanges();

      expect(
        chatService.nodes().some((n) => n.role === 'user' && n.content === 'Edited via Ctrl+S'),
      ).toBe(true);
      expect(component.isEditing()).toBe(false);
    });

    it('Ctrl+S is ignored while the editor is closed', async () => {
      createFixture(node({ content: 'Hello' }));
      const save = vi.spyOn(component, 'saveAsVersion').mockResolvedValue(undefined);

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
      );
      await fixture.whenStable();

      expect(save).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Editing: scroll continuity (read-only view → editor textarea)
  // ------------------------------------------------------------------

  describe('editing: scroll continuity (ro → editor)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Fake DOMRect standing in for jsdom's all-zero layout metrics. */
    function fakeRect(top: number, bottom: number): DOMRect {
      return {
        top,
        bottom,
        left: 0,
        right: 100,
        width: 100,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    }

    it('captures the source offset of the first visible sentence in the ro view', async () => {
      const q1 = node({
        id: 'q1',
        role: 'user',
        content: 'First sentence one.\n\nSecond sentence two.\n\nThird sentence three.',
      });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      // jsdom has no layout: report the whole viewport as the visible band and
      // fake per-paragraph rects so only the SECOND paragraph is visible (the
      // first sits above the band, the third below it). jsdom's Range has no
      // getBoundingClientRect, so a fake range supplies the metrics.
      vi.spyOn(component as any, 'scrollParentOf').mockReturnValue(null);
      vi.spyOn(document, 'createRange').mockImplementation(() => {
        let startNode: Node | null = null;
        return {
          selectNodeContents(n: Node) {
            startNode = n;
          },
          get startContainer(): Node | null {
            return startNode;
          },
          getBoundingClientRect(): DOMRect {
            const text = (startNode?.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (text.startsWith('First sentence one.')) return fakeRect(-500, -480); // above
            if (text.startsWith('Second sentence two.')) return fakeRect(400, 430); // visible
            return fakeRect(900, 930); // below
          },
        } as unknown as Range;
      });

      const offset = (component as any).captureRoScrollOffset();
      // "Second sentence two." starts at index 21 in the markdown source.
      expect(offset).toBe(21);
    });

    it('applies the captured offset to the textarea when the editor opens', async () => {
      const q1 = node({ id: 'q1', content: 'Hello world' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);

      vi.spyOn(component as any, 'captureRoScrollOffset').mockReturnValue(6);
      const apply = vi
        .spyOn(component as any, 'scrollTextareaToSourceOffset')
        .mockImplementation(() => {});

      await startEditing(q1);
      // The synchronous rAF polyfill runs before the editor is rendered, so the
      // first resize found no textarea yet — re-run it now that it exists.
      fixture.detectChanges();
      component.resizeTextarea();

      expect(apply).toHaveBeenCalledWith(expect.anything(), 6);
      expect((component as any).pendingScrollOffset).toBeNull();
    });

    it('positions the caret + scroll at the captured offset after focus (not at the end)', async () => {
      const q1 = node({ id: 'q1', content: 'Hello world' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);

      vi.spyOn(component as any, 'captureRoScrollOffset').mockReturnValue(6);
      // jsdom has no layout — stub the mirror measurement so the restored
      // scrollTop is deterministic.
      vi.spyOn(component as any, 'scrollTopForOffset').mockReturnValue(42);

      await component.startEdit();
      fixture.detectChanges();
      // ngModel pushes the value to the DOM in a microtask — wait for it.
      await fixture.whenStable();
      // The rAF scheduled during startEdit is async (jsdom), so run the
      // focus/scroll/caret sequence directly now that the textarea exists.
      (component as any).applyEditorScrollAndCaret(6);

      const ta = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      expect(ta).not.toBeNull();
      // Without the explicit caret, focus() would put it at the END (position
      // 11 for 'Hello world') and auto-scroll to the bottom — the reported bug.
      expect(ta.value).toBe('Hello world');
      expect(ta.selectionStart).toBe(6);
      expect(ta.scrollTop).toBe(42);
      expect((component as any).pendingScrollOffset).toBeNull();
    });

    it('scrolls the outer container so the textarea top is on screen', async () => {
      const q1 = node({ id: 'q1', content: 'Hello world' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await component.startEdit();
      fixture.detectChanges();
      await fixture.whenStable();

      const ta = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      expect(ta).not.toBeNull();

      // Realistic scenario: after focus() the container is scrolled PAST the
      // textarea, so its top (viewport y = -50) sits ABOVE the visible band
      // [100..400] — the top must be pulled back down into view, which means
      // scrolling the container UP by `tRect.top - topTarget`.
      const fakeScroller = document.createElement('div');
      document.body.appendChild(fakeScroller);
      let capturedScrollTop = 1000; // container currently scrolled far down
      Object.defineProperty(fakeScroller, 'scrollTop', {
        get: () => capturedScrollTop,
        set: (v: number) => {
          capturedScrollTop = v;
        },
        configurable: true,
      });
      vi.spyOn(component as any, 'scrollParentOf').mockReturnValue(fakeScroller);
      vi.spyOn(fakeScroller, 'getBoundingClientRect').mockReturnValue(fakeRect(100, 400));
      vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(fakeRect(-50, 200));

      (component as any).ensureEditorTopVisible();

      // topTarget = 100 + 8 = 108; delta = tRect.top - topTarget = -50 - 108 = -158.
      expect(capturedScrollTop).toBe(1000 - 158);
      document.body.removeChild(fakeScroller);
    });

    it('scrolls the outer container down when the textarea sits below the fold', async () => {
      const q1 = node({ id: 'q1', content: 'Hello world' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await component.startEdit();
      fixture.detectChanges();
      await fixture.whenStable();

      const ta = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      const fakeScroller = document.createElement('div');
      document.body.appendChild(fakeScroller);
      let capturedScrollTop = 20;
      Object.defineProperty(fakeScroller, 'scrollTop', {
        get: () => capturedScrollTop,
        set: (v: number) => {
          capturedScrollTop = v;
        },
        configurable: true,
      });
      vi.spyOn(component as any, 'scrollParentOf').mockReturnValue(fakeScroller);
      vi.spyOn(fakeScroller, 'getBoundingClientRect').mockReturnValue(fakeRect(100, 400));
      // Textarea entirely BELOW the visible band [100..400].
      vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(fakeRect(500, 760));

      (component as any).ensureEditorTopVisible();

      // delta = tRect.top - topTarget = 500 - 108 = 392.
      expect(capturedScrollTop).toBe(20 + 392);
      document.body.removeChild(fakeScroller);
    });

    it('does not scroll the outer container when the textarea top is already visible', async () => {
      const q1 = node({ id: 'q1', content: 'Hello world' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await component.startEdit();
      fixture.detectChanges();
      await fixture.whenStable();

      const ta = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      const fakeScroller = document.createElement('div');
      document.body.appendChild(fakeScroller);
      let capturedScrollTop = 0;
      Object.defineProperty(fakeScroller, 'scrollTop', {
        get: () => capturedScrollTop,
        set: (v: number) => {
          capturedScrollTop = v;
        },
        configurable: true,
      });
      vi.spyOn(component as any, 'scrollParentOf').mockReturnValue(fakeScroller);
      vi.spyOn(fakeScroller, 'getBoundingClientRect').mockReturnValue(fakeRect(100, 400));
      // Textarea already within the visible band — no scroll expected.
      vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(fakeRect(150, 380));

      (component as any).ensureEditorTopVisible();

      expect(capturedScrollTop).toBe(0);
      document.body.removeChild(fakeScroller);
    });
  });

  // ------------------------------------------------------------------
  // Editing: save as version
  // ------------------------------------------------------------------

  describe('editing: save as version', () => {
    it('saves an edited user question as a new version and activates it', async () => {
      const q1 = node({ id: 'q1', content: 'Original question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Rewritten question');

      await component.saveAsVersion();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      const saved = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Rewritten question');
      expect(saved).not.toBeUndefined();
      expect(saved!.id).not.toBe('q1');
      expect(emitted).toContain(saved!.id);
    });

    it('saves an edited assistant answer as a new version', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old answer',
      });
      await openChat([q1, a1]);
      createFixture(a1);
      await startEditing(a1);
      component.onDraftText('New answer');

      await component.saveAsVersion();
      fixture.detectChanges();

      const saved = chatService
        .nodes()
        .find((n) => n.role === 'assistant' && n.content === 'New answer');
      expect(saved).not.toBeUndefined();
      expect(saved!.id).not.toBe('a1');
      expect(emitted).toContain(saved!.id);
    });

    it('closes the editor without a new node when nothing changed', async () => {
      const q1 = node({ id: 'q1', content: 'Same' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);

      await component.saveAsVersion();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
      expect(chatService.nodes().filter((n) => n.role === 'user' && n.content?.trim()).length).toBe(
        1,
      );
    });

    it('the OK button is disabled while the editor draft is empty', async () => {
      const q1 = node({ id: 'q1', content: 'Hello' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('');
      fixture.detectChanges();
      expectButtonDisabled(findButton('OK'));
    });

    it('OK persists the model selected in the editor onto the saved question', async () => {
      const q1 = node({ id: 'q1', content: 'Original question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Rewritten question');
      // The user switches the editor model before saving the version.
      component.branchModelId.set('beta/model');

      await component.saveAsVersion();
      fixture.detectChanges();

      const saved = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Rewritten question');
      expect(saved).not.toBeUndefined();
      expect(saved!.id).not.toBe('q1');
      // The new version carries the editor-selected model + provider.
      expect(saved!.modelId).toBe('beta/model');
      expect(saved!.providerId).toBe('prov-1');
      expect(emitted).toContain(saved!.id);
    });

    it('OK keeps the node model when the editor model is unchanged', async () => {
      const q1 = node({
        id: 'q1', content: 'Original', modelId: 'alpha/model', providerId: 'prov-1',
      });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Rewritten');
      // branchModelId is seeded to the node's own model — the version keeps it
      // without an extra patch.
      expect(component.branchModelId()).toBe('alpha/model');

      await component.saveAsVersion();
      fixture.detectChanges();

      const saved = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Rewritten');
      expect(saved?.modelId).toBe('alpha/model');
    });
  });

  // ------------------------------------------------------------------
  // Rewrite selection (marked text → model suggestions)
  // ------------------------------------------------------------------

  describe('rewrite selection', () => {
    it('shows the Rewrite button while editing (directions and chapters)', async () => {
      const q1 = node({ id: 'q1', content: 'A direction with some text.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer',
      });
      await openChat([q1, a1]);

      createFixture(q1);
      await startEditing(q1);
      fixture.detectChanges();
      expect(findButton('Rewrite')).not.toBeNull();

      createFixture(a1);
      await startEditing(a1);
      fixture.detectChanges();
      expect(findButton('Rewrite')).not.toBeNull();
    });

    it('requires a marked text before opening the dialog', async () => {
      const q1 = node({ id: 'q1', content: 'A direction with some text.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);

      // No selection (cursor collapsed at 0,0) → the dialog never opens and
      // the user is told to mark the text first.
      await component.openRewriteDialog();
      fixture.detectChanges();
      expect(rewriteDialog.open).not.toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().some(t => t.kind === 'error' && t.text.includes('Mark the text'))).toBe(true);
    });

    it('opens the dialog with the marked fragment + node model and replaces the selection with the result', async () => {
      const content = 'The hero enters the old tower.';
      const q1 = node({
        id: 'q1', content, modelId: 'alpha/model', providerId: 'prov-1',
      });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);

      // Mark "the old tower".
      const start = content.indexOf('the old tower');
      const end = start + 'the old tower'.length;
      const ta = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      ta.value = component.contentDraft();
      ta.setSelectionRange(start, end);

      (rewriteDialog.open as ReturnType<typeof vi.fn>).mockResolvedValue('a ruined keep');
      await component.openRewriteDialog();
      fixture.detectChanges();

      // The dialog was seeded with the marked fragment + the node's model.
      const call = (rewriteDialog.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        fragment?: string; contextMode?: string; modelId?: string; providerId?: string; selectionEnd?: number;
      };
      expect(call.fragment).toBe('the old tower');
      expect(call.contextMode).toBe('node');
      expect(call.modelId).toBe('alpha/model');
      expect(call.providerId).toBe('prov-1');
      expect(call.selectionEnd).toBe(end);

      // The marked range was replaced in the draft (the editor stays open).
      expect(component.contentDraft()).toBe('The hero enters a ruined keep.');
      expect(component.isEditing()).toBe(true);
    });

    it('does nothing when the dialog is cancelled', async () => {
      const content = 'The hero enters the old tower.';
      const q1 = node({ id: 'q1', content });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);

      const start = content.indexOf('the old tower');
      const end = start + 'the old tower'.length;
      const ta = fixture.nativeElement.querySelector('.editor-textarea') as HTMLTextAreaElement;
      ta.value = component.contentDraft();
      ta.setSelectionRange(start, end);
      (rewriteDialog.open as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await component.openRewriteDialog();
      fixture.detectChanges();

      expect(component.contentDraft()).toBe('The hero enters the old tower.');
    });

    afterEach(() => {
      // restore getSelection / alert spies installed per-test below
      vi.restoreAllMocks();
    });

    it('shows the Rewrite button in the non-edit view (directions and chapters)', async () => {
      const q1 = node({ id: 'q1', content: 'A direction with some text.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'The hero enters the old tower.',
      });
      await openChat([q1, a1]);

      createFixture(q1);
      fixture.detectChanges();
      expect(findButton('Rewrite')).not.toBeNull();

      createFixture(a1);
      fixture.detectChanges();
      expect(findButton('Rewrite')).not.toBeNull();
    });

    it('rewrites a marked fragment from the rendered (non-edit) content as a new version', async () => {
      const content = 'The hero enters the old tower.';
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant', content,
        modelId: 'alpha/model', providerId: 'prov-1',
      });
      const q1 = node({ id: 'q1', content: 'Chapter' });
      await openChat([q1, a1]);
      createFixture(a1);
      fixture.detectChanges();

      const mark = 'the old tower';
      const readEl = fixture.nativeElement.querySelector('.node-content') as HTMLElement;
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: readEl,
        focusNode: readEl,
        toString: () => mark,
      } as unknown as Selection);

      (rewriteDialog.open as ReturnType<typeof vi.fn>).mockResolvedValue('a ruined keep');
      await component.openReadRewriteDialog();
      fixture.detectChanges();

      const call = (rewriteDialog.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        fragment?: string; contextMode?: string; modelId?: string; providerId?: string; selectionEnd?: number;
      };
      expect(call.fragment).toBe(mark);
      expect(call.contextMode).toBe('node');
      expect(call.modelId).toBe('alpha/model');
      expect(call.providerId).toBe('prov-1');
      expect(call.selectionEnd).toBe(content.indexOf(mark) + mark.length);

      const saved = chatService.nodes()
        .find(n => n.role === 'assistant' && n.content === 'The hero enters a ruined keep.');
      expect(saved).toBeDefined();
      expect(emitted).toContain(saved!.id);
    });

    it('rewrites a marked fragment whose rendering collapsed whitespace', async () => {
      // The mark spans a line break in the source, so the rendered text has a
      // space where the source has a newline. The lookup must still match.
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant', content: 'The hero enters\nthe old tower.',
      });
      const q1 = node({ id: 'q1', content: 'Chapter' });
      await openChat([q1, a1]);
      createFixture(a1);
      fixture.detectChanges();

      const readEl = fixture.nativeElement.querySelector('.node-content') as HTMLElement;
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: readEl,
        focusNode: readEl,
        toString: () => 'enters the old tower',
      } as unknown as Selection);

      (rewriteDialog.open as ReturnType<typeof vi.fn>).mockResolvedValue('climbs the old tower');
      await component.openReadRewriteDialog();
      fixture.detectChanges();

      const saved = chatService.nodes()
        .find(n => n.role === 'assistant' && n.content === 'The hero climbs the old tower.');
      expect(saved).toBeDefined();
    });

    it('requires a marked fragment in the rendered content before opening the dialog', async () => {
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant', content: 'The hero enters the old tower.',
      });
      await openChat([node({ id: 'q1', content: 'Chapter' }), a1]);
      createFixture(a1);
      fixture.detectChanges();

      // jsdom exposes no real document selection (always collapsed/empty).
      await component.openReadRewriteDialog();
      fixture.detectChanges();

      expect(rewriteDialog.open).not.toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().some(t => t.kind === 'error' && t.text.includes('Mark the text'))).toBe(true);
    });

    it('rewrites a multi-paragraph selection whose rendering differs from the source', async () => {
      // Bold markers and a paragraph break separate the rendered text from
      // the markdown source — a raw text-search used to fail here.
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant',
        content: 'The hero enters **the old tower** and rests.\n\nThen he climbs the stairs.',
        modelId: 'alpha/model', providerId: 'prov-1',
      });
      const q1 = node({ id: 'q1', content: 'Chapter' });
      await openChat([q1, a1]);
      createFixture(a1);
      fixture.detectChanges();

      const readEl = fixture.nativeElement.querySelector('.node-content') as HTMLElement;
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: readEl,
        focusNode: readEl,
        toString: () => 'the old tower and rests. Then he climbs the stairs',
      } as unknown as Selection);

      (rewriteDialog.open as ReturnType<typeof vi.fn>).mockResolvedValue('a ruined keep');
      await component.openReadRewriteDialog();
      fixture.detectChanges();

      const saved = chatService.nodes()
        .find(n => n.role === 'assistant' && n.content === 'The hero enters a ruined keep.');
      expect(saved).toBeDefined();
    });

    it('never loses the rewrite — appends it at the end when the marked text cannot be mapped back', async () => {
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant',
        content: 'The hero enters the old tower.',
        modelId: 'alpha/model', providerId: 'prov-1',
      });
      const q1 = node({ id: 'q1', content: 'Chapter' });
      await openChat([q1, a1]);
      createFixture(a1);
      fixture.detectChanges();

      // The selection text does NOT appear in the markdown source, so the
      // marker map cannot locate it — the rewrite must not be thrown away.
      const readEl = fixture.nativeElement.querySelector('.node-content') as HTMLElement;
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: readEl,
        focusNode: readEl,
        toString: () => 'a scent of the forest',
      } as unknown as Selection);

      (rewriteDialog.open as ReturnType<typeof vi.fn>).mockResolvedValue('a ruined keep');
      await component.openReadRewriteDialog();
      fixture.detectChanges();

      const saved = chatService.nodes()
        .find(n => n.role === 'assistant' && n.content === 'The hero enters the old tower.\n\na ruined keep');
      expect(saved).toBeDefined();
      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().some(t => t.text.includes('appended'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Create image from a selection (assistant chapters)
  // ------------------------------------------------------------------

  describe('create image (selection)', () => {
    afterEach(() => {
      // restore getSelection spies installed per-test below
      vi.restoreAllMocks();
    });

    function seedImageModel(): void {
      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
    }

    it('shows the Create image button only for assistant chapters with content', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'The hero enters the old tower.',
      });
      await openChat([q1, a1]);

      createFixture(q1);
      fixture.detectChanges();
      expect(findButton('Create image')).toBeNull();

      createFixture(a1);
      fixture.detectChanges();
      expect(findButton('Create image')).not.toBeNull();
    });

    it('requires a marked fragment in the rendered content before opening the dialog', async () => {
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant', content: 'The hero enters the old tower.',
      });
      await openChat([node({ id: 'q1', content: 'Chapter' }), a1]);
      createFixture(a1);
      fixture.detectChanges();

      // jsdom exposes no real document selection (always collapsed/empty).
      await component.openReadCreateImageDialog();
      fixture.detectChanges();

      expect(createImageDialog.open).not.toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().some(t => t.kind === 'error' && t.text.includes('Mark the text'))).toBe(true);
    });

    it('opens the dialog with the marked text + the configured image model and attaches the created picture', async () => {
      const content = 'The hero enters the old tower.';
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant', content,
        modelId: 'alpha/model', providerId: 'prov-1',
      });
      const q1 = node({ id: 'q1', content: 'Chapter' });
      await openChat([q1, a1]);
      seedImageModel();
      createFixture(a1);
      fixture.detectChanges();

      const mark = 'the old tower';
      const readEl = fixture.nativeElement.querySelector('.node-content') as HTMLElement;
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: readEl,
        focusNode: readEl,
        toString: () => mark,
      } as unknown as Selection);

      // The dialog is confirmed with a chat constant + the marked text + one
      // reference image.
      (createImageDialog.open as ReturnType<typeof vi.fn>).mockResolvedValue({
        constant: 'noir ink drawing',
        script: mark,
        images: [attachment({
          id: 'ref1', name: 'memo.png', mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,REF'
        })],
        modelId: 'alpha/model',
        providerId: 'prov-1'
      });
      await component.openReadCreateImageDialog();
      fixture.detectChanges();

      // The dialog was seeded with the marked text + the default model.
      const call = (createImageDialog.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        script?: string; modelId?: string; providerId?: string; node?: { id?: string };
      };
      expect(call.script).toBe(mark);
      expect(call.modelId).toBe('alpha/model');
      expect(call.providerId).toBe('prov-1');
      expect(call.node?.id).toBe('a1');

      // Routes through the orchestration `image-send` use case; the prompt is
      // the combined constant + marked text, the reference image is forwarded.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { promptText?: string; attachments?: unknown[]; count?: number; modelId?: string };
      };
      expect(build.usecase).toBe('image-send');
      expect(build.vars?.promptText).toBe('noir ink drawing\n\nthe old tower');
      expect(build.vars?.attachments).toHaveLength(1);
      expect(build.vars?.count).toBe(1);
      expect(build.vars?.modelId).toBe('alpha/model');

      // The created picture (illustration + prompt record) is attached to the
      // assistant node via editAssistant (versioned — find the node carrying
      // the new attachment).
      const versioned = chatService.nodes().find(n => n.role === 'assistant'
        && n.attachments?.some(a => a.name === 'illustration-1.png'));
      expect(versioned).toBeDefined();
      expect(versioned!.attachments!.some(a => a.name === 'prompt-1.txt')).toBe(true);
      expect(emitted).toContain(versioned!.id);
    });

    it('does nothing when the dialog is cancelled', async () => {
      const a1 = node({
        id: 'a1', chatId: 'chat-1', role: 'assistant', content: 'The hero enters the old tower.',
      });
      const q1 = node({ id: 'q1', content: 'Chapter' });
      await openChat([q1, a1]);
      seedImageModel();
      createFixture(a1);
      fixture.detectChanges();

      const readEl = fixture.nativeElement.querySelector('.node-content') as HTMLElement;
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: readEl,
        focusNode: readEl,
        toString: () => 'the old tower',
      } as unknown as Selection);

      (createImageDialog.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      await component.openReadCreateImageDialog();
      fixture.detectChanges();

      expect(runner.run).not.toHaveBeenCalled();
      const chapter = chatService.nodes().find(n => n.role === 'assistant' && n.content === 'The hero enters the old tower.')!;
      expect(chapter.attachments?.length ?? 0).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Draft composer (unsent question)
  // ------------------------------------------------------------------

  describe('draft composer (unsent question)', () => {
    it('is an unsent leaf question', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      expect(component.isUnsentQuestion()).toBe(true);
      expect(component.showClosedContinue()).toBe(true);
    });

    it('shows Continue, Switch characters and Chapter descriptions in the bottom action row for a closed empty question', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      fixture.detectChanges();
      const labels = Array.from(
        fixture.nativeElement.querySelectorAll('.node-actions .btn-icon')
      ).map((b) => (b as HTMLElement).textContent?.trim());
      expect(labels).toContain('Continue');
      expect(labels).toContain('Switch characters');
      expect(labels).toContain('Chapter descriptions');
    });

    it('shows Continue, Switch characters and Chapter descriptions in the editor bottom bar for an empty draft', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      await startEditing(q1);
      expect(findButton('Continue')).not.toBeNull();
      expect(findButton('Switch characters')).not.toBeNull();
      expect(findButton('Chapter descriptions')).not.toBeNull();
    });

    it('sends the draft: persists the question and streams an answer', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      component.onDraftText('Tell me a story');
      await component.sendDraft();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')?.content).toBe('Tell me a story');
      expect(emitted).toContain('q1');
      // Text-only send routes through the orchestration `append` use case.
      expect(runner.run).toHaveBeenCalled();
      const build = runner.run.mock.calls[0][0] as { usecase?: string; vars?: { content?: string } };
      expect(build.usecase).toBe('append');
      expect(build.vars?.content).toBe('Tell me a story');
      // A new assistant answer node was created + streamed live.
      const answers = chatService.nodes().filter((n) => n.role === 'assistant' && n.parentId === 'q1');
      expect(answers.length).toBeGreaterThanOrEqual(1);
      expect(answers[0].content).toBe('Generated');
      expect(component.isEditing()).toBe(false);
    });

    it('updates the chat title from the first line when the chat is still "New Chat"', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1], 'chat-1', 'New Chat');
      createFixture(q1);

      component.onDraftText('My brand new story');
      await component.sendDraft();
      fixture.detectChanges();

      expect(chatService.chats().find((c) => c.id === 'chat-1')?.title).toBe('My brand new story');
    });

    it('finalizes an IMAGE-ONLY append answer with its attachment (no "Generation stopped" empty node)', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      component.onDraftText('Render the scene');
      // The image-capable model streamed ONLY an image back (no text) — the
      // runner returns an images slot with a refused/empty text slot.
      (runner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        text: { status: 'refused', value: null },
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,QQ==' }] }
      });
      await component.sendDraft();
      fixture.detectChanges();

      // The answer node is finalized (versioned) with the image attachment,
      // instead of staying an empty placeholder. The model returned ONLY an
      // image, so the chapter is filled with the direction text and the
      // generated picture is attached below it.
      const answers = chatService.nodes().filter((n) => n.role === 'assistant' && n.parentId === 'q1');
      const withImg = answers.find(n => (n.attachments ?? []).length > 0);
      expect(withImg).toBeTruthy();
      expect(withImg!.content).toBe('Render the scene');
      expect(withImg!.attachments![0].name).toMatch(/^illustration-1\./);
      expect(withImg!.attachments![0].dataUrl).toBe('data:image/png;base64,QQ==');
      // The user node was persisted as the question.
      expect(chatService.nodes().find((n) => n.id === 'q1')?.content).toBe('Render the scene');
    });

    it('routes image-bearing directions through the append-with-images use case', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      // Configure the image-interpret task to a (vision-capable) model.
      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-interpret', { providerId: 'prov-1', modelId: 'alpha/model' });

      const img = attachment({
        id: 'img',
        name: 'pic.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
      });

      await component.startEdit();
      component.editAttachments.set([img]);
      component.onDraftText('Continue from this picture');
      await component.sendDraft();
      fixture.detectChanges();

      // The send routes through the orchestration `append-with-images` use
      // case: the runner gets the attachments so the image-interpret step
      // happens inside the orchestration layer.
      expect(runner.run).toHaveBeenCalled();
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { content?: string; attachments?: unknown[] };
      };
      expect(build.usecase).toBe('append-with-images');
      expect(build.vars?.content).toBe('Continue from this picture');
      expect((build.vars?.attachments ?? []).length).toBe(1);

      const answers = chatService.nodes().filter((n) => n.role === 'assistant' && n.parentId === 'q1');
      expect(answers[0].content).toBe('Generated');

      // The merged description was persisted onto the USER node content for
      // real, so it is available in the history (the image itself stays an
      // attachment but is never sent to the LLM). No UI prefix is stored.
      const q1node = chatService.nodes().find((n) => n.id === 'q1')!;
      expect(q1node.content).toBe('Continue from this picture\n\na red ball.');
      // The image attachment is preserved on the node (for display).
      expect(q1node.attachments?.length).toBe(1);
    });

    it('the send button is disabled for an empty draft', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      await startEditing(q1);
      expectButtonDisabled(findButton('Send'));
    });

    it('continueDraft fills "continue", sends it, and closes the editor', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      await component.continueDraft();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')?.content).toBe('continue');
      expect(emitted).toContain('q1');
      expect(component.isEditing()).toBe(false);
    });

    it('continueDraft uses the editable "Continue" template', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      const pd = TestBed.inject(PromptDefaultsService);
      const realEffective = pd.effective.bind(pd);
      vi.spyOn(pd, 'effective').mockImplementation((id: string, topicId?: string | null) =>
        id === 'structure.continue' ? 'continue the story' : realEffective(id, topicId)
      );

      await component.continueDraft();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')?.content).toBe('continue the story');
      expect(emitted).toContain('q1');
      expect(component.isEditing()).toBe(false);
    });

    it('switchCharactersDraft fills the "switch characters" template, sends it, and closes the editor', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      await component.switchCharactersDraft();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'q1')?.content).toBe('switch characters');
      expect(emitted).toContain('q1');
      expect(component.isEditing()).toBe(false);
    });

    it('the repeat counter clamps to the [1, 20] range', () => {
      const q1 = node({ id: 'q1', content: '' });
      openChat([q1]);
      createFixture(q1);

      expect(component.repeatCount()).toBe(1);
      component.decRepeat();
      expect(component.repeatCount()).toBe(1); // clamped at the minimum

      component.incRepeat();
      component.incRepeat();
      expect(component.repeatCount()).toBe(3);

      for (let i = 0; i < 30; i++) component.incRepeat();
      expect(component.repeatCount()).toBe(20); // clamped at the maximum
    });

    it('continueDraft with repeatCount>1 chains one "continue" send per leaf', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      const pd = TestBed.inject(PromptDefaultsService);
      const realEffective = pd.effective.bind(pd);
      vi.spyOn(pd, 'effective').mockImplementation((id: string, topicId?: string | null) =>
        id === 'structure.continue' ? 'continue the story' : realEffective(id, topicId)
      );

      component.repeatCount.set(3);
      await component.continueDraft();
      fixture.detectChanges();

      // 3 directions + 3 answers, each 'continue the story' on a successive leaf.
      const continues = chatService.nodes().filter(
        (n) => n.role === 'user' && n.content === 'continue the story'
      );
      expect(continues).toHaveLength(3);
      // One final placeholder per send is later versioned — count the settled
      // answers with actual generated content.
      const answers = chatService.nodes().filter(
        (n) => n.role === 'assistant' && n.content === 'Generated' && n.isCurrent
      );
      expect(answers).toHaveLength(3);
      // Batch progress published and cleared again.
      expect(chatService.batchProgress()).toBeNull();
      expect(component.isLoading()).toBe(false);
      expect(component.pendingAction()).toBeNull();
    });

    it('continueDraft batch stops early when the operation is cancelled', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      component.repeatCount.set(5);
      // Cancel before the first send: the loop must not run. The loop now
      // consults shouldStopAfterCurrentStep() — true for a hard Stop (aborted
      // operation signal) as well as a graceful "Finish & stop" request.
      vi.spyOn(chatService, 'shouldStopAfterCurrentStep').mockReturnValue(true);
      await component.continueDraft();

      expect(chatService.nodes().some((n) => n.content === 'continue')).toBe(false);
      expect(chatService.batchProgress()).toBeNull();
      expect(component.isLoading()).toBe(false);
    });

    it('continueDraft batch finishes the CURRENT stream then stops, preserving its result', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      component.repeatCount.set(3);
      // A graceful stop is requested while the first send is in flight: the
      // first between-step check proceeds, every later one breaks the loop.
      const stopSpy = vi.spyOn(chatService, 'shouldStopAfterCurrentStep')
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      await component.continueDraft();
      fixture.detectChanges();

      // Exactly ONE "continue" send ran to completion — and its streamed
      // answer was saved (results preserved) instead of being discarded.
      const continues = chatService.nodes().filter(
        (n) => n.role === 'user' && n.content === 'continue'
      );
      expect(continues).toHaveLength(1);
      const answers = chatService.nodes().filter(
        (n) => n.role === 'assistant' && n.content === 'Generated' && n.isCurrent
      );
      expect(answers).toHaveLength(1);
      // The batch cleared its progress state as usual.
      expect(chatService.batchProgress()).toBeNull();
      expect(component.isLoading()).toBe(false);
      expect(stopSpy).toHaveBeenCalled();
    });

    it('the closed continue button triggers continueDraft without opening the editor', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);
      await component.startEdit();
      // auto-close the editor to get back to the closed state
      await component.cancelEdit();
      fixture.detectChanges();

      expect(component.isEditing()).toBe(false);
    });

    it('a direction followed ONLY by a non-assistant node is NOT unsent — editing saves', async () => {
      // "Delete Continuation" shape: the direction's answer was removed, a
      // fresh empty composer leaf was created UNDER the direction. The
      // direction is an existing node (not the pending terminal composer), so
      // editing it must offer Save — not Send.
      const q1 = node({ id: 'q1', content: 'Real direction' });
      const leaf = node({ id: 'leaf1', parentId: 'q1', role: 'user', content: '' });
      await openChat([q1, leaf]);
      createFixture(q1);

      expect(component.isUnsentQuestion()).toBe(false);
      expect(component.showClosedContinue()).toBe(false);

      await startEditing(q1);
      fixture.detectChanges();
      // Editing allows saving: the OK (save-as-version) button is present and
      // the Send button is not offered.
      expect(findButton('OK')).not.toBeNull();
      expect(findButton('Send')).toBeNull();
    });

    it('a direction whose answer was removed (children kept) is NOT unsent — editing saves', async () => {
      // "Remove (keep children)" shape: q1's answer a1 was deleted, so a
      // following direction q2 is now q1's (only, non-assistant) child.
      const q1 = node({ id: 'q1', content: 'Earlier direction' });
      const q2 = node({ id: 'q2', parentId: 'q1', role: 'user', content: 'Following direction' });
      const a2 = node({ id: 'a2', parentId: 'q2', role: 'assistant', content: 'Answer' });
      await openChat([q1, q2, a2]);
      createFixture(q1);

      expect(component.isUnsentQuestion()).toBe(false);

      await startEditing(q1);
      fixture.detectChanges();
      expect(findButton('OK')).not.toBeNull();
      expect(findButton('Send')).toBeNull();
    });

    it('an answered direction keeps the save behavior (regression guard)', async () => {
      const q1 = node({ id: 'q1', content: 'Direction' });
      const a1 = node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer' });
      await openChat([q1, a1]);
      createFixture(q1);

      expect(component.isUnsentQuestion()).toBe(false);
      await startEditing(q1);
      fixture.detectChanges();
      expect(findButton('OK')).not.toBeNull();
      expect(findButton('Send')).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Branch
  // ------------------------------------------------------------------

  describe('branch', () => {
    it('branches an edited question into a new sibling before streaming', async () => {
      const q1 = node({ id: 'q1', content: 'Original' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Alternative path');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      const branch = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Alternative path');
      expect(branch).not.toBeUndefined();
      expect(branch!.id).not.toBe('q1');
      expect(branch!.parentId).toBeNull(); // sibling of q1
      expect(emitted).toContain(branch!.id);
      // The answer streamed under the new branch (via the flow runner).
      const answer = chatService
        .nodes()
        .find((n) => n.role === 'assistant' && n.parentId === branch!.id);
      expect(answer).toBeDefined();
      expect(answer!.content).toBe('Generated');
    });

    it('branches from an assistant answer by adding a child question', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(a1);
      component.onDraftText('Continue from here');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      const branch = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Continue from here');
      expect(branch).not.toBeUndefined();
      expect(branch!.parentId).toBe('a1');
      expect(emitted).toContain(branch!.id);
      const answer = chatService.nodes().find((n) => n.role === 'assistant' && n.parentId === branch!.id);
      expect(answer?.content).toBe('Generated');
    });

    it('uses the model selected in the editor for the branch stream', async () => {
      const q1 = node({ id: 'q1', content: 'Original' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Alternative path');
      // The user switches the editor model before branching.
      component.branchModelId.set('beta/model');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      // The new sibling question AND its streamed answer use the selected
      // editor model — the change is no longer ignored.
      const branch = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Alternative path');
      expect(branch).not.toBeUndefined();
      expect(branch!.modelId).toBe('beta/model');
      expect(branch!.providerId).toBe('prov-1');
      const answer = chatService.nodes().find((n) => n.role === 'assistant' && n.parentId === branch!.id);
      expect(answer).toBeDefined();
      expect(answer!.modelId).toBe('beta/model');
      // The write model that streamed the answer is the selected one.
      const req = orch.completion.mock.calls[0][1] as { model?: { modelId?: string } };
      expect(req.model?.modelId).toBe('beta/model');
    });

    it('an IMAGE-ONLY branch fills the new assistant answer with the direction and attaches the image', async () => {
      const q1 = node({ id: 'q1', content: 'Original' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      (orch.completion as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,QQ==' }] }
      });
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Render the castle');

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      const branch = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Render the castle');
      expect(branch).not.toBeUndefined();
      // The assistant answer's VERSIONED node (editAssistant versions away the
      // placeholder): it carries the direction text AND the generated image.
      const answer = chatService
        .nodes()
        .filter((n) => n.role === 'assistant' && n.parentId === branch!.id)
        .find((n) => (n.attachments ?? []).length > 0)
        ?? chatService.nodes().find((n) => n.role === 'assistant' && n.parentId === branch!.id && n.isCurrent);
      expect(answer).toBeDefined();
      expect(answer!.content).toBe('Render the castle');
      expect((answer!.attachments ?? []).length).toBe(1);
      expect(answer!.attachments![0].name).toMatch(/^illustration-1\./);
    });

    it('closes the editor and clears the edit session after branching', async () => {
      const q1 = node({ id: 'q1', content: 'Original' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Alternative path');
      const session = TestBed.inject(NodeEditSession);
      expect(session.isDirty()).toBe(true);

      await component.saveAsBranchAndSend();
      fixture.detectChanges();

      // The draft was consumed — the editor closes and no stale session stays
      // behind, so a later edit does not start out dirty.
      expect(component.isEditing()).toBe(false);
      expect(session.editingNodeId()).toBeNull();
      expect(session.isDirty()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Insert
  // ------------------------------------------------------------------

  describe('insert', () => {
    it('inserts a new question above and hangs the old one under the new answer', async () => {
      const q1 = node({ id: 'q1', content: 'Earlier question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old answer',
      });

      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Inserted question');

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      const inserted = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Inserted question');
      expect(inserted).not.toBeUndefined();
      expect(inserted!.parentId).toBeNull();
      // the new assistant answer hangs under the inserted question (the
      // CURRENT answer — versioned, the placeholder is retired).
      const answer = chatService.getChildren(inserted!.id).find((n) => n.role === 'assistant')!;
      expect(answer).toBeDefined();
      // the old question now hangs under the new answer
      expect(chatService.nodes().find((n) => n.id === 'q1')?.parentId).toBe(answer.id);
    });

    it('does nothing when called on an assistant node', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      createFixture(a1);
      component.onDraftText('Should not insert');

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      expect(
        chatService.nodes().filter((n) => n.role === 'user' && n.content === 'Should not insert')
          .length,
      ).toBe(0);
    });

    it('uses the model selected in the editor for the inserted stream', async () => {
      const q1 = node({ id: 'q1', content: 'Earlier question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Inserted question');
      // The user switches the editor model before inserting.
      component.branchModelId.set('beta/model');

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      const inserted = chatService
        .nodes()
        .find((n) => n.role === 'user' && n.content === 'Inserted question');
      expect(inserted).not.toBeUndefined();
      expect(inserted!.modelId).toBe('beta/model');
      expect(inserted!.providerId).toBe('prov-1');
      const answer = chatService.getChildren(inserted!.id).find((n) => n.role === 'assistant')!;
      expect(answer).toBeDefined();
      expect(answer.modelId).toBe('beta/model');
      const req = orch.completion.mock.calls[0][1] as { model?: { modelId?: string } };
      expect(req.model?.modelId).toBe('beta/model');
    });

    it('closes the editor and clears the edit session after inserting', async () => {
      const q1 = node({ id: 'q1', content: 'Earlier question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old answer',
      });
      await openChat([q1, a1]);
      createFixture(q1);
      await startEditing(q1);
      component.onDraftText('Inserted question');
      const session = TestBed.inject(NodeEditSession);
      expect(session.isDirty()).toBe(true);

      await component.saveAsInsertAndSend();
      fixture.detectChanges();

      // Same as Branch: the edit session must not stay behind dirty.
      expect(component.isEditing()).toBe(false);
      expect(session.editingNodeId()).toBeNull();
      expect(session.isDirty()).toBe(false);
    });
  });

  describe('structure generation', () => {
    it('offers the heading button only on assistant nodes', () => {
      createFixture(node({ role: 'user', content: 'Question' }));
      expect(titleButton('Generate a chapter heading for this answer')).toBeNull();

      createFixture(node({ role: 'assistant', content: 'Answer' }));
      expect(titleButton('Generate a chapter heading for this answer')).not.toBeNull();
    });

    it('drives the structure-heading use case with the chapter model and activates the created node', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter text',
      });
      await openChat([q1, a1]);
      createFixture(a1);

      // The real flow (covered in flows.spec.ts) creates/patches the heading
      // node and returns its id — the component activates it.
      (runner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        text: { status: 'ok', value: 'Generated structure' },
        flow: { status: 'ok', value: { structureNodeId: 'h1', activateId: 'h1', empty: false } }
      });
      await component.generateHeading();

      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { modelId?: string; providerId?: string };
      };
      expect(build.usecase).toBe('structure-heading');
      expect(build.vars?.modelId).toBe('alpha/model');
      expect(build.vars?.providerId).toBe('prov-1');
      expect(emitted).toContain('h1');
    });

    it('passes only the current chapter node as the anchor', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Sole context',
      });
      const a2 = node({
        id: 'a2',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Other answer',
      });
      await openChat([q1, a1, a2]);
      createFixture(a1);

      (runner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        flow: { status: 'ok', value: { structureNodeId: 'h9', activateId: 'h9', empty: false } }
      });
      await component.generateHeading();

      const build = runner.run.mock.calls[0][0] as { node?: { id?: string } };
      expect(build.node?.id).toBe('a1');
    });

    it('does nothing when called on a non-assistant node', async () => {
      const q1 = node({ id: 'q1', content: 'Story context' });
      await openChat([q1]);
      createFixture(q1);

      await component.generateHeading();

      expect(runner.run).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Regenerate
  // ------------------------------------------------------------------

  describe('regenerate', () => {
    it('deletes the answer and its subtree, activates the parent, and re-streams', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
      });
      const d = node({ id: 'd', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, d]);
      confirmResolves(true);
      createFixture(a1);

      await component.regenerateAnswer();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeUndefined();
      expect(chatService.nodes().find((n) => n.id === 'd')).toBeUndefined();
      expect(emitted).toContain('q1');
      // A fresh answer was streamed under the question by the flow runner.
      const fresh = chatService.nodes().find((n) => n.role === 'assistant' && n.parentId === 'q1');
      expect(fresh).toBeDefined();
      expect(fresh!.content).toBe('Generated');
    });

    it('does nothing while already loading or generating', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
      });
      await openChat([q1, a1]);
      chatService.startGeneration('a1');
      createFixture(a1);

      await component.regenerateAnswer();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeDefined();
      chatService.stopGeneration();
    });

    it('an IMAGE-ONLY regenerate fills the fresh answer with the direction and attaches the image', async () => {
      const q1 = node({ id: 'q1', content: 'Render the castle' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old chapter',
        modelId: 'alpha/model',
      });
      const d = node({ id: 'd', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, d]);
      confirmResolves(true);
      (orch.completion as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,QQ==' }] }
      });
      createFixture(a1);

      await component.regenerateAnswer();
      fixture.detectChanges();

      const fresh = chatService
        .nodes()
        .filter((n) => n.role === 'assistant' && n.parentId === 'q1')
        .find((n) => (n.attachments ?? []).length > 0)
        ?? chatService.nodes().find((n) => n.role === 'assistant' && n.parentId === 'q1' && n.isCurrent);
      expect(fresh).toBeDefined();
      // The model returned ONLY an image → the fresh chapter carries the
      // direction text and the picture is attached below it.
      expect(fresh!.content).toBe('Render the castle');
      expect((fresh!.attachments ?? []).length).toBe(1);
      expect(fresh!.attachments![0].name).toMatch(/^illustration-1\./);
      expect(fresh!.attachments![0].dataUrl).toBe('data:image/png;base64,QQ==');
    });
  });

  // ------------------------------------------------------------------
  // Regenerate in place (rewrite this answer, keep following text)
  // ------------------------------------------------------------------

  describe('regenerateInPlace', () => {
    it('replaces only this answer and re-hangs the following text under the new one', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
      });
      const d1 = node({
        id: 'd1', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction',
      });
      const a2 = node({
        id: 'a2',
        chatId: 'chat-1',
        parentId: 'd1',
        role: 'assistant',
        content: 'Following text',
        modelId: 'alpha/model',
      });
      await openChat([q1, a1, d1, a2]);
      confirmResolves(true);
      createFixture(a1);

      await component.regenerateInPlace();
      fixture.detectChanges();

      // Only the regenerated answer is gone…
      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeUndefined();
      // …the following text survives intact.
      expect(chatService.nodes().find((n) => n.id === 'd1')).toBeDefined();
      expect(chatService.nodes().find((n) => n.id === 'a2')).toBeDefined();

      // A fresh answer hangs under the question and adopts the preserved subtree.
      const newAnswer = chatService.getChildren('q1').find((n) => n.role === 'assistant')!;
      expect(newAnswer).toBeDefined();
      expect(newAnswer.id).not.toBe('a1');
      expect(newAnswer.content).toBe('Generated');
      expect(chatService.getChildren(newAnswer.id).map((n) => n.id)).toContain('d1');
      expect(chatService.getActiveChild(newAnswer.id)?.id).toBe('d1');

      expect(emitted).toContain('q1');
    });

    it('with no following text it behaves like a plain regenerate', async () => {
      const older = new Date(Date.now() - 60_000).toISOString();
      const newer = new Date().toISOString();
      const q1 = node({ id: 'q1', content: 'Question', createdAt: older, updatedAt: older });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
        createdAt: older,
        updatedAt: older,
      });
      // A later sibling question under q1 so the active path ends on it, not
      // on a1 — otherwise selectChat auto-adds a draft question under a1.
      const q2 = node({
        id: 'q2',
        parentId: 'q1',
        content: 'Question 2',
        createdAt: newer,
        updatedAt: newer,
      });
      await openChat([q1, a1, q2]);
      createFixture(a1);

      await component.regenerateInPlace();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeUndefined();
      const newAnswer = chatService.getChildren('q1').find((n) => n.role === 'assistant')!;
      expect(newAnswer).toBeDefined();
      expect(newAnswer.id).not.toBe('a1');
      expect(newAnswer.content).toBe('Generated');
    });

    it('asks for confirmation when there is following text; aborting keeps the node', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Answer',
        modelId: 'alpha/model',
      });
      const d1 = node({
        id: 'd1', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction',
      });
      await openChat([q1, a1, d1]);
      confirmResolves(false);
      createFixture(a1);

      await component.regenerateInPlace();
      fixture.detectChanges();

      expect(chatService.nodes().find((n) => n.id === 'a1')).toBeDefined();
    });

    it('an IMAGE-ONLY rewrite preserves the OLD attachments and merges the NEW image', async () => {
      const q1 = node({ id: 'q1', content: 'Render the castle' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Old chapter',
        modelId: 'alpha/model',
        attachments: [{
          id: 'old-img', name: 'illustration-1.png', mimeType: 'image/png', size: 4,
          dataUrl: 'data:image/png;base64,OLDOLD'
        }]
      });
      const d1 = node({
        id: 'd1', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction',
      });
      const a2 = node({
        id: 'a2',
        chatId: 'chat-1',
        parentId: 'd1',
        role: 'assistant',
        content: 'Following text',
        modelId: 'alpha/model',
      });
      await openChat([q1, a1, d1, a2]);
      confirmResolves(true);
      (orch.completion as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,QQ==' }] }
      });
      createFixture(a1);

      await component.regenerateInPlace();
      fixture.detectChanges();

      const newAnswer = chatService.getChildren('q1').find((n) => n.role === 'assistant')!;
      expect(newAnswer).toBeDefined();
      expect(newAnswer.id).not.toBe('a1');
      // An image-only rewrite → the fresh answer repeats the direction, keeps
      // the OLD image AND adds the new one (renumbered after the old).
      expect(newAnswer.content).toBe('Render the castle');
      expect((newAnswer.attachments ?? []).length).toBe(2);
      expect(newAnswer.attachments![0].dataUrl).toBe('data:image/png;base64,OLDOLD');
      expect(newAnswer.attachments![0].name).toBe('illustration-1.png');
      expect(newAnswer.attachments![1].name).toBe('illustration-2.png');
      expect(newAnswer.attachments![1].dataUrl).toBe('data:image/png;base64,QQ==');
      expect(chatService.getChildren(newAnswer.id).map((n) => n.id)).toContain('d1');
    });
  });

  // ------------------------------------------------------------------
  // Attachments
  // ------------------------------------------------------------------

  describe('attachments', () => {
    it('renders read-only attachment chips with a file link', () => {
      const cn = node({
        content: 'With file',
        attachments: [attachment({ mimeType: 'text/plain' })],
      });
      createFixture(cn);
      expect(fixture.nativeElement.querySelector('.attachment-chips.read-only')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.file-link')).not.toBeNull();
    });

    it('renders an image thumbnail for image attachments', () => {
      const cn = node({
        content: 'With image',
        attachments: [
          attachment({
            id: 'img',
            name: 'pic.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA',
          }),
        ],
      });
      createFixture(cn);
      expect(fixture.nativeElement.querySelector('.thumb')).not.toBeNull();
    });

    it('opens the lightbox (not window.open) when an image is clicked', () => {
      const lightbox = TestBed.inject(LightboxService);
      lightbox.close();
      const a1 = attachment({
        id: 'img1',
        name: 'a.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
      });
      const a2 = attachment({
        id: 'img2',
        name: 'b.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,BBBB',
      });
      const cn = node({ content: 'x', attachments: [a1, a2] });
      createFixture(cn);

      const spy = vi.fn();
      (window as any).open = spy;
      component.openImage(a1.dataUrl);
      expect(spy).not.toHaveBeenCalled();
      expect(lightbox.current()).toEqual({ urls: [a1.dataUrl, a2.dataUrl], index: 0 });
    });

    it('adds attachments from the file input', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));

      const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
      const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await component.onEditorFilesSelected({ target: input } as any);
      fixture.detectChanges();

      expect(component.editAttachments().length).toBe(1);
      expect(component.editAttachments()[0].name).toBe('hello.txt');
      expect(
        fixture.nativeElement.querySelector('.attachment-chips.editable .chip'),
      ).not.toBeNull();
    });

    it('removes an attachment via the chip × button', async () => {
      const a = attachment();
      createFixture(node({ content: 'Hello', attachments: [a] }));
      await startEditing(node({ content: 'Hello', attachments: [a] }));

      component.removeEditAttachment(a.id);
      fixture.detectChanges();

      expect(component.editAttachments()).toEqual([]);
    });

    it('opens the file picker when the attach button is clicked', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
      input.click = vi.fn();
      const add = titleButton('Add attachment');
      expect(add).not.toBeNull();
      add!.click();
      expect(input.click).toHaveBeenCalled();
    });

    it('handles dropped files through onEditorDrop', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));

      const file = new File(['dropped'], 'drop.txt', { type: 'text/plain' });
      const dt = { files: [file] };
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: dt,
      } as unknown as DragEvent;
      await component.onEditorDrop(event);

      expect(component.editAttachments().length).toBe(1);
      expect(component.editAttachments()[0].name).toBe('drop.txt');
    });

    it('toggles the drag-over state for drag events', async () => {
      createFixture(node({ content: 'Hello' }));
      await startEditing(node({ content: 'Hello' }));
      const over = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as DragEvent;
      const leave = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as DragEvent;

      component.onEditorDragOver(over);
      expect(component.isEditorDragOver()).toBe(true);

      component.onEditorDragLeave(leave);
      expect(component.isEditorDragOver()).toBe(false);
    });

    it('classifies recorded prompt attachments (prompt-N.txt / refused-prompt-N.txt)', () => {
      const ok = attachment({
        id: 'ok',
        name: 'prompt-2.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A scene'),
      });
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA scene\n\nModel reply:\nNo',
        ),
      });
      const plain = attachment({ id: 'plain', name: 'notes.txt', mimeType: 'text/plain' });
      createFixture(node({ content: 'x', attachments: [ok, refused, plain] }));

      expect(component.isPromptAttachment(ok)).toBe(true);
      expect(component.isPromptAttachment(refused)).toBe(true);
      expect(component.isPromptAttachment(plain)).toBe(false);
      expect(component.isRefusedPromptAttachment(refused)).toBe(true);
      expect(component.isRefusedPromptAttachment(ok)).toBe(false);

      // promptAttachmentPrompt extracts only the prompt part of a refused record.
      expect(component.promptAttachmentPrompt(refused)).toBe('A scene');
    });

    it('shows the recorded prompt text inline instead of only a download link', () => {
      const ok = attachment({
        id: 'ok',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Medium shot: a lantern-lit bazaar at night.',
        ),
      });
      createFixture(node({ content: 'x', attachments: [ok] }));

      // Prompt attachments are NOT plain download links any more.
      expect(fixture.nativeElement.querySelector('.file-link')).toBeNull();
      expect(fixture.nativeElement.querySelector('.prompt-toggle')).not.toBeNull();

      // Collapsed by default — no inline text yet.
      expect(fixture.nativeElement.querySelector('.prompt-text')).toBeNull();

      component.togglePrompt(ok);
      fixture.detectChanges();
      const text = fixture.nativeElement.querySelector('.prompt-text')?.textContent ?? '';
      expect(text).toContain('lantern-lit bazaar');

      // Toggling again collapses.
      component.togglePrompt(ok);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.prompt-text')).toBeNull();
    });

    it('adapts a refused prompt and re-renders it in place', async () => {
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA dungeon scene\n\nModel reply:\nI cannot generate that image.',
        ),
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter',
        attachments: [refused],
      });
      await openChat([q1, a1]);

      runner.run.mockResolvedValueOnce({
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,QQ==' }] },
        storyboard: {
          status: 'ok',
          value: [{
            scene: 1,
            prompt: 'Illustrate this beat\n\nAssistant:\nA brighter dungeon scene, lit by torchlight',
            images: [{ url: 'data:image/png;base64,QQ==' }],
            refused: false,
            content: ''
          }]
        }
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(refused);
      fixture.detectChanges();

      // Editor opens pre-filled with the prompt portion only (no "Model reply").
      expect(component.editingPromptId()).toBe('ref');
      expect(component.promptEditDraft()).toBe('A dungeon scene');
      expect(fixture.nativeElement.querySelector('.prompt-editor')).not.toBeNull();

      // Re-render via the orchestration `image-generation` use case: single
      // picture, count 1, no planning — the adapted prompt IS the scene.
      component.promptEditDraft.set('A brighter dungeon scene, lit by torchlight');
      await component.rerenderPrompt(refused);
      fixture.detectChanges();

      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { promptText?: string; count?: number };
      };
      expect(build.usecase).toBe('image-generation');
      expect(build.vars?.count).toBe(1);
      expect(build.vars?.promptText).toContain('brighter dungeon scene, lit by torchlight');

      // editAssistant versions the chapter — read the current assistant child.
      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      // The refused record is replaced by an image + its prompt file.
      expect(chapter.attachments?.some(a => a.name === 'refused-prompt-1.txt')).toBe(false);
      expect(chapter.attachments?.some(a => a.name === 'illustration-1.png')).toBe(true);
      const promptFile = chapter.attachments!.find(a => a.name === 'prompt-1.txt');
      expect(promptFile).toBeTruthy();
      // The adapted prompt is what got recorded next to the new image.
      expect(decodeDataUrlToText(promptFile!.dataUrl!)).toContain('brighter dungeon scene');
      expect(emitted).toContain(chapter.id);
    });

    it('attaches re-rendered pictures when the service returns per-scene records (real shape)', async () => {
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-2.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA dungeon scene\n\nModel reply:\nNo',
        ),
      });
      // Chapter already has a successful scene 1 + the refused scene 2.
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter',
        attachments: [
          attachment({ id: 'img1', name: 'illustration-1.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }),
          attachment({ id: 'p1', name: 'prompt-1.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;charset=utf-8,scene-1' }),
          refused,
        ],
      });
      await openChat([q1, a1]);

      // Mirrors the orchestration `image-generation` slots shape (storyboard
      // populated).
      runner.run.mockResolvedValueOnce({
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,BBBB' }] },
        storyboard: {
          status: 'ok',
          value: [{
            scene: 1,
            prompt: 'adapted scene prompt',
            images: [{ url: 'data:image/png;base64,BBBB' }],
            refused: false
          }]
        }
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(refused);
      component.promptEditDraft.set('A brighter dungeon scene');
      await component.rerenderPrompt(refused);
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      const names = (chapter.attachments || []).map(a => a.name);
      // Keeps scene 1, replaces refused scene 2 with illustration-2 + prompt-2.
      expect(names.some(a => a === 'illustration-1.png')).toBe(true);
      expect(names.some(a => a === 'refused-prompt-2.txt')).toBe(false);
      expect(names.some(a => a === 'illustration-2.png')).toBe(true);
      expect(names.some(a => a === 'prompt-2.txt')).toBe(true);
    });

    it('alerts and saves an updated refused record when the re-render is refused again', async () => {
      const refused = attachment({
        id: 'ref',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA scene\n\nModel reply:\nNo',
        ),
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Chapter',
        attachments: [refused],
      });
      await openChat([q1, a1]);

      // Model refuses again: no images, refused scene with a reply.
      runner.run.mockResolvedValueOnce({
        images: { status: 'refused', value: null },
        storyboard: {
          status: 'ok',
          value: [{
            scene: 1,
            // In the real flow scene.prompt is the anchor, which embeds the
            // user's adapted draft text.
            prompt: 'Illustrate... chapter to illustrate:\nA softer scene',
            images: [],
            refused: true,
            content: 'I cannot help with that.'
          }]
        }
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(refused);
      component.promptEditDraft.set('A softer scene');
      await component.rerenderPrompt(refused);
      fixture.detectChanges();

      // No picture attached, but the refusal is surfaced — no silent success.
      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.some(a => a.name === 'illustration-1.png')).toBe(false);
      // The adapted prompt is preserved in the updated refused record.
      const kept = chapter.attachments!.find(a => a.name === 'refused-prompt-1.txt');
      expect(kept).toBeTruthy();
      expect(decodeDataUrlToText(kept!.dataUrl!)).toContain('A softer scene');
      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().some(t => t.kind === 'error' && t.text.includes('I cannot help with that.'))).toBe(true);
      // Editor resets after the attempt.
      expect(component.editingPromptId()).toBeNull();
      expect(component.expandedPromptId()).toBeNull();
    });

    it('adapts & re-renders a SUCCESSFUL prompt by replacing its paired illustration', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A castle scene'),
      });
      const img = attachment({
        id: 'img1',
        name: 'illustration-1.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,OLDDATA',
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter',
        attachments: [img, prompt],
      });
      await openChat([q1, a1]);

      runner.run.mockResolvedValueOnce({
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,NEWDATA' }] },
        storyboard: {
          status: 'ok',
          value: [{
            scene: 1,
            prompt: 'Illustrate this beat\n\nAssistant:\nA brighter castle at dusk',
            images: [{ url: 'data:image/png;base64,NEWDATA' }],
            refused: false,
            content: ''
          }]
        }
      });

      createFixture(a1, 'a1');
      component.startPromptEdit(prompt);
      component.promptEditDraft.set('A brighter castle at dusk');
      await component.rerenderPrompt(prompt);
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      // The OLD illustration is replaced, not duplicated.
      const images = (chapter.attachments || []).filter(a => a.name === 'illustration-1.png');
      expect(images).toHaveLength(1);
      expect(images[0].dataUrl).toBe('data:image/png;base64,NEWDATA');
      // The OLD prompt record is replaced with the adapted one.
      const prompts = (chapter.attachments || []).filter(a => a.name === 'prompt-1.txt');
      expect(prompts).toHaveLength(1);
      expect(decodeDataUrlToText(prompts[0].dataUrl!)).toContain('brighter castle at dusk');
    });

    it('deletes a prompt attachment after confirmation (image kept, editor closed)', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A castle scene'),
      });
      const img = attachment({
        id: 'img1',
        name: 'illustration-1.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,KEEPME',
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter',
        attachments: [img, prompt],
      });
      await openChat([q1, a1]);

      createFixture(a1, 'a1');
      component.startPromptEdit(prompt); // keep the editor open — it must close on delete
      confirmResolves(true);
      await component.deletePromptAttachment(prompt);
      fixture.detectChanges();

      expect(confirm.ask).toHaveBeenCalled();
      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.some(a => a.id === 'p1')).toBe(false);
      expect(chapter.attachments?.some(a => a.id === 'img1')).toBe(true);
      // Editor state reset.
      expect(component.editingPromptId()).toBeNull();
      expect(component.expandedPromptId()).toBeNull();
    });

    it('keeps the prompt record when deletion is cancelled', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'refused-prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(
          'Prompt used:\nA scene\n\nModel reply:\nNo',
        ),
      });
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter',
        attachments: [prompt],
      });
      await openChat([q1, a1]);

      createFixture(a1, 'a1');
      confirmResolves(false);
      await component.deletePromptAttachment(prompt);
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1')
        .find(c => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.some(a => a.id === 'p1')).toBe(true);
    });

    it('pre-fills the editor from a SUCCESSFUL prompt for adapt & re-render', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-2.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A lantern-lit bazaar at night.'),
      });
      createFixture(node({ role: 'assistant', content: 'Chapter', attachments: [prompt] }));

      component.startPromptEdit(prompt);
      expect(component.editingPromptId()).toBe('p1');
      expect(component.promptEditDraft()).toBe('A lantern-lit bazaar at night.');
    });

    it('renders adapt & re-render AND delete for a non-refused prompt in the box', async () => {
      const prompt = attachment({
        id: 'p1',
        name: 'prompt-1.txt',
        mimeType: 'text/plain',
        dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('A castle scene'),
      });
      createFixture(node({ role: 'assistant', content: 'Chapter', attachments: [prompt] }));
      component.togglePrompt(prompt);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Adapt prompt & re-render');
      expect(text).toContain('Delete prompt');
    });

    // Attachment multi-selection + copy / cut / paste
    // ------------------------------------------------------------------

    /** The CURRENT (isCurrent) assistant chapter whose content includes `text`. */
    function currentChapter(text: string): ChatNode {
      const found = chatService
        .getChildren('q1')
        .filter(c => c.role === 'assistant' && c.isCurrent)
        .find(c => (c.content ?? '').includes(text));
      expect(found).toBeDefined();
      return found!;
    }

    function img(id: string, name = 'pic.png'): ReturnType<typeof attachment> {
      return attachment({
        id,
        name,
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${id.toUpperCase().repeat(4)}`,
      });
    }

    it('toggles multi-selection on chip click and marks the chip', () => {
      const a1 = img('img1');
      const a2 = img('img2');
      createFixture(node({ content: 'x', attachments: [a1, a2] }));

      const chips = fixture.nativeElement.querySelectorAll(
        '.attachment-chips.read-only .chip',
      );
      expect(chips.length).toBe(2);

      (chips[0] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();

      expect(component.isAttachmentSelected('img1')).toBe(true);
      expect(component.isAttachmentSelected('img2')).toBe(false);
      expect((chips[0] as HTMLElement).classList.contains('selected')).toBe(true);
      expect((chips[1] as HTMLElement).classList.contains('selected')).toBe(false);
      expect(component.selectedCount()).toBe(1);

      // Clicking again deselects.
      component.toggleAttachmentSelection(a1);
      expect(component.isAttachmentSelected('img1')).toBe(false);
    });

    it('Ctrl+click on an image thumb selects instead of opening the lightbox', () => {
      const a1 = img('img1');
      const lightbox = TestBed.inject(LightboxService);
      const openSpy = vi.spyOn(lightbox, 'open').mockImplementation(() => {});
      createFixture(node({ content: 'x', attachments: [a1] }));

      const thumb = fixture.nativeElement.querySelector('.thumb') as HTMLElement;
      const ev = new MouseEvent('click', { bubbles: true, ctrlKey: true });
      thumb.dispatchEvent(ev);
      fixture.detectChanges();

      expect(component.isAttachmentSelected('img1')).toBe(true);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('copies selected attachments and pastes a CLONE into another node', async () => {
      const a1 = img('img1');
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const n1 = node({
        id: 'n1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Chapter one', attachments: [a1],
      });
      const n2 = node({
        id: 'n2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter two',
      });
      await openChat([q1, n1, n2]);

      createFixture(n1, 'n1');
      component.toggleAttachmentSelection(a1);
      component.copySelectedAttachments();
      expect(component.attachmentClipboard.hasContent()).toBe(true);
      expect(component.attachmentClipboard.action()).toBe('copy');

      createFixture(n2, 'n2');
      await component.pasteAttachments();
      fixture.detectChanges();

      // The source keeps its attachment, the target gets a clone with a NEW id.
      const n1Cur = currentChapter('Chapter one');
      expect(n1Cur.attachments?.some(a => a.id === 'img1')).toBe(true);
      const n2Cur = currentChapter('Chapter two');
      expect(n2Cur.attachments?.length).toBe(1);
      expect(n2Cur.attachments![0].id).not.toBe('img1');
      expect(n2Cur.attachments![0].dataUrl).toBe(a1.dataUrl);
      expect(component.attachmentClipboard.hasContent()).toBe(false);
    });

    it('cut stages WITHOUT removing, and paste MOVES the attachments', async () => {
      const a1 = img('img1');
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const n1 = node({
        id: 'n1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Chapter one', attachments: [a1],
      });
      const n2 = node({
        id: 'n2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter two',
      });
      await openChat([q1, n1, n2]);

      createFixture(n1, 'n1');
      component.toggleAttachmentSelection(a1);
      component.cutSelectedAttachments();
      expect(component.attachmentClipboard.action()).toBe('cut');
      // Cut is only real when pasted: the source still has the attachment.
      expect(currentChapter('Chapter one').attachments?.some(a => a.id === 'img1')).toBe(true);
      expect(component.isAttachmentCut(a1)).toBe(true);

      createFixture(n2, 'n2');
      await component.pasteAttachments();
      fixture.detectChanges();

      // Moved: the source lost it (new version), the target gained it (same id).
      expect(currentChapter('Chapter one').attachments?.some(a => a.id === 'img1')).toBe(false);
      expect(currentChapter('Chapter two').attachments?.some(a => a.id === 'img1')).toBe(true);
      expect(component.attachmentClipboard.hasContent()).toBe(false);
    });

    it('cutting then cancelling keeps the attachments untouched', async () => {
      const a1 = img('img1');
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const n1 = node({
        id: 'n1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Chapter', attachments: [a1],
      });
      await openChat([q1, n1]);

      createFixture(n1, 'n1');
      component.toggleAttachmentSelection(a1);
      component.cutSelectedAttachments();
      component.cancelAttachmentClipboard();

      expect(component.attachmentClipboard.hasContent()).toBe(false);
      expect(currentChapter('Chapter').attachments?.some(a => a.id === 'img1')).toBe(true);
      // No version was created by the cut itself.
      expect(
        chatService.getChildren('q1').filter(c => c.role === 'assistant' && c.isCurrent).length,
      ).toBe(1);
    });

    it('pasting a cut back into the SAME node is a no-op but clears the staging', async () => {
      const a1 = img('img1');
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const n1 = node({
        id: 'n1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Chapter', attachments: [a1],
      });
      await openChat([q1, n1]);

      createFixture(n1, 'n1');
      component.toggleAttachmentSelection(a1);
      component.cutSelectedAttachments();
      await component.pasteAttachments();
      fixture.detectChanges();

      expect(component.attachmentClipboard.hasContent()).toBe(false);
      expect(currentChapter('Chapter').attachments?.some(a => a.id === 'img1')).toBe(true);
      // Still exactly one current chapter — no extra version was created.
      expect(
        chatService.getChildren('q1').filter(c => c.role === 'assistant' && c.isCurrent).length,
      ).toBe(1);
    });

    it('deletes the selected attachments from a read-only node after confirmation', async () => {
      const a1 = img('img1');
      const a2 = img('img2', 'other.png');
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const n1 = node({
        id: 'n1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Chapter', attachments: [a1, a2],
      });
      await openChat([q1, n1]);

      createFixture(n1, 'n1');
      component.toggleAttachmentSelection(a1);
      component.toggleAttachmentSelection(a2);
      confirmResolves(true);
      await component.deleteSelectedAttachments();
      fixture.detectChanges();

      expect(confirm.ask).toHaveBeenCalled();
      const nCur = currentChapter('Chapter');
      expect(nCur.attachments ?? []).toHaveLength(0);
      expect(component.selectedCount()).toBe(0);
    });

    it('keeps the attachments when deletion is cancelled', async () => {
      const a1 = img('img1');
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const n1 = node({
        id: 'n1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Chapter', attachments: [a1],
      });
      await openChat([q1, n1]);

      createFixture(n1, 'n1');
      component.toggleAttachmentSelection(a1);
      confirmResolves(false);
      await component.deleteSelectedAttachments();
      fixture.detectChanges();

      expect(currentChapter('Chapter').attachments?.some(a => a.id === 'img1')).toBe(true);
    });

    it('deletes the selected attachments from the unsaved DRAFT while editing', async () => {
      const a1 = img('img1');
      const a2 = img('img2', 'other.png');
      createFixture(node({ content: 'Hello', attachments: [a1, a2] }));
      await startEditing(node({ content: 'Hello', attachments: [a1, a2] }));

      const confirmSpy = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
      component.toggleAttachmentSelection(a1);
      await component.deleteSelectedAttachments();
      fixture.detectChanges();

      expect(component.editAttachments().map(a => a.id)).toEqual(['img2']);
      expect(component.selectedCount()).toBe(0);
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('paste while editing appends to the draft (copy)', async () => {
      const a1 = img('img1');
      const q1 = node({ id: 'q1', chatId: 'chat-1', role: 'user', content: 'Dir' });
      const n1 = node({
        id: 'n1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Chapter', attachments: [a1],
      });
      await openChat([q1, n1]);
      createFixture(n1, 'n1');
      component.toggleAttachmentSelection(a1);
      component.copySelectedAttachments();

      // Reuse the SAME component but flip it into edit mode.
      await startEditing();
      fixture.detectChanges();
      await component.pasteAttachments();
      fixture.detectChanges();

      expect(component.editAttachments().length).toBe(2);
      expect(component.attachmentClipboard.hasContent()).toBe(false);
      // The persisted source still has the original attachment.
      expect(currentChapter('Chapter').attachments?.some(a => a.id === 'img1')).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Illustrate — text → picture generation
  // ------------------------------------------------------------------

  describe('illustrate', () => {
    it('is only enabled on assistant nodes with content', () => {
      const dir = node({ id: 'q1', content: 'Night train, Mara at the window.' });
      createFixture(dir);
      // Directions no longer offer illustration.
      expect(component.canIllustrate()).toBe(false);

      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'The letter…',
      });
      createFixture(a1);
      expect(component.canIllustrate()).toBe(true);

      const empty = node({ id: 'a2', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: '   ' });
      createFixture(empty);
      expect(component.canIllustrate()).toBe(false);
    });

    it('generates a picture for the current chapter and attaches it', async () => {
      const q1 = node({ id: 'q1', content: 'Night train, Mara at the window.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Mara folds the letter and watches the conductor pass.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // Routes through the orchestration `render-node` use case (count 1,
      // current-text only). The fixture presses the button on the DIRECTION
      // node, but the beat to depict is the ASSISTANT chapter that follows the
      // direction — its content is the scene override, not the direction text.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { content?: string; count?: number; modelId?: string };
      };
      expect(build.usecase).toBe('render-node');
      expect(build.vars?.content).toBe('Mara folds the letter and watches the conductor pass.');
      expect(build.vars?.modelId).toBe('alpha/model');

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(2);
      expect(chapter.attachments![0].name).toBe('illustration-1.png');
      expect(chapter.attachments![0].mimeType).toBe('image/png');
      // Companion text attachment with the exact prompt used.
      expect(chapter.attachments![1].name).toBe('prompt-1.txt');
      expect(chapter.attachments![1].mimeType).toBe('text/plain');
      expect(decodeDataUrlToText(chapter.attachments![1].dataUrl)).toContain(
        'Mara folds the letter and watches the conductor pass.',
      );
      expect(emitted).toContain(chapter.id);
    });

    it('attaches the picture to the chapter itself when invoked on a chapter', async () => {
      const q1 = node({ id: 'q1', content: 'A prov night-train that never quite arrives.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'The carriage sways; weak tea on the fold-out table.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      createFixture(a1);
      await component.illustrate();
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(2);
      expect(chapter.attachments![0].dataUrl).toContain('data:image/png');
      expect(chapter.attachments![1].name).toBe('prompt-1.txt');
      expect(decodeDataUrlToText(chapter.attachments![1].dataUrl)).toContain(
        'The carriage sways; weak tea on the fold-out table.',
      );
    });

    it('propagates pure picture mode into generateImage (forces planning)', async () => {
      const q1 = node({ id: 'q1', content: 'A mild direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // The user enabled the "pure picture mode" check button in the dialog.
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: true,
        historyMode: 'single',
        planDescriptions: false,
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // Pure picture mode + count 1 → planned-enblock: the image model may
      // only ever see the derived descriptions, so the planning pass runs even
      // for a single picture (purePictures flag carried into the vars).
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { purePictures?: boolean; content?: string };
      };
      expect(build.vars?.purePictures).toBe(true);
      expect(build.usecase).toBe('planned-enblock');
    });

    it('seeds the illustrate dialog with the default rendering model', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      expect(illustrateDialog.open).toHaveBeenCalledWith({
        modelId: 'alpha/model',
        providerId: 'prov-1'
      });
    });

    it('uses the image model selected in the dialog instead of the default', async () => {
      // Enable a second, image-capable model to pick from.
      api.models.push(makeModel({
        id: 'm-img',
        displayName: 'Image Cap',
        modelId: 'beta/image',
        providerId: 'prov-1',
        architecture: { input_modalities: ['text'], output_modalities: ['image'] }
      }));
      await settings.loadAll();

      const q1 = node({ id: 'q1', content: 'A lighthouse at dusk.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'The beam swings.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // The user picks a different image model in the dialog.
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: false,
        modelId: 'beta/image',
        providerId: 'prov-1',
        historyMode: 'single',
        planDescriptions: true
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // The dialog-selected model is forwarded into the orchestration vars so
      // the runner resolves THAT image model, not the default task model.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { modelId?: string; providerId?: string; content?: string };
      };
      expect(build.vars?.modelId).toBe('beta/image');
      expect(build.vars?.providerId).toBe('prov-1');
    });

    it('forwards the full-chat historyMode as the render-full use case for a single picture', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // User chose "Full chat up to this point" in the dialog.
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: false,
        modelId: '',
        providerId: '',
        historyMode: 'full'
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // historyMode 'full' + count 1 → render-full (current node + full chat).
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as { usecase?: string };
      expect(build.usecase).toBe('render-full');
    });

    it('forwards a window historyMode as the render-window use case with the chosen node count', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // User chose "Last beats up to this point" (6 beats) in the dialog.
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: false,
        modelId: '',
        providerId: '',
        historyMode: 'window',
        historyNodes: 6
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // historyMode 'window' + count 1 → render-window (current node + window).
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { historyNodes?: number };
      };
      expect(build.usecase).toBe('render-window');
      expect(build.vars?.historyNodes).toBe(6);
    });

    it('forwards the STORYBOARD window width for a storyboard use case', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // Storyboard (count 4) with the window mode: the storyboard-specific
      // width (10) wins over the single-picture width (6).
      illustrateDialog.open.mockResolvedValue({
        count: 4,
        style: '',
        storyboardPrompt: '',
        purePictures: false,
        modelId: '',
        providerId: '',
        historyMode: 'window',
        historyNodes: 6,
        storyboardHistoryNodes: 10
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { historyNodes?: number };
      };
      expect(build.usecase).toBe('planned-scenes'); // storyboard use case
      expect(build.vars?.historyNodes).toBe(10);
    });

    it('does not use render-full for a storyboard even when full chat was chosen', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // historyMode 'full' is meaningless for a storyboard (count=3).
      illustrateDialog.open.mockResolvedValue({
        count: 3,
        style: '',
        storyboardPrompt: '',
        purePictures: false,
        modelId: '',
        providerId: '',
        historyMode: 'full'
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // count > 1 → storyboard (planned-scenes), never render-full.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as { usecase?: string };
      expect(build.usecase).toBe('planned-scenes');
    });

    it('a single assistant chapter renders via render-node (no planning pass)', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      createFixture(a1);
      await component.illustrate();
      fixture.detectChanges();

      // Single picture, current-text only → render-node.
      const build = runner.run.mock.calls[0][0] as { usecase?: string };
      expect(build.usecase).toBe('render-node');
    });

    it('disables planning for a single assistant chapter; current-text stays single-message', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      // The user unchecks "Plan picture descriptions first" but leaves the
      // context radio on "Current text only".
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: false,
        modelId: '',
        providerId: '',
        historyMode: 'single',
        planDescriptions: false
      });

      createFixture(a1);
      await component.illustrate();
      fixture.detectChanges();

      // Single picture + current-text only (planning checkbox off) →
      // render-node: no storyboard, no planning.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { planDescriptions?: boolean; content?: string };
      };
      expect(build.usecase).toBe('render-node');
      expect(build.vars?.content).toContain('A chapter.');
    });

    it('with full-chat selected the render-full use case is used', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // Planning off + "Full chat up to this point" on an assistant chapter.
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: false,
        modelId: '',
        providerId: '',
        historyMode: 'full',
        planDescriptions: false
      });

      createFixture(a1);
      await component.illustrate();
      fixture.detectChanges();

      // Planning off + full-chat selected on a single picture → render-full.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as { usecase?: string; vars?: { content?: string } };
      expect(build.usecase).toBe('render-full');
      expect(build.vars?.content).toContain('A chapter.');
    });

    it('keeps planning on in pure picture mode even when the checkbox was off', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // Pure mode with a stale/ignored planDescriptions: false.
      illustrateDialog.open.mockResolvedValue({
        count: 1,
        style: '',
        storyboardPrompt: '',
        purePictures: true,
        modelId: '',
        providerId: '',
        historyMode: 'single',
        planDescriptions: false
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // Pure mode + count 1 → planned-enblock (the planning pass derives the
      // descriptions — raw prose never reaches the image model), with
      // purePictures carried through.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: { purePictures?: boolean; content?: string };
      };
      expect(build.vars?.purePictures).toBe(true);
      expect(build.usecase).toBe('planned-enblock');
    });

    it('shows an alert and does not call the LLM when no image model is enabled', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);
      createFixture(q1, 'a1');

      await component.illustrate();
      fixture.detectChanges();

      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().some(t => t.kind === 'error')).toBe(true);
    });

    it('requests the dialog storyboard count + style + rules and attaches every image', async () => {
      const q1 = node({ id: 'q1', content: 'A bustling bazaar at night.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Lanterns sway; a stall-keeper counts coins.',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue({
        count: 3,
        style: 'comic style',
        storyboardPrompt: 'no explicit images, hide behind bystanders',
        purePictures: false,
        historyMode: 'single',
        planDescriptions: true
      });

      const imgs = [0, 1, 2].map((i) => ({ url: `data:image/png;base64,AAAA${i}` }));

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // count 3 → planned-scenes; the dialog options ride in the vars.
      expect(runner.run).toHaveBeenCalledTimes(1);
      const build = runner.run.mock.calls[0][0] as {
        usecase?: string;
        vars?: {
          count?: number;
          style?: string;
          storyboardPrompt?: string;
          content?: string;
          modelId?: string;
        };
      };
      expect(build.usecase).toBe('planned-scenes');
      expect(build.vars?.count).toBe(3);
      expect(build.vars?.style).toBe('comic style');
      expect(build.vars?.storyboardPrompt).toContain('no explicit images');

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      // Mock returns 3 scenes with 1 image each → 3 illustrations + 3 prompts.
      expect(chapter.attachments?.length).toBe(6);
      expect(chapter.attachments![0].name).toBe('illustration-1.png');
      expect(chapter.attachments![4].name).toBe('illustration-3.png');
      expect(chapter.attachments![5].name).toBe('prompt-3.txt');
      expect(component.imageProgress()).toBeNull();
    });

    it('routes a storyboard to planned-scenes (planner selection is orchestration-internal)', async () => {
      // Three distinct models: the assistant node writes with gamma, the
      // configured image-interpret task points at beta, image-create at alpha.
      api.models.push(makeModel({ id: 'm-3', modelId: 'gamma/model' }));
      await settings.loadAll();

      const q1 = node({ id: 'q1', content: 'A castle by the sea.' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: 'Waves batter the old keep.',
        modelId: 'gamma/model',
      });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      generation.update('image-interpret', { providerId: 'prov-1', modelId: 'beta/model' });
      illustrateDialog.open.mockResolvedValue({
        count: 3, style: '', storyboardPrompt: '', purePictures: false,
        historyMode: 'single', planDescriptions: true
      });

      createFixture(a1);
      await component.illustrate();
      fixture.detectChanges();

      // count 3 → planned-scenes (the planner text-model selection lives in
      // the orchestration layer — covered by flows.spec).
      const build = runner.run.mock.calls[0][0] as { usecase?: string };
      expect(build.usecase).toBe('planned-scenes');
    });

    it('stores an exact prompt file per scene when the runner returns scene records', async () => {
      const q1 = node({ id: 'q1', content: 'Two beats.' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter.' });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue({
        count: 2,
        style: 'ink',
        storyboardPrompt: 'keep it clean',
        purePictures: false,
        historyMode: 'single',
        planDescriptions: true
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      // The pressed node is the DIRECTION (q1), but the beat depicted is the
      // ASSISTANT chapter after it (a1) — so the prompt files carry the
      // chapter content, not the direction text.
      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(4);
      expect(chapter.attachments![0].name).toBe('illustration-1.png');
      expect(chapter.attachments![1].name).toBe('prompt-1.txt');
      expect(decodeDataUrlToText(chapter.attachments![1].dataUrl)).toContain('Chapter.');
      expect(chapter.attachments![1].dataUrl ? decodeDataUrlToText(chapter.attachments![1].dataUrl) : '').not.toContain('Two beats.');
      expect(chapter.attachments![2].name).toBe('illustration-2.png');
      expect(chapter.attachments![3].name).toBe('prompt-2.txt');
    });

    it('preserves the prompt of refused images as a refused-prompt attachment', async () => {
      const q1 = node({ id: 'q1', content: 'A refused attempt.' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter.' });
      await openChat([q1, a1]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      // The orchestration runner returns a REFUSED storyboard scene.
      runner.run.mockResolvedValueOnce({
        storyboard: {
          status: 'ok',
          value: [{ scene: 1, prompt: 'sensitive scene', images: [], content: "I can't draw that.", refused: true }]
        }
      });

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(1);
      expect(chapter.attachments![0].name).toBe('refused-prompt-1.txt');
      const text = decodeDataUrlToText(chapter.attachments![0].dataUrl) ?? '';
      expect(text).toContain('sensitive scene');
      expect(text).toContain("I can't draw that.");
      // The user is still informed nothing was generated — with the model's
      // own refusal reply (UX playbook §8), not a generic failure.
      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().some(t => t.kind === 'error' && t.text.includes("I can't draw that."))).toBe(true);
    });

    it('attaches each storyboard picture as soon as it is ready (progressive onImages) and replaces interim with the final plan', async () => {
      const q1 = node({ id: 'q1', content: 'A bazaar.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);
      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue({
        count: 2, style: '', storyboardPrompt: '', purePictures: false,
        historyMode: 'single', planDescriptions: true
      });

      // The storyboard use case is still RUNNING while it reports the first
      // scene — gate its resolution so we can observe the in-flight state.
      const flush = () => new Promise<void>((res) => setTimeout(res, 0));
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      let capturedOnImages: ((scenes: unknown[]) => void) | null = null;
      runner.run.mockImplementationOnce(async (
        _build: unknown,
        opts?: { onImages?: (scenes: unknown[]) => void },
      ) => {
        capturedOnImages = opts?.onImages ?? null;
        await gate;
        return {
          storyboard: {
            status: 'ok',
            value: [
              { scene: 1, prompt: 'scene one', images: [{ url: 'data:image/png;base64,S1' }], refused: false },
              { scene: 2, prompt: 'scene two', images: [{ url: 'data:image/png;base64,S2' }], refused: false },
            ],
          },
        };
      });

      createFixture(q1, 'a1');
      const running = component.illustrate();
      await flush();

      // While the use case runs the app advertises the Stop button, and the
      // runner has received the progressive onImages callback.
      expect(capturedOnImages).not.toBeNull();
      expect(chatService.isIllustrating()).toBe(true);

      // First per-scene fallback completes → the chapter gains picture 1 NOW,
      // before the use case is finished.
      capturedOnImages!([
        { scene: 1, prompt: 'scene one', images: [{ url: 'data:image/png;base64,S1' }], refused: false },
      ]);
      await flush();
      await flush();
      const mid = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(mid.attachments?.length).toBe(2);
      expect(mid.attachments![0].name).toBe('illustration-1.png');
      expect(mid.attachments![1].name).toBe('prompt-1.txt');
      expect(decodeDataUrlToText(mid.attachments![1].dataUrl)).toContain('scene one');

      // Now the use case finishes and the FINAL plan replaces the interim
      // attachments exactly once — no duplicates, no leftover scene-1 only.
      release();
      await running;
      await flush();
      expect(chatService.isIllustrating()).toBe(false);
      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length).toBe(4);
      const names = (chapter.attachments ?? []).map((a) => a.name);
      expect(names.filter((n) => n.startsWith('illustration-')).sort()).toEqual([
        'illustration-1.png',
        'illustration-2.png',
      ]);
      expect(names.filter((n) => n.startsWith('prompt-')).sort()).toEqual([
        'prompt-1.txt',
        'prompt-2.txt',
      ]);
    });

    it('marks isIllustrating while a storyboard runs and Stop ends the use case without attaching anything', async () => {
      const q1 = node({ id: 'q1', content: 'A bazaar.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);
      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue({
        count: 2, style: '', storyboardPrompt: '', purePictures: false,
        historyMode: 'single', planDescriptions: true
      });

      const flush = () => new Promise<void>((res) => setTimeout(res, 0));
      let capturedSignal: AbortSignal | null = null;
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      runner.run.mockImplementationOnce(async (_build: unknown, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal ?? null;
        await gate;
        return {
          storyboard: {
            status: 'ok',
            value: [{ scene: 1, prompt: 'scene one', images: [], refused: true }],
          },
        };
      });

      createFixture(q1, 'a1');
      // Toasts accumulate across tests in this file; clear them so only THIS
      // run's notifications are counted by the assertions below.
      toast.clear();
      const running = component.illustrate();
      await flush();

      // The Stop state is advertised while the storyboard runs, and the
      // abort signal reached the orchestration runner.
      expect(chatService.isIllustrating()).toBe(true);
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);

      // Press Stop → the whole illustrate use case aborts.
      chatService.stopGeneration();
      expect(capturedSignal!.aborted).toBe(true);

      // The (already aborted) use case resolves — nothing is attached, no
      // error/refusal alert is surfaced, and the Stop state clears.
      release();
      await running;
      await flush();
      expect(chatService.isIllustrating()).toBe(false);
      const chapter = chatService.getChildren('q1').find((c) => c.role === 'assistant' && c.isCurrent)!;
      expect(chapter.attachments?.length ?? 0).toBe(0);
      expect(window.alert).not.toHaveBeenCalled();
      expect(toast.toasts().length).toBe(0);
    });

    it('does nothing when the dialog is cancelled', async () => {
      const q1 = node({ id: 'q1', content: 'A direction.' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'A chapter.',
      });
      await openChat([q1, a1]);
      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });
      illustrateDialog.open.mockResolvedValue(null);

      createFixture(q1, 'a1');
      await component.illustrate();
      fixture.detectChanges();

      expect(component.isLoading()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Preview toggle
  // ------------------------------------------------------------------

  describe('editor preview', () => {
    it('toggles the preview panel and rerenders the markdown', async () => {
      createFixture(node({ content: '# Heading' }));
      await startEditing(node({ content: '# Heading' }));

      const previewBtn = findButton('Show Preview');
      expect(previewBtn).not.toBeNull();
      previewBtn!.click();
      fixture.detectChanges();

      expect(component.showPreview()).toBe(true);
      expect(fixture.nativeElement.querySelector('.editor-preview')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.editor-preview')).not.toBeNull();

      const hideBtn = findButton('Hide Preview');
      expect(hideBtn).not.toBeNull();
    });

    it('renders the markdown preview via MarkdownService', async () => {
      createFixture(node({ content: '**bold**' }));
      await startEditing(node({ content: '**bold**' }));
      component.showPreview.set(true);
      fixture.detectChanges();

      const preview = fixture.nativeElement.querySelector('.editor-preview') as HTMLElement;
      expect(preview.textContent).toContain('bold');
    });
  });

  // ------------------------------------------------------------------
  // Stop generation
  // ------------------------------------------------------------------

  describe('stop generation', () => {
    it('shows a stop button while generating and stops the generation on click', () => {
      chatService.startGeneration('n1');
      createFixture(node({ id: 'n1', content: 'Hello' }));

      const stop = titleButton('Stop generation');
      expect(stop).not.toBeNull();
      stop!.click();
      expect(chatService.generatingNodeId()).toBeNull();
    });

    it('shows a "Finish & stop" button that keeps the current stream alive', () => {
      chatService.startGeneration('n1');
      createFixture(node({ id: 'n1', content: 'Hello' }));

      const soft = titleButton(
        'Finish the current answer, keep what was generated so far, and stop any following generation'
      );
      expect(soft).not.toBeNull();
      expect(soft!.disabled).toBe(false);
      soft!.click();
      fixture.detectChanges();

      // The graceful stop is requested, but the in-flight stream is NOT
      // aborted — its (still being created) results are preserved.
      expect(chatService.gracefulStop()).toBe(true);
      expect(chatService.generatingNodeId()).toBe('n1');
      expect(chatService.isOperationCancelled()).toBe(false);
      expect(chatService.shouldStopAfterCurrentStep()).toBe(true);

      // Clear feedback that the press took effect: the button is disabled
      // and now reports "Finishing…" (and carries the .stopping class).
      expect(soft!.disabled).toBe(true);
      expect(soft!.textContent).toContain('Finishing…');
      expect(soft!.classList.contains('stopping')).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Misc helpers
  // ------------------------------------------------------------------

  describe('helper API', () => {
    it('isLeafNode / isQuestion / hasSiblings reflect the tree', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1',
        chatId: 'chat-1',
        parentId: 'q1',
        role: 'assistant',
        content: '',
      });
      await openChat([q1, a1]);
      createFixture(a1);

      expect(component.isQuestion()).toBe(false);
      expect(component.isLeafNode()).toBe(true);
      expect(component.hasSiblings).toBe(false);
    });

    it('resolves a preferred model from the enabled models', () => {
      createFixture(node({ content: 'Hi', role: 'user' }));
      expect(component.resolvePreferredModelId(node({ content: 'Hi' }))).toBe('alpha/model');
    });

    it('renderedHtml follows the node content', () => {
      createFixture(node({ content: '**Bold**' }));
      expect(component.renderedHtml()).toContain('Bold');
    });
  });

  // ------------------------------------------------------------------
  // Prepend (director) feature
  // ------------------------------------------------------------------

  describe('prepend (director) feature', () => {
    it('opens the director dialog, calls the LLM, and inserts the two nodes before the current direction', async () => {
      const q1 = node({ id: 'q1', content: 'Root direction' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, q3]);
      createFixture(q3);

      prependConfirm('Custom director: these events are retold from outside the named characters.');
      await component.openPrependDialog();
      fixture.detectChanges();

      // The flow runner streamed through the orchestrator (mock): ONE call.
      expect(orch.completion).toHaveBeenCalled();
      const req = orch.completion.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };
      const askMessages = req.messages;
      // Prior context is unchanged (interleaved, like a normal send).
      expect(askMessages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(String(askMessages[0].content)).toBe('Root direction');
      expect(String(askMessages[1].content)).toBe('Chapter one.');
      // The LAST message is the prompt (director instruction). q3 is a leaf so
      // there is no following assistant content.
      const prompt = String(askMessages[askMessages.length - 1].content);
      expect(prompt).toContain('Custom director: these events are retold');

      // Two new nodes were created: a USER director (the prompt) + an
      // assistant result, both BEFORE the current direction node.
      const nodes = chatService.nodes();
      const director = nodes.find(n => n.role === 'user' && n.content === 'Custom director: these events are retold from outside the named characters.');
      const resultNode = chatService.getChildren(director!.id).find(n => n.role === 'assistant');
      expect(director).toBeDefined();
      expect(resultNode).toBeDefined();
      // Chain: a1 → director(user) → result(assistant) → q3 (both before the current direction).
      expect(director!.parentId).toBe('a1');
      expect(resultNode!.parentId).toBe(director!.id);
      expect(chatService.nodes().find(n => n.id === 'q3')?.parentId).toBe(resultNode!.id);
      // The current direction was adopted under the streamed result.

      // Persisted + active for the current node.
      expect(component.prependEnabled()).toBe(true);
      expect(JSON.parse(localStorage.getItem('chat.prependByNodeId')!)).toEqual({
        q3: 'Custom director: these events are retold from outside the named characters.'
      });
    });

    it('appends the assistant node content FOLLOWING the current node at the end of the prompt', async () => {
      // Upstream: q1 → a1(Chapter one.). Current direction: q2. Downstream
      // following chapters: a2 (Chapter two.), a3 (Chapter three.).
      const q1 = node({ id: 'q1', content: 'Root direction' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q2 = node({ id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction two' });
      const a2 = node({ id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant', content: 'Chapter two.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a2', role: 'user', content: 'Direction three' });
      const a3 = node({ id: 'a3', chatId: 'chat-1', parentId: 'q3', role: 'assistant', content: 'Chapter three.' });
      const q4 = node({ id: 'q4', chatId: 'chat-1', parentId: 'a3', role: 'user', content: '' });
      await openChat([q1, a1, q2, a2, q3, a3, q4]);
      createFixture(q2);

      prependConfirm('RECAP');
      await component.openPrependDialog();

      // The flow runner streamed through the orchestrator (mock).
      expect(orch.completion).toHaveBeenCalledTimes(1);
      const req = orch.completion.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };
      const askMessages = req.messages;
      expect(askMessages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(String(askMessages[0].content)).toBe('Root direction');
      expect(String(askMessages[1].content)).toBe('Chapter one.');
      // The LAST message (the prompt) ends with the FOLLOWING assistant
      // chapters — Chapter two. and Chapter three. — appended after the
      // director instruction.
      const prompt = String(askMessages[askMessages.length - 1].content);
      expect(prompt).toContain('RECAP');
      expect(prompt).toContain('Chapter two.');
      expect(prompt).toContain('Chapter three.');
      // The prompt must end with the following content, not the prior chapter.
      expect(prompt.indexOf('Chapter three.')).toBeGreaterThan(prompt.indexOf('Chapter two.'));
      expect(prompt.indexOf('Chapter two.')).toBeGreaterThan(prompt.indexOf('RECAP'));
    });

    it('a cancelled dialog keeps the state', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      prependConfirm('The events have already occurred.');
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(true);

      prependConfirm(null); // cancel
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(true);
    });

    it('an empty confirmation clears the director', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      prependConfirm('Some text');
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(true);

      prependConfirm('');
      await component.openPrependDialog();
      expect(component.prependEnabled()).toBe(false);
      expect(JSON.parse(localStorage.getItem('chat.prependByNodeId')!)).toEqual({});
    });

    it('reads a pre-stored prepend text for the rendered node', async () => {
      const q1 = node({ id: 'q1', content: '' });
      localStorage.setItem('chat.prependByNodeId', JSON.stringify({ q1: 'custom director' }));
      await openChat([q1]);
      createFixture(q1);

      expect(component.prependEnabled()).toBe(true);
      expect(component.prependText()).toBe('custom director');
    });

    it('shows the prepend toggle only for a user (direction) node', async () => {
      // A user node that already has an answer (not the empty draft composer).
      const q1 = node({ id: 'q1', content: 'A direction with a chapter' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'The chapter.' });
      await openChat([q1, a1]);
      createFixture(q1);

      const toggle = buttons().find((b) => (b.textContent || '').trim() === 'Prepend');
      expect(toggle).not.toBeNull();
      expect(toggle!.getAttribute('title')).toBe('Insert a director instruction before this direction: it invents events and situations that illustrate and lead up to the following chapters (≤ 5000 tokens) without contradicting them.');

      // A non-user (assistant) node should NOT carry the prepend button.
      createFixture(a1);
      fixture.detectChanges();
      const notFound = buttons().find((b) => (b.textContent || '').trim() === 'Prepend');
      expect(notFound).toBeUndefined();
    });

    it('uses the stored edited text over the characters-based default in the LLM call', async () => {
      const q1 = node({ id: 'q1', content: 'A' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction three' });
      const a3 = node({ id: 'a3', chatId: 'chat-1', parentId: 'q3', role: 'assistant', content: 'Chapter following.' });
      await openChat([q1, a1, q3, a3]);
      createFixture(q3);

      localStorage.setItem(
        'chat-client.elaborate.byChatId',
        JSON.stringify({ 'chat-1': { lastChapter: 2, characters: 'Anna, Ben' } }),
      );
      prependConfirm('My own director text (chars ignored).');
      await component.openPrependDialog();

      const req = orch.completion.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };
      const askMessages = req.messages;
      // The LAST message (the prompt) = edited text + the following chapter.
      const instruction = String(askMessages[askMessages.length - 1].content);
      expect(instruction).toContain('My own director text');
      expect(instruction).toContain('Chapter following.');
      expect(instruction).not.toContain('Anna');
    });

    it('falls back to the default director instruction when opening with no stored text', async () => {
      const q1 = node({ id: 'q1', content: 'A' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, q3]);
      createFixture(q3);

      // The dialog is seeded with the (basic) default — assert the proposal.
      prependConfirm(null); // cancel, nothing is stored / called
      await component.openPrependDialog();
      const proposed = (prependDialog.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(proposed).toContain('Assume the events');
      expect(proposed).not.toContain('{{characters}}');
      expect(orch.completion).not.toHaveBeenCalled();
    });

    it('restricts the FOLLOWING chapter sequence in the prompt to 5000 tokens, dropping the farthest whole chapters', async () => {
      const ch1 = 'A'.repeat(6000); // ~1500 tokens each (chars/4)
      const ch2 = 'B'.repeat(6000);
      const ch3 = 'C'.repeat(6000);
      const ch4 = 'D'.repeat(6000);

      // Current node = q2. Following chapters after it: a2(ch2), a3(ch3), a4(ch4)
      // = 4500 tokens (≤ 5000). Adding a fifth (ch5) would exceed the cap, so
      // only the 3 nearest following chapters make it into the prompt.
      const ch5 = 'E'.repeat(6000);
      const q1 = node({ id: 'q1', content: 'q1' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: ch1 });
      const q2 = node({ id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Direction 2' });
      const a2 = node({ id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant', content: ch2 });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a2', role: 'user', content: 'Direction 3' });
      const a3 = node({ id: 'a3', chatId: 'chat-1', parentId: 'q3', role: 'assistant', content: ch3 });
      const q4 = node({ id: 'q4', chatId: 'chat-1', parentId: 'a3', role: 'user', content: 'Direction 4' });
      const a4 = node({ id: 'a4', chatId: 'chat-1', parentId: 'q4', role: 'assistant', content: ch4 });
      const q5 = node({ id: 'q5', chatId: 'chat-1', parentId: 'a4', role: 'user', content: 'Direction 5' });
      const a5 = node({ id: 'a5', chatId: 'chat-1', parentId: 'q5', role: 'assistant', content: ch5 });
      const q6 = node({ id: 'q6', chatId: 'chat-1', parentId: 'a5', role: 'user', content: '' });
      await openChat([q1, a1, q2, a2, q3, a3, q4, a4, q5, a5, q6]);
      createFixture(q2);

      prependConfirm('DIRECTOR');
      await component.openPrependDialog();

      expect(orch.completion).toHaveBeenCalledTimes(1);
      const req = orch.completion.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };
      const askMessages = req.messages;
      // Last message (the prompt) = DIRECTOR + the 3 nearest following chapters.
      const prompt = String(askMessages[askMessages.length - 1].content);
      expect(prompt).toContain('DIRECTOR');
      expect(prompt).toContain(ch2);
      expect(prompt).toContain(ch3);
      expect(prompt).toContain(ch4);
      // The farthest following whole chapter was dropped, never truncated.
      expect(prompt).not.toContain(ch5);

      // Prior context (like insert) is the path up to the parent (a1).
      expect(askMessages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(String(askMessages[1].content)).toBe(ch1);
    });

    it('a failed LLM call clears the prepend flag and inserts no nodes', async () => {
      const q1 = node({ id: 'q1', content: 'A' });
      const a1 = node({ id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter one.' });
      const q3 = node({ id: 'q3', chatId: 'chat-1', parentId: 'a1', role: 'user', content: '' });
      await openChat([q1, a1, q3]);
      createFixture(q3);

      (orch.completion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
      prependConfirm('DIRECTOR');
      await component.openPrependDialog();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.prependEnabled()).toBe(false);
      // The failed stream still created the director user node; the flag is
      // rolled back and no result was inserted.
      const nodes = chatService.nodes();
      expect(nodes.some(n => n.role === 'assistant' && n.content === 'Generated')).toBe(false);
      expect(nodes.find(n => n.id === 'q3')?.parentId).toBe('a1');
    });

    it('after prepend the inserted director node becomes part of later contexts (incl. illustration)', async () => {
      const q1 = node({ id: 'q1', content: 'Root direction' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant',
        content: 'Mara folds the letter and watches the conductor pass.',
      });
      const q2 = node({ id: 'q2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'Night train, Mara at the window.' });
      const a2 = node({
        id: 'a2', chatId: 'chat-1', parentId: 'q2', role: 'assistant',
        content: 'The train crosses a frozen bridge.',
      });
      await openChat([q1, a1, q2, a2]);

      const generation = TestBed.inject(GenerationSettingsService);
      generation.update('image-create', { providerId: 'prov-1', modelId: 'alpha/model' });

      createFixture(q2, 'a2');
      prependConfirm('DIRECTOR');
      await component.openPrependDialog();
      await component.illustrate();
      fixture.detectChanges();

      // The prepend flow inserted a real director USER node BEFORE q2; the
      // subsequent illustration routes through the orchestration and is
      // placed on the chapter (a2). The director node is part of the tree.
      expect(runner.run).toHaveBeenCalled();
      const illustrationBuild = runner.run.mock.calls.at(-1)?.[0] as { usecase?: string };
      expect(illustrationBuild.usecase).toBe('render-node');
      const director = chatService.nodes().find(n => n.role === 'user' && n.content === 'DIRECTOR');
      expect(director).toBeDefined();
      expect(director!.parentId).toBe('a1');
      // The chapter (current assistant child of q2) has the illustration
      // attachment (editAssistant versions, so read the isCurrent child).
      const chapter = chatService.getChildren('q2').find(n => n.role === 'assistant' && n.isCurrent)!;
      expect(chapter.attachments?.some(a => a.name.startsWith('illustration-'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Right-click context menu
  // ------------------------------------------------------------------

  describe('right-click context menu', () => {
    /** A minimal right-click event with viewport coordinates + a target. */
    function ctxEvent(el: HTMLElement | null = null, x = 120, y = 90) {
      return {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: x,
        clientY: y,
        target: el ?? fixture.nativeElement.querySelector('.node'),
      } as unknown as MouseEvent;
    }

    it('opens the menu at the pointer and suppresses the native menu', () => {
      createFixture(node({ role: 'assistant', content: 'Chapter' }));
      const ev = ctxEvent();
      component.openNodeMenu(ev);

      expect(ev.preventDefault).toHaveBeenCalled();
      expect(component.ctxMenu()).toEqual({ x: 120, y: 90 });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.context-menu')).not.toBeNull();
    });

    it('keeps the native menu for editor internals and links/images', () => {
      createFixture(node({ role: 'assistant', content: 'Chapter' }));
      const targets: HTMLElement[] = [];
      for (const sel of ['textarea', 'input', 'select', 'a', 'img']) {
        targets.push(document.createElement(sel));
      }
      const link = document.createElement('a');
      link.className = 'file-link';
      targets.push(link);

      for (const el of targets) {
        const ev = { preventDefault: vi.fn(), clientX: 10, clientY: 10, target: el } as unknown as MouseEvent;
        component.openNodeMenu(ev);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(component.ctxMenu()).toBeNull();
      }
    });

    it('lists the common + destructive actions for a structure node', () => {
      createFixture(node({ role: 'structural', content: '' }));
      const items = component.ctxMenuItems();
      expect(items.filter((i) => !i.divider).map((i) => i.label)).toEqual([
        'Copy',
        'Edit',
        'Remove section',
        'Delete section & following',
      ]);
      expect(items.filter((i) => i.divider).length).toBe(1);
    });

    it('lists the assistant actions (heading, regenerate, illustrate) grouped with separators', async () => {
      const q1 = node({ id: 'q1', content: 'Question' });
      const a1 = node({
        id: 'a1', chatId: 'chat-1', parentId: 'q1', role: 'assistant', content: 'Chapter',
        modelId: 'alpha/model', providerId: 'prov-1',
      });
      await openChat([q1, a1]);
      createFixture(a1);

      const items = component.ctxMenuItems();
      expect(items.filter((i) => !i.divider).map((i) => i.label)).toEqual([
        'Copy',
        'Edit',
        'Rewrite selection…',
        'Add heading',
        'Regenerate',
        'Rewrite in place',
        'Illustrate',
        'Create image of selection…',
        'Remove section',
        'Delete section & following',
      ]);
      expect(items.filter((i) => i.divider).length).toBe(2);
      // The regenerate action is enabled (nothing is generating).
      expect(items.find((i) => i.label === 'Regenerate')?.disabled).toBe(false);
    });

    it('gives an unsent question the Continue and Switch characters items and no Prepend', async () => {
      const q1 = node({ id: 'q1', content: '' });
      await openChat([q1]);
      createFixture(q1);

      const labels = component.ctxMenuItems().filter((i) => !i.divider).map((i) => i.label);
      expect(labels).toContain('Continue');
      expect(labels).toContain('Switch characters');
      expect(labels).not.toContain('Prepend director');
    });

    it('runs an item action and closes the menu', () => {
      createFixture(node({ role: 'assistant', content: 'Copy me' }));
      component.openNodeMenu(ctxEvent());
      fixture.detectChanges();
      expect(component.ctxMenu()).not.toBeNull();

      const copyItem = component.ctxMenuItems().find((i) => i.label === 'Copy')!;
      const copySpy = vi
        .spyOn(component, 'copyContent')
        .mockResolvedValue(undefined);
      component.runCtxAction(copyItem);
      fixture.detectChanges();

      expect(copySpy).toHaveBeenCalled();
      expect(component.ctxMenu()).toBeNull();
    });

    it('ignores disabled and divider items', () => {
      createFixture(node({ role: 'user', content: 'x' }));
      const copyItem = component.ctxMenuItems().find((i) => i.label === 'Copy')!;
      copyItem.disabled = true;
      const copySpy = vi
        .spyOn(component, 'copyContent')
        .mockResolvedValue(undefined);
      const dividerAction = vi.fn();

      component.runCtxAction(copyItem);
      component.runCtxAction({ label: '', action: dividerAction, divider: true });

      expect(copySpy).not.toHaveBeenCalled();
      expect(dividerAction).not.toHaveBeenCalled();
    });

    it('closes on Escape', () => {
      createFixture(node({ content: 'x' }));
      component.openNodeMenu(ctxEvent());
      fixture.detectChanges();
      expect(component.ctxMenu()).not.toBeNull();

      component.onCtxEscape();
      expect(component.ctxMenu()).toBeNull();
    });

    it('clamps the position into the viewport', () => {
      createFixture(node({ role: 'assistant', content: 'Chapter' }));
      component.openNodeMenu(ctxEvent(undefined, 10_000, 10_000));
      fixture.detectChanges();

      const left = component.ctxMenuLeftPx();
      const top = component.ctxMenuTopPx();
      expect(left).toBeLessThan(window.innerWidth);
      expect(top).toBeLessThan(window.innerHeight);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(top).toBeGreaterThanOrEqual(8);
    });
  });
});

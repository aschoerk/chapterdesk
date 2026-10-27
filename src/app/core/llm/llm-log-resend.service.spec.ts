import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { SettingsService } from '../settings/settings.service';
import { ChatService } from '../chat/chat.service';
import { LlmLogService, LlmLogEntry } from './llm-log.service';
import { LlmOrchestratorService } from './orchestration/orchestrator';
import { LlmLogResendService } from './llm-log-resend.service';

describe('LlmLogResendService', () => {
  let api: InMemoryChatApi;
  let service: LlmLogResendService;
  let chat: ChatService;
  let logs: LlmLogService;
  const orchStub = { completion: vi.fn() };

  /** Seed a provider + model + a chat whose active path ends in an empty composer. */
  async function seedStory(): Promise<{ chatId: string; draftId: string }> {
    const c = await api.createChat('The Tale', null);
    const sys = await api.createNode(c.id, { parentId: null, role: 'system', content: 'You are a writer.' });
    const dir = await api.createNode(c.id, { parentId: sys.id, role: 'user', content: 'Original direction.' });
    const ans = await api.createNode(c.id, { parentId: dir.id, role: 'assistant', content: 'Chapter one.' });
    const draft = await api.createNode(c.id, { parentId: ans.id, role: 'user', content: '' });
    return { chatId: c.id, draftId: draft.id };
  }

  function chatEntry(
    chatId: string,
    messages?: unknown[],
    body?: unknown,
    extra?: Partial<LlmLogEntry>
  ): LlmLogEntry {
    const msgs = messages ?? [{ role: 'user', content: 'Edited direction.' }];
    return {
      seq: 1,
      ts: Date.now(),
      iso: new Date().toISOString(),
      kind: 'chat',
      modelId: 'm/1',
      provider: 'https://p',
      chatId,
      chatTitle: 'The Tale',
      messages: msgs as LlmLogEntry['messages'],
      body: (body ?? { model: 'm/1', messages: msgs, temperature: 0.7, stream: false }) as Record<string, unknown>,
      summary: '[llm:chat] …',
      ...extra,
    };
  }

  beforeEach(async () => {
    localStorage.clear();
    orchStub.completion.mockReset();
    api = new InMemoryChatApi();
    api.providers = [{
      id: 'p1', name: 'Prov', type: 'custom', baseUrl: 'https://p', apiKey: 'k', enabled: true,
    }];
    api.models = [
      {
        id: 'm1', displayName: 'Model', modelId: 'm/1', providerId: 'p1', type: 'preset', enabled: true,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'm2', displayName: 'Model Two', modelId: 'm/2', providerId: 'p1', type: 'preset', enabled: true,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ];

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: CHAT_API, useValue: api },
        { provide: LlmOrchestratorService, useValue: orchStub }
      ]
    }).compileComponents();

    service = TestBed.inject(LlmLogResendService);
    chat = TestBed.inject(ChatService);
    logs = TestBed.inject(LlmLogService);
    await TestBed.inject(SettingsService).loadAll();
  });

  describe('editableMessages', () => {
    it('passes string content through as editable text', () => {
      const out = service.editableMessages(chatEntry('c1', [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'direction' },
      ]));
      expect(out).toEqual([
        { role: 'system', text: 'sys' },
        { role: 'user', text: 'direction' },
      ]);
    });

    it('joins text parts and preserves non-text parts separately', () => {
      const out = service.editableMessages(chatEntry('c1', [{
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
        ],
      }]));
      expect(out).toEqual([{
        role: 'user',
        text: 'Look at this',
        parts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } }],
      }]);
    });
  });

  describe('buildMessages', () => {
    it('rebuilds plain messages from the edits', () => {
      const messages = service.buildMessages([
        { role: 'system', text: 'sys' },
        { role: 'user', text: 'Edited direction.' },
      ]);
      expect(messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Edited direction.' },
      ]);
    });

    it('re-attaches preserved media parts with the edited text', () => {
      const messages = service.buildMessages([{
        role: 'user',
        text: 'Edited text',
        parts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } }],
      }]);
      expect(messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'Edited text' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
        ],
      });
    });
  });

  describe('resend', () => {
    it('adds the response as a new chapter at the end of the chat', async () => {
      const { chatId, draftId } = await seedStory();
      orchStub.completion.mockResolvedValue({
        text: { status: 'ok', value: 'New chapter text.', meta: {} },
        thinking: { status: 'ok', value: '', meta: {} },
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,IMG=' }], meta: {} },
      });

      const result = await service.resend(chatEntry(chatId), [{ role: 'user', text: 'Edited direction.' }]);

      expect(result.ok).toBe(true);
      expect(result.images).toBe(1);

      // The composer draft became the direction with the edited text.
      const nodes = await api.getNodes(chatId);
      const question = nodes.find(n => n.id === draftId);
      expect(question?.content).toBe('Edited direction.');

      // A new answer chapter with the text + the returned picture attached.
      // The in-memory helper does not retire the old placeholder version, so
      // find the versioned answer by its content.
      const answer = nodes.find(n => n.parentId === draftId && n.role === 'assistant' && n.content === 'New chapter text.');
      expect(answer).not.toBeUndefined();
      expect(answer?.attachments?.length).toBe(1);
      expect(answer?.attachments?.[0].name).toContain('illustration-1');

      // The request was re-sent with the edited messages + the entry's model.
      const call = orchStub.completion.mock.calls[0];
      expect(call[1].model.modelId).toBe('m/1');
      expect(call[1].provider.baseUrl).toBe('https://p');
      expect(call[1].stream).toBe(false);
      expect(call[1].messages).toEqual([{ role: 'user', content: 'Edited direction.' }]);
    });

    it('returns model-missing without calling the LLM when the model is gone', async () => {
      const { chatId } = await seedStory();
      const entry = chatEntry(chatId);
      entry.modelId = 'gone/model';

      const result = await service.resend(entry, [{ role: 'user', text: 'Hi' }]);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('model');
      expect(orchStub.completion).not.toHaveBeenCalled();
    });

    it('does not create nodes when the call fails', async () => {
      const { chatId, draftId } = await seedStory();
      orchStub.completion.mockResolvedValue({
        error: { status: 'http', value: 'http', reason: '500: boom', meta: {} },
      });

      const result = await service.resend(chatEntry(chatId), [{ role: 'user', text: 'Edited direction.' }]);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('failed');
      expect(result.message).toContain('boom');

      const nodes = await api.getNodes(chatId);
      // Nothing was created before the call, so a failure leaves the chat
      // untouched: no stray answer under the draft, composer still empty.
      expect(nodes.some(n => n.parentId === draftId && n.role === 'assistant')).toBe(false);
      expect(nodes.find(n => n.id === draftId)?.content).toBe('');
    });

    it('creates a fresh direction node when the leaf is not an empty composer', async () => {
      const c = await api.createChat('The Tale', null);
      const sys = await api.createNode(c.id, { parentId: null, role: 'system', content: 'You are a writer.' });
      await api.createNode(c.id, { parentId: sys.id, role: 'user', content: 'Existing direction.' });
      await api.createNode(c.id, { parentId: sys.id, role: 'assistant', content: 'Chapter.' });

      orchStub.completion.mockResolvedValue({
        text: { status: 'ok', value: 'Replied.', meta: {} },
        thinking: { status: 'ok', value: '', meta: {} },
        images: { status: 'refused', value: [], reason: '(no image returned)', meta: {} },
      });

      const result = await service.resend(chatEntry(c.id), [{ role: 'user', text: 'Edited direction.' }]);
      expect(result.ok).toBe(true);

      const nodes = await api.getNodes(c.id);
      const question = nodes.find(n => n.content === 'Edited direction.');
      expect(question).not.toBeUndefined();
      const answer = nodes.find(n => n.parentId === question?.id && n.role === 'assistant' && n.content === 'Replied.');
      expect(answer).not.toBeUndefined();
      expect(answer?.attachments ?? []).toHaveLength(0);
    });

    it('uses the chosen model when an override is given', async () => {
      const { chatId } = await seedStory();
      orchStub.completion.mockResolvedValue({
        text: { status: 'ok', value: 'Replied.', meta: {} },
        thinking: { status: 'ok', value: '', meta: {} },
        images: { status: 'refused', value: [], reason: '(no image returned)', meta: {} },
      });

      const result = await service.resend(
        chatEntry(chatId), [{ role: 'user', text: 'Edited direction.' }], { modelId: 'm/2' }
      );
      expect(result.ok).toBe(true);
      expect(orchStub.completion.mock.calls[0][1].model.modelId).toBe('m/2');
    });

    it('attaches generated pictures to the original illustrated node', async () => {
      const c = await api.createChat('The Tale', null);
      const sys = await api.createNode(c.id, { parentId: null, role: 'system', content: 'You are a writer.' });
      const dir = await api.createNode(c.id, { parentId: sys.id, role: 'user', content: 'Draw a castle.' });
      const chapter = await api.createNode(c.id, { parentId: dir.id, role: 'assistant', content: 'The castle chapter.' });

      orchStub.completion.mockResolvedValue({
        text: { status: 'refused', value: '', reason: '(no text response)', meta: {} },
        thinking: { status: 'ok', value: '', meta: {} },
        images: { status: 'ok', value: [{ url: 'data:image/png;base64,NEWIMG=' }], meta: {} },
      });

      const entry = chatEntry(c.id, [{ role: 'user', content: 'A different prompt.' }], undefined, {
        usecase: 'image-generation',
        nodeId: chapter.id,
      });
      const result = await service.resend(entry, [{ role: 'user', text: 'A different prompt.' }]);

      expect(result.ok).toBe(true);
      expect(result.applied).toBe('attached');
      expect(result.images).toBe(1);
      // The call is attributed to the illustrated chapter.
      expect(orchStub.completion.mock.calls[0][2].nodeId).toBe(chapter.id);

      // The chapter got a NEW VERSION keeping its content + the new picture.
      const nodes = await api.getNodes(c.id);
      const versioned = nodes.find(n => n.content === 'The castle chapter.' && n.attachments?.length === 1);
      expect(versioned).not.toBeUndefined();
      expect(versioned?.attachments?.[0].name).toContain('illustration-1');
    });

    it('replaces the content of the originally created answer node', async () => {
      const c = await api.createChat('The Tale', null);
      const sys = await api.createNode(c.id, { parentId: null, role: 'system', content: 'You are a writer.' });
      const q = await api.createNode(c.id, { parentId: sys.id, role: 'user', content: 'Direction.' });
      const answer = await api.createNode(c.id, { parentId: q.id, role: 'assistant', content: 'Old answer.' });

      orchStub.completion.mockResolvedValue({
        text: { status: 'ok', value: 'New answer text.', meta: {} },
        thinking: { status: 'ok', value: '', meta: {} },
        images: { status: 'refused', value: [], reason: '(no image returned)', meta: {} },
      });

      const entry = chatEntry(c.id, [{ role: 'user', content: 'Direction.' }], undefined, {
        usecase: 'append',
        nodeId: answer.id,
      });
      const result = await service.resend(entry, [{ role: 'user', text: 'Direction (edited).' }]);

      expect(result.ok).toBe(true);
      expect(result.applied).toBe('replaced');
      expect(orchStub.completion.mock.calls[0][2].nodeId).toBe(answer.id);

      // The answer node was versioned with the new content, under the same
      // question.
      const nodes = await api.getNodes(c.id);
      const replaced = nodes.find(n => n.content === 'New answer text.' && n.role === 'assistant');
      expect(replaced).not.toBeUndefined();
      expect(replaced?.parentId).toBe(q.id);
    });

    it('falls back to a new chapter when the original node is gone', async () => {
      const { chatId } = await seedStory();
      orchStub.completion.mockResolvedValue({
        text: { status: 'ok', value: 'Fresh chapter.', meta: {} },
        thinking: { status: 'ok', value: '', meta: {} },
        images: { status: 'refused', value: [], reason: '(no image returned)', meta: {} },
      });

      const entry = chatEntry(chatId, [{ role: 'user', content: 'Edited direction.' }], undefined, {
        usecase: 'append',
        nodeId: 'nonexistent-node',
      });
      const result = await service.resend(entry, [{ role: 'user', text: 'Edited direction.' }]);

      expect(result.ok).toBe(true);
      expect(result.applied).toBe('chapter');

      const nodes = await api.getNodes(chatId);
      const question = nodes.find(n => n.content === 'Edited direction.');
      expect(question).not.toBeUndefined();
      const answer = nodes.find(n => n.parentId === question?.id && n.role === 'assistant' && n.content === 'Fresh chapter.');
      expect(answer).not.toBeUndefined();
    });
  });

  describe('model helpers', () => {
    it('availableModels returns the enabled models', () => {
      expect(service.availableModels().map(m => m.modelId)).toEqual(['m/1', 'm/2']);
    });

    it('defaultModelId prefers the original call model when enabled', () => {
      expect(service.defaultModelId(chatEntry('c1'))).toBe('m/1');
    });

    it('defaultModelId falls back to the first enabled model when the original is gone', () => {
      const entry = chatEntry('c1');
      entry.modelId = 'gone/model';
      expect(service.defaultModelId(entry)).toBe('m/1');
    });
  });
});

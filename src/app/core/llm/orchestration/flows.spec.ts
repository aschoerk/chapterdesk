import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeChat } from '../../../../../test-helpers/factories';
import { SettingsService } from '../../settings.service';
import { GenerationSettingsService } from '../../generation-settings.service';
import { ChatService } from '../../chat.service';
import { I18nService } from '../../i18n/i18n.service';
import { LlmFlowRunner, isFlowUsecase } from './flows';
import { LlmUseCaseRunner } from './usecases';
import { UsecaseContextFactory } from './context';
import { LlmLogService } from '../llm-log.service';
import { buildLoreNodeContent, isChatLoreNode } from '../../chat.service';

/** Streaming SSE body (one `data:` line per chunk + [DONE]). */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const lines = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return {
    ok: true, status: 200,
    headers: { get: () => 'text/event-stream' },
    body: new ReadableStream<Uint8Array>({
      start(controller) { for (const l of lines) controller.enqueue(enc.encode(l)); controller.close(); }
    })
  } as unknown as Response;
}

/** Non-streaming JSON text response (image-interpret step). */
function textResponse(text: string): Response {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { role: 'assistant', content: text } }] })
  } as unknown as Response;
}

/** Streaming SSE body delivering ONLY image_url parts (no text) + [DONE]. */
function sseImagesResponse(urls: string[]): Response {
  const enc = new TextEncoder();
  const lines = urls.map(u => `data: ${JSON.stringify({
    choices: [{ delta: { content: [{ type: 'image_url', image_url: { url: u } }] } }]
  })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return {
    ok: true, status: 200,
    headers: { get: () => 'text/event-stream' },
    body: new ReadableStream<Uint8Array>({
      start(controller) { for (const l of lines) controller.enqueue(enc.encode(l)); controller.close(); }
    })
  } as unknown as Response;
}

/**
 * Non-streaming JSON body delivering ONLY image_url parts (no text): a model
 * that CANNOT stream answers a direction request with an image in a plain
 * `application/json` body (it ignored `stream: true`).
 */
function jsonImagesResponse(urls: string[]): Response {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant',
          content: urls.map(u => ({ type: 'image_url', image_url: { url: u } }))
        }
      }]
    })
  } as unknown as Response;
}

const CHAT_ID = 'chat-1';
const IMG = { id: 'img', name: 'pic.png', mimeType: 'image/png', size: 4, dataUrl: 'data:image/png;base64,AAAA' };

describe('LLM orchestration — structural flows (branch / insert / regenerate / rewrite / prepend)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function openChat(nodes: ReturnType<typeof makeNode>[]): Promise<ChatService> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' },
        { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }
      ]
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = nodes.map(n => ({ ...n, chatId: CHAT_ID }));
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    return chatService;
  }

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('isFlowUsecase recognizes the structural kinds', () => {
    for (const k of ['send-branch', 'send-insert', 'send-regenerate', 'send-rewrite', 'send-prepend', 'send-elaborate', 'send-chapter-descriptions', 'structure-title', 'structure-overview', 'structure-heading', 'structure-headings', 'language-check']) {
      expect(isFlowUsecase(k as never)).toBe(true);
    }
    expect(isFlowUsecase('append' as never)).toBe(false);
    expect(isFlowUsecase('render-node' as never)).toBe(false);
  });

  it('send-branch: creates a new sibling question and streams an answer under it', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['Branch ', 'answer.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', isCurrent: true })
    ]);
    const current = chatService.nodes().find(n => n.id === 'q1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: current,
      usecase: 'send-branch',
      vars: { content: 'Alternative path' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // streamed answer only
    const branch = chatService.nodes().find(n => n.role === 'user' && n.content === 'Alternative path');
    expect(branch).toBeDefined();
    expect(branch!.id).not.toBe('q1');
    expect(branch!.parentId).toBeNull(); // sibling of q1 (root)
    // Answer under the branch question (versioned id from the flow slot).
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Branch answer.');
    expect(answerNode.parentId).toBe(branch!.id);
    expect(chatService.getActiveChild(branch!.parentId)?.id).toBe(branch!.id);
    expect(slots.flow?.value?.activateId).toBe(branch!.id);
    expect(slots.text?.value).toBe('Branch answer.');
  });

  it('send-branch: an IMAGE-ONLY answer (no text) is finalized with its attachments, not left empty', async () => {
    // The stream delivers only image_url parts — the model returned no text.
    const url = 'data:image/png;base64,AAAA';
    fetchMock.mockResolvedValueOnce(sseImagesResponse([url]));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', isCurrent: true })
    ]);
    const current = chatService.nodes().find(n => n.id === 'q1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: current,
      usecase: 'send-branch',
      vars: { content: 'Render the scene' }
    });

    // The branch answer was finalized (versioned) — NOT an empty placeholder.
    // The model returned only an image, so the chapter is filled with the
    // direction text and the generated picture is attached below it.
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Render the scene');
    expect(answerNode.attachments?.length).toBe(1);
    expect(answerNode.attachments![0].name).toMatch(/^illustration-1\./);
    expect(answerNode.attachments![0].dataUrl).toBe(url);
    expect(answerNode.parentId).toBe(chatService.nodes().find(n => n.role === 'user' && n.content === 'Render the scene')!.id);
    // The flow is NOT reported as empty (an image IS content).
    expect(slots.flow?.value?.empty).toBe(false);
    // The images also surface in the slots.
    expect(slots.images?.value).toHaveLength(1);
  });

  it('send-branch: an IMAGE-ONLY answer from a NON-STREAMING model is attached to the answer node', async () => {
    // The model cannot stream: the `stream: true` request is answered with a
    // plain application/json body carrying ONLY an image. The flow must STILL
    // finalize the assistant node with that image attached — otherwise it
    // stays an empty placeholder and the picture is lost.
    const url = 'data:image/png;base64,AAAA';
    fetchMock.mockResolvedValueOnce(jsonImagesResponse([url]));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', isCurrent: true })
    ]);
    const current = chatService.nodes().find(n => n.id === 'q1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: current,
      usecase: 'send-branch',
      vars: { content: 'Render the scene' }
    });

    // The branch answer was finalized (versioned) with the image attached.
    // The model returned only an image → the chapter carries the direction
    // text and the picture is attached below it.
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Render the scene');
    expect(answerNode.attachments?.length).toBe(1);
    expect(answerNode.attachments![0].dataUrl).toBe(url);
    expect(answerNode.attachments![0].name).toMatch(/^illustration-1\./);
    expect(answerNode.parentId).toBe(chatService.nodes().find(n => n.role === 'user' && n.content === 'Render the scene')!.id);
    // The flow is NOT reported as empty (an image IS content).
    expect(slots.flow?.value?.empty).toBe(false);
    expect(slots.images?.value).toHaveLength(1);
  });

  it('send-branch: a NON-STREAMING model\'s full text answer still reaches the answer node', async () => {
    // The endpoint cannot stream but ignores `stream: true` and answers with
    // a plain application/json body — the text must reach the node instead of
    // being dropped by the SSE parser (which would refuse "(no response)").
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Full text answer.' } }] })
    } as unknown as Response);
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', isCurrent: true })
    ]);
    const current = chatService.nodes().find(n => n.id === 'q1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: current,
      usecase: 'send-branch',
      vars: { content: 'Continue the story' }
    });

    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Full text answer.');
    expect(slots.text?.value).toBe('Full text answer.');
    expect(slots.text?.status).toBe('ok');
  });

  it('send-branch: respects a model/chat configured NOT to stream (stream:false) and issues a clean non-streaming request', async () => {
    // The model is configured as non-streaming (chat parameters stream:false):
    // resolveTextExtras returns { stream: false }. send-branch must NOT force
    // `stream: true` — it issues ONE plain non-streaming completion whose full
    // text reaches the answer node (no SSE, no transport fallback dance).
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', isCurrent: true })
    ]);
    // Spy AFTER openChat (it resets + reconfigures the module): the factory
    // returns stream:false like a model/chat configured NOT to stream.
    const factory = TestBed.inject(UsecaseContextFactory);
    const streamFalse = vi.spyOn(factory, 'resolveTextExtras')
      .mockResolvedValue({ stream: false } as any);
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Configured no-stream answer.' } }] })
    } as unknown as Response);
    try {
      const current = chatService.nodes().find(n => n.id === 'q1')!;

      const runner = TestBed.inject(LlmFlowRunner);
      const slots = await runner.run({
        chat: api.chats[0],
        node: current,
        usecase: 'send-branch',
        vars: { content: 'Continue the story' }
      });

      // Exactly ONE network call, and it went out with stream:false.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { stream?: boolean };
      expect(body.stream).toBe(false);
      // The full non-stream text reached the answer node.
      const answerId = slots.flow!.value!.answerNodeId;
      const answerNode = chatService.nodes().find(n => n.id === answerId)!;
      expect(answerNode.content).toBe('Configured no-stream answer.');
      expect(slots.text?.value).toBe('Configured no-stream answer.');
      expect(slots.text?.status).toBe('ok');
    } finally {
      streamFalse.mockRestore();
    }
  });

  it('send-branch: routes an image-GENERATION WRITE model to /images and attaches the picture', async () => {
    // The writing model is an image-GENERATION model served ONLY on the
    // /images endpoint (it cannot answer chat completions, stream or not).
    // send-branch must route there with the direction text as the image
    // prompt and attach the returned picture to the assistant node.
    fetchMock
      .mockResolvedValueOnce({
        ok: false, status: 404,
        text: async () => '{"error":{"message":"qwen/qwen-image is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead."}}'
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: [{ b64_json: 'AAAA', media_type: 'image/png' }] })
      } as unknown as Response);
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer', isCurrent: true })
    ]);
    const current = chatService.nodes().find(n => n.id === 'q1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: current,
      usecase: 'send-branch',
      vars: { content: 'Render the scene' }
    });

    // First the chat-completions attempt, then the /images route.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chat/completions');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/images');
    // The /images call carried the direction text as the prompt.
    const imagesBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as { prompt?: string };
    expect(imagesBody.prompt).toContain('Render the scene');
    // The picture is attached to the (versioned) answer node. The model
    // returned only an image → the chapter carries the direction text.
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Render the scene');
    expect(answerNode.attachments?.length).toBe(1);
    expect(answerNode.attachments![0].dataUrl).toBe('data:image/png;base64,AAAA');
    expect(answerNode.attachments![0].name).toMatch(/^illustration-1\./);
    // The flow is NOT reported as empty (an image IS content).
    expect(slots.flow?.value?.empty).toBe(false);
    expect(slots.images?.value).toHaveLength(1);
  });

  it('send-insert: creates a sibling + answer and hangs the old siblings under the new answer', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['Inserted ', 'answer.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Earlier question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Old answer', isCurrent: true })
    ]);
    const current = chatService.nodes().find(n => n.id === 'q1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: current,
      usecase: 'send-insert',
      vars: { content: 'Inserted question' }
    });

    const branch = chatService.nodes().find(n => n.content === 'Inserted question');
    expect(branch).toBeDefined();
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Inserted answer.');
    // The OLD question (q1) is now hung under the new answer (versioned id).
    expect(chatService.nodes().find(n => n.id === 'q1')!.parentId).toBe(answerId);
    // Active chain: root → branch → answer → old question.
    expect(chatService.getActiveChild(null)?.id).toBe(branch!.id);
    expect(chatService.getActiveChild(branch!.id)?.id).toBe(answerId);
    expect(slots.flow?.value?.branchNodeId).toBe(branch!.id);
  });

  it('send-regenerate: deletes the old answer and re-streams under the same question', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['Fresh ', 'answer.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Old answer', isCurrent: true, modelId: 'alpha/model' }),
      makeNode({ id: 'd1', parentId: 'a1', role: 'user', content: 'following', isCurrent: true })
    ]);
    const oldAnswer = chatService.nodes().find(n => n.id === 'a1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: oldAnswer,
      usecase: 'send-regenerate',
      vars: {}
    });

    // Old answer + its subtree are gone; a fresh answer sits under q1.
    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    expect(chatService.nodes().find(n => n.id === 'd1')).toBeUndefined();
    const fresh = chatService.nodes().find(n => n.role === 'assistant' && n.content === 'Fresh answer.');
    expect(fresh).toBeDefined();
    expect(fresh!.parentId).toBe('q1');
    expect(slots.flow?.value?.questionNodeId).toBe('q1');
  });

  it('send-regenerate: an IMAGE-ONLY answer fills the fresh answer with the direction and attaches the image', async () => {
    // The writing model answered the regenerated direction with ONLY a picture
    // (non-stream JSON, image-only). The fresh chapter must carry the direction
    // text again and the generated image as an attachment.
    const url = 'data:image/png;base64,AAAA';
    fetchMock.mockResolvedValueOnce(jsonImagesResponse([url]));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Render the castle' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Old answer', isCurrent: true, modelId: 'alpha/model' }),
      makeNode({ id: 'd1', parentId: 'a1', role: 'user', content: 'following', isCurrent: true })
    ]);
    const oldAnswer = chatService.nodes().find(n => n.id === 'a1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: oldAnswer,
      usecase: 'send-regenerate',
      vars: {}
    });

    // Old answer + its subtree are gone.
    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    expect(chatService.nodes().find(n => n.id === 'd1')).toBeUndefined();
    const answerId = slots.flow!.value!.answerNodeId;
    const fresh = chatService.nodes().find(n => n.id === answerId)!;
    expect(fresh.parentId).toBe('q1');
    // Image-only → the chapter repeats the direction and carries the picture.
    expect(fresh.content).toBe('Render the castle');
    expect(fresh.attachments?.length).toBe(1);
    expect(fresh.attachments![0].dataUrl).toBe(url);
    expect(fresh.attachments![0].name).toMatch(/^illustration-1\./);
    expect(slots.flow?.value?.empty).toBe(false);
  });

  it('send-rewrite: deletes only the answer and re-adopts the preserved children', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['Rewritten ', 'answer.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Old answer', isCurrent: true, modelId: 'alpha/model' }),
      makeNode({ id: 'd1', parentId: 'a1', role: 'user', content: 'Continues here', isCurrent: true })
    ]);
    const oldAnswer = chatService.nodes().find(n => n.id === 'a1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: oldAnswer,
      usecase: 'send-rewrite',
      vars: {}
    });

    // The old answer is gone, but the FOLLOWING text (d1) is preserved and
    // re-hung under the fresh answer (versioned id).
    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Rewritten answer.');
    expect(answerNode.parentId).toBe('q1');
    const following = chatService.nodes().find(n => n.id === 'd1');
    expect(following).toBeDefined();
    expect(following!.parentId).toBe(answerId);
    expect(chatService.getActiveChild(answerId)?.id).toBe('d1');
    expect(slots.flow?.value?.activateId).toBe('q1');
  });

  it('send-rewrite: routes an image-GENERATION WRITE model to /images and re-attaches the picture', async () => {
    // send-rewrite with an image-generation writing model: the chat
    // completions attempt fails (model lives only on /images) → routed there
    // → the fresh answer carries the picture as an attachment.
    fetchMock
      .mockResolvedValueOnce({
        ok: false, status: 404,
        text: async () => '{"error":{"message":"image generation model cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead."}}'
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: [{ b64_json: 'BBBB', media_type: 'image/png' }] })
      } as unknown as Response);
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Old answer', isCurrent: true, modelId: 'alpha/model' }),
      makeNode({ id: 'd1', parentId: 'a1', role: 'user', content: 'Continues here', isCurrent: true })
    ]);
    const oldAnswer = chatService.nodes().find(n => n.id === 'a1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: oldAnswer,
      usecase: 'send-rewrite',
      vars: {}
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/images');
    // Old answer gone; the fresh answer carries the generated picture and re-
    // adopts the preserved following text. The model returned only an image →
    // the chapter is filled with the direction text (the parent question).
    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    expect(answerNode.content).toBe('Question');
    expect(answerNode.attachments?.length).toBe(1);
    expect(answerNode.attachments![0].dataUrl).toBe('data:image/png;base64,BBBB');
    const following = chatService.nodes().find(n => n.id === 'd1');
    expect(following).toBeDefined();
    expect(following!.parentId).toBe(answerId);
    expect(slots.flow?.value?.empty).toBe(false);
  });

  it('send-rewrite: PRESERVES the old answer\'s attachments and merges the new image (previous pictures stay available)', async () => {
    // The old answer already carried a generated illustration. A rewrite in
    // place must KEEP that attachment (the old image stays available) and
    // ADD the newly generated one (renumbered after the preserved picture).
    const oldImg = {
      id: 'old-img', name: 'illustration-1.png', mimeType: 'image/png', size: 4,
      dataUrl: 'data:image/png;base64,OLDOLD'
    };
    fetchMock.mockResolvedValueOnce(jsonImagesResponse(['data:image/png;base64,NEWNEW']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Render the castle' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Old answer', isCurrent: true, modelId: 'alpha/model', attachments: [oldImg] }),
      makeNode({ id: 'd1', parentId: 'a1', role: 'user', content: 'Continues here', isCurrent: true })
    ]);
    const oldAnswer = chatService.nodes().find(n => n.id === 'a1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: oldAnswer,
      usecase: 'send-rewrite',
      vars: {}
    });

    expect(chatService.nodes().find(n => n.id === 'a1')).toBeUndefined();
    const answerId = slots.flow!.value!.answerNodeId;
    const answerNode = chatService.nodes().find(n => n.id === answerId)!;
    // The old picture AND the new one are both attached — the old image
    // remains available after the rewrite.
    expect(answerNode.attachments?.length).toBe(2);
    expect(answerNode.attachments![0].dataUrl).toBe('data:image/png;base64,OLDOLD');
    expect(answerNode.attachments![0].name).toBe('illustration-1.png');
    expect(answerNode.attachments![1].dataUrl).toBe('data:image/png;base64,NEWNEW');
    // New image is renumbered after the preserved one (illustration-2).
    expect(answerNode.attachments![1].name).toBe('illustration-2.png');
    // Content fill still applies (image-only).
    expect(answerNode.content).toBe('Render the castle');
  });

  it('send-prepend: inserts a director node + result BEFORE the current direction, adopting it', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['Narration ', 'result.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Root direction' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Chapter one.', isCurrent: true }),
      makeNode({ id: 'q2', parentId: 'a1', role: 'user', content: 'Direction two', isCurrent: true })
    ]);
    const current = chatService.nodes().find(n => n.id === 'q2')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: current,
      usecase: 'send-prepend',
      vars: { directorText: 'DIRECTOR', followingText: 'Chapter two.' }
    });

    const director = chatService.nodes().find(n => n.role === 'user' && n.content === 'DIRECTOR');
    expect(director).toBeDefined();
    expect(director!.parentId).toBe('a1');
    const answerId = slots.flow!.value!.answerNodeId;
    const result = chatService.nodes().find(n => n.id === answerId)!;
    expect(result.content).toBe('Narration result.');
    expect(result.parentId).toBe(director!.id);
    // The current direction q2 is adopted under the result (versioned id).
    expect(chatService.nodes().find(n => n.id === 'q2')!.parentId).toBe(answerId);
    expect(chatService.getActiveChild('a1')?.id).toBe(director!.id);
    expect(slots.flow?.value?.directorNodeId).toBe(director!.id);
    expect(slots.flow?.value?.activateId).toBe(answerId);
  });

  it('send-elaborate: append an answer under a fresh question under the anchor, honoring the model override', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['Elaborated ', 'chapter.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Chapters' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Chapter one.', isCurrent: true, modelId: 'alpha/model' })
    ]);
    const anchor = chatService.nodes().find(n => n.id === 'a1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: anchor,
      usecase: 'send-elaborate',
      vars: { content: 'elaborate on chapter 1', modelId: 'beta/model', providerId: 'prov-1' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // the streamed answer only
    const question = chatService.nodes().find(n => n.role === 'user' && n.content === 'elaborate on chapter 1');
    expect(question).toBeDefined();
    expect(question!.parentId).toBe('a1');
    expect(question!.modelId).toBe('beta/model'); // dialog-chosen model wins
    const answerId = slots.flow!.value!.answerNodeId;
    const answer = chatService.nodes().find(n => n.id === answerId)!;
    expect(answer.parentId).toBe(question!.id);
    expect(answer.content).toBe('Elaborated chapter.');
    expect(answer.modelId).toBe('beta/model'); // versioned answer keeps the binding
    expect(chatService.getActiveChild('a1')?.id).toBe(question!.id);
    expect(slots.flow?.value?.activateId).toBe(answerId);
  });

  it('send-elaborate: reuses an existing empty user leaf draft under the anchor', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['Elaborated ', 'chapter.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Chapters' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Chapter one.', isCurrent: true }),
      makeNode({ id: 'draft', parentId: 'a1', role: 'user', content: '', isCurrent: true })
    ]);
    const anchor = chatService.nodes().find(n => n.id === 'a1')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: anchor,
      usecase: 'send-elaborate',
      vars: { content: 'elaborate on chapter 1' }
    });

    const question = chatService.nodes().find(n => n.role === 'user' && n.content === 'elaborate on chapter 1');
    expect(question).toBeDefined();
    expect(question!.id).toBe('draft'); // the existing empty leaf was reused
    expect(question!.parentId).toBe('a1');
    const answerId = slots.flow!.value!.answerNodeId;
    const answer = chatService.nodes().find(n => n.id === answerId)!;
    expect(answer.parentId).toBe('draft');
    expect(answer.content).toBe('Elaborated chapter.');
  });

  it('send-chapter-descriptions: branches a sibling question with the request and streams the list (previous chat content as history)', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['1. ', 'One — start.\n2. Two — continue.']));
    const chatService = await openChat([
      makeNode({ id: 'q1', role: 'user', content: 'Write a story' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Chapter one.', isCurrent: true }),
      makeNode({ id: 'draft', parentId: 'a1', role: 'user', content: '', isCurrent: true })
    ]);
    const draft = chatService.nodes().find(n => n.id === 'draft')!;

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: draft,
      usecase: 'send-chapter-descriptions',
      vars: { chapterCount: 3, sentencesPerChapter: 2, firstChapter: 4, goal: 'Make it a detective story' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // the streamed answer only
    // The draft stays untouched — the list is generated as ANOTHER branch.
    expect(chatService.nodes().find(n => n.id === 'draft')!.content).toBe('');
    // A sibling question under the same parent carries the chapter request,
    // including every dialog parameter + goal.
    const question = chatService.nodes().find(n =>
      n.role === 'user' && n.content?.includes('Number of chapters to plan: 3'));
    expect(question).toBeDefined();
    expect(question!.parentId).toBe('a1');
    expect(question!.id).not.toBe('draft');
    expect(question!.content).toContain('Sentences per chapter description: 2');
    expect(question!.content).toContain('First chapter number: 4');
    expect(question!.content).toContain('Make it a detective story');
    // The streamed answer hangs under the branch question.
    const answerId = slots.flow!.value!.answerNodeId;
    const answer = chatService.nodes().find(n => n.id === answerId)!;
    expect(answer.parentId).toBe(question!.id);
    expect(answer.content).toBe('1. One — start.\n2. Two — continue.');
    expect(chatService.getActiveChild('a1')?.id).toBe(question!.id);
    expect(slots.flow?.value?.activateId).toBe(answerId);
  });
});

describe('LLM orchestration — structure generation + language check flows', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function openStory(nodes: ReturnType<typeof makeNode>[]): Promise<ChatService> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' },
        { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }
      ]
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = nodes.map(n => ({ ...n, chatId: CHAT_ID }));
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    return chatService;
  }

  /** The user message content of the FIRST completion call. */
  function firstCompletionUserContent(): string {
    const body = (fetchMock.mock.calls[0][1] as { body: string }).body;
    const payload = JSON.parse(body) as { messages: { role: string; content: string }[] };
    return payload.messages.find(m => m.role === 'user')!.content;
  }

  it('structure-title: wraps the story under a root title and sets the chat title', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('The Long Night'));
    const chatService = await openStory([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true, modelId: 'alpha/model' }),
      makeNode({ id: 'a2', parentId: 'q1', role: 'assistant', content: 'Answer two', isCurrent: true })
    ]);
    chatService.setActiveChild(null, 'q1');
    const runner = TestBed.inject(LlmFlowRunner);
    // The log must carry the current use case for every request it records.
    const recordSpy = vi.spyOn(TestBed.inject(LlmLogService), 'record');
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'a1')!,
      usecase: 'structure-title',
      vars: { modelId: 'alpha/model', providerId: 'prov-1' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // one non-streaming completion
    expect(recordSpy).toHaveBeenCalled();
    expect(recordSpy.mock.calls[0][0].usecase).toBe('structure-title');
    expect(recordSpy.mock.calls[0][0].chatId).toBe(CHAT_ID);
    const content = firstCompletionUserContent();
    expect(content).toContain('Answer one');
    expect(content).toContain('Answer two');
    expect(content).not.toContain('Question');

    const title = chatService.nodes().find(n => n.role === 'structural');
    expect(title).toBeDefined();
    expect(title!.content).toBe('The Long Night');
    expect(title!.parentId).toBeNull();
    expect(chatService.nodes().find(n => n.id === 'q1')!.parentId).toBe(title!.id);
    expect(chatService.getActivePath()[0].id).toBe(title!.id);
    expect(chatService.chats().find(c => c.id === CHAT_ID)!.title).toBe('The Long Night');
    expect(slots.flow?.value?.structureNodeId).toBe(title!.id);
  });

  it('structure-overview: places the introduction right after an existing structure node', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('An introduction.'));
    const chatService = await openStory([
      makeNode({ id: 't1', role: 'structural', content: 'Story title' }),
      makeNode({ id: 'q1', parentId: 't1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true })
    ]);
    chatService.setActiveChild(null, 't1');
    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'a1')!,
      usecase: 'structure-overview',
      vars: { modelId: 'alpha/model', providerId: 'prov-1' }
    });

    const intro = chatService.nodes().find(n => n.role === 'structural' && n.content === 'An introduction.');
    expect(intro).toBeDefined();
    expect(intro!.parentId).toBe('t1'); // sits right after the existing structure node
    expect(chatService.nodes().find(n => n.id === 'q1')!.parentId).toBe(intro!.id);
    expect(slots.flow?.value?.structureNodeId).toBe(intro!.id);
  });

  it('structure-overview: becomes the first node when the story has no structure node', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Introduction first.'));
    const chatService = await openStory([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true })
    ]);
    chatService.setActiveChild(null, 'q1');
    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'q1')!,
      usecase: 'structure-overview',
      vars: { modelId: 'alpha/model', providerId: 'prov-1' }
    });

    const intro = chatService.nodes().find(n => n.role === 'structural');
    expect(intro!.parentId).toBeNull();
    expect(chatService.nodes().find(n => n.id === 'q1')!.parentId).toBe(intro!.id);
    expect(chatService.getActivePath()[0].id).toBe(intro!.id);
    expect(slots.flow?.value?.structureNodeId).toBe(intro!.id);
  });

  it('structure-heading: wraps the chapter under a NEW heading using only the chapter text', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Chapter Heading'));
    const chatService = await openStory([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Chapter text', isCurrent: true, modelId: 'alpha/model' })
    ]);
    const chapter = chatService.nodes().find(n => n.id === 'a1')!;
    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: chapter,
      usecase: 'structure-heading',
      vars: { modelId: 'alpha/model', providerId: 'prov-1' }
    });

    // only the chapter's own text reaches the model
    const content = firstCompletionUserContent();
    expect(content).toContain('Chapter text');
    expect(content).not.toContain('Question');

    const headingId = slots.flow?.value?.structureNodeId;
    const heading = chatService.nodes().find(n => n.id === headingId)!;
    expect(heading.role).toBe('structural');
    expect(heading.content).toBe('Chapter Heading');
    expect(heading.parentId).toBe('q1');
    expect(chatService.nodes().find(n => n.id === 'a1')!.parentId).toBe(headingId);
    expect(chatService.getActiveChild('q1')?.id).toBe(headingId);
    expect(chatService.getActiveChild(headingId ?? null)?.id).toBe('a1');
  });

  it('structure-heading: PATCHES the existing structural parent of the chapter', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('New Heading'));
    const chatService = await openStory([
      makeNode({ id: 'q1', role: 'user', content: 'Question' }),
      makeNode({ id: 'h1', parentId: 'q1', role: 'structural', content: 'Old heading' }),
      makeNode({ id: 'a1', parentId: 'h1', role: 'assistant', content: 'Chapter text', isCurrent: true })
    ]);
    const chapter = chatService.nodes().find(n => n.id === 'a1')!;
    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: chapter,
      usecase: 'structure-heading',
      vars: { modelId: 'alpha/model', providerId: 'prov-1' }
    });

    expect(slots.flow?.value?.structureNodeId).toBe('h1');
    expect(chatService.nodes().find(n => n.id === 'h1')!.content).toBe('New Heading');
    expect(chatService.nodes().find(n => n.id === 'a1')!.parentId).toBe('h1');
  });

  it('structure-headings: heads every unheaded chapter, keeping prior headings in context', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('First Heading'));
    fetchMock.mockResolvedValueOnce(textResponse('Second Heading'));
    const chatService = await openStory([
      makeNode({ id: 'q1', role: 'user', content: 'Q1' }),
      makeNode({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer one', isCurrent: true }),
      makeNode({ id: 'q2', parentId: 'a1', role: 'user', content: 'Q2' }),
      makeNode({ id: 'a2', parentId: 'q2', role: 'assistant', content: 'Answer two', isCurrent: true })
    ]);
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    chatService.setActiveChild('a1', 'q2');
    chatService.setActiveChild('q2', 'a2');

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'a1')!,
      usecase: 'structure-headings',
      vars: { modelId: 'alpha/model', providerId: 'prov-1' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2); // one completion per chapter
    const headings = chatService.nodes().filter(n => n.role === 'structural');
    expect(headings).toHaveLength(2);
    const a1Heading = chatService.nodes().find(n => n.id === 'a1')!.parentId;
    expect(chatService.nodes().find(n => n.id === a1Heading)!.role).toBe('structural');
    const a2Heading = chatService.nodes().find(n => n.id === 'a2')!.parentId;
    expect(chatService.nodes().find(n => n.id === a2Heading)!.role).toBe('structural');
    expect(slots.flow?.value?.structureNodeIds?.length).toBe(2);

    // the SECOND completion context includes the earlier chapter + its heading
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as {
      messages: { role: string; content: string }[];
    };
    const secondUser = secondBody.messages.find(m => m.role === 'user')!.content;
    expect(secondUser).toContain('Answer one');
    expect(secondUser).toContain('"First Heading"');
    expect(secondUser).toContain('Answer two');
  });

  it('structure-headings: skips chapters that already have a heading but keeps them in context', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('New Heading'));
    const chatService = await openStory([
      makeNode({ id: 'q1', role: 'user', content: 'Q1' }),
      makeNode({ id: 'h1', parentId: 'q1', role: 'structural', content: 'Existing Heading' }),
      makeNode({ id: 'a1', parentId: 'h1', role: 'assistant', content: 'Answer one', isCurrent: true }),
      makeNode({ id: 'q2', parentId: 'a1', role: 'user', content: 'Q2' }),
      makeNode({ id: 'a2', parentId: 'q2', role: 'assistant', content: 'Answer two', isCurrent: true })
    ]);
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'h1');
    chatService.setActiveChild('h1', 'a1');
    chatService.setActiveChild('a1', 'q2');
    chatService.setActiveChild('q2', 'a2');

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'a1')!,
      usecase: 'structure-headings',
      vars: { modelId: 'alpha/model', providerId: 'prov-1' }
    });

    // a1 already has h1 → only a2 gets a new heading
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const structural = chatService.nodes().filter(n => n.role === 'structural');
    expect(structural).toHaveLength(2); // h1 + new one
    expect(slots.flow?.value?.structureNodeIds?.length).toBe(1);
    // the pre-existing heading appears in the context for a2
    const content = firstCompletionUserContent();
    expect(content).toContain('"Existing Heading"');
    expect(content).toContain('Answer two');
  });

  it('language-check: returns the raw corrected variants (no chat mutation)', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('["minimal fix.","clearer rewording.","full restate."]'));
    const chatService = await openStory([
      makeNode({ id: 'q1', role: 'user', content: 'A direction', isCurrent: true })
    ]);
    chatService.setActiveChild(null, 'q1');

    const runner = TestBed.inject(LlmFlowRunner);
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'q1')!,
      usecase: 'language-check',
      vars: { content: 'She go to the store.', modelId: 'alpha/model', providerId: 'prov-1' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slots.text?.value).toBe('["minimal fix.","clearer rewording.","full restate."]');
    expect(chatService.nodes().filter(n => n.role === 'structural')).toHaveLength(0);
    const content = firstCompletionUserContent();
    expect(content).toContain('Original direction:');
    expect(content).toContain('She go to the store.');
  });
});

describe('LLM orchestration — rewrite-selection (marked text → variants)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function openRewriteStory(): Promise<ChatService> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' },
        { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }
      ]
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = [
      makeNode({ id: 'q1', role: 'user', content: 'Opening direction', isCurrent: true }),
      makeNode({
        id: 'a1', parentId: 'q1', role: 'assistant',
        content: 'The hero enters the old tower. A wind howls through broken shutters.',
        isCurrent: true, modelId: 'alpha/model'
      }),
      makeNode({
        id: 'q2', parentId: 'a1', role: 'user',
        content: 'Make the tower scary and short.', isCurrent: true
      })
    ];
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    chatService.setActiveChild(null, 'q1');
    chatService.setActiveChild('q1', 'a1');
    chatService.setActiveChild('a1', 'q2');
    return chatService;
  }

  function firstCompletionUserContent(): string {
    const body = (fetchMock.mock.calls[0][1] as { body: string }).body;
    const payload = JSON.parse(body) as { messages: { role: string; content: string }[] };
    return payload.messages.find(m => m.role === 'user')!.content;
  }

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('isFlowUsecase recognizes rewrite-selection', () => {
    expect(isFlowUsecase('rewrite-selection' as never)).toBe(true);
  });

  it('no context: sends only instructions + directions + the marked text', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['["short fix.",', '"clearer keep.",', '"scary restate."]']));
    const chatService = await openRewriteStory();
    const runner = TestBed.inject(LlmFlowRunner);
    // selectChat() may append an empty composer leaf under the trailing q2
    // (the active path must end on a draft), so snapshot the node count and
    // assert the rewrite-selection FLOW itself does not mutate the chat.
    const nodesBefore = chatService.nodes().length;

    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'a1')!,
      usecase: 'rewrite-selection',
      vars: {
        content: 'the old tower',
        directions: 'make it scary and short',
        contextMode: 'none',
        modelId: 'beta/model',
        providerId: 'prov-1'
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No chat mutation — rewrite-selection returns raw text only.
    expect(slots.text?.value).toBe('["short fix.","clearer keep.","scary restate."]');
    expect(chatService.nodes().length).toBe(nodesBefore);
    const content = firstCompletionUserContent();
    expect(content).toContain('User directions — the rewrite MUST follow these:');
    expect(content).toContain('make it scary and short');
    expect(content).toContain('Marked text to rewrite:');
    expect(content).toContain('the old tower');
    expect(content).not.toContain('Context the marked text appears in:');
    // The write model is the one chosen in the dialog.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { model: string };
    expect(body.model).toBe('beta/model');
  });

  it('current-node context: the whole node content is included', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['["a."]']));
    const chatService = await openRewriteStory();
    const runner = TestBed.inject(LlmFlowRunner);

    await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'a1')!,
      usecase: 'rewrite-selection',
      vars: { content: 'the old tower', contextMode: 'node', modelId: 'alpha/model', providerId: 'prov-1' }
    });

    const content = firstCompletionUserContent();
    expect(content).toContain('Context the marked text appears in:');
    expect(content).toContain('The hero enters the old tower. A wind howls through broken shutters.');
  });

  it('upto context: only the node text up to and including the marked part', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['["a.","b.","c."]']));
    const chatService = await openRewriteStory();
    const runner = TestBed.inject(LlmFlowRunner);

    const node = chatService.nodes().find(n => n.id === 'a1')!;
    const nodeContent = node.content ?? '';
    const selEnd = nodeContent.indexOf('the old tower') + 'the old tower'.length;

    await runner.run({
      chat: api.chats[0],
      node,
      usecase: 'rewrite-selection',
      vars: {
        content: 'the old tower',
        contextMode: 'upto',
        selectionEnd: selEnd,
        modelId: 'alpha/model',
        providerId: 'prov-1'
      }
    });

    const content = firstCompletionUserContent();
    expect(content).toContain('The hero enters the old tower');
    // The text AFTER the marked part must NOT appear in the upto context.
    expect(content).not.toContain('wind howls through broken shutters');
  });

  it('whole-text context: the entire thread up to the node is included', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['["a.","b.","c."]']));
    const chatService = await openRewriteStory();
    const runner = TestBed.inject(LlmFlowRunner);

    const node = chatService.nodes().find(n => n.id === 'q2')!;
    await runner.run({
      chat: api.chats[0],
      node,
      usecase: 'rewrite-selection',
      vars: { content: 'scary', contextMode: 'all', modelId: 'alpha/model', providerId: 'prov-1' }
    });

    const content = firstCompletionUserContent();
    expect(content).toContain('Opening direction');
    expect(content).toContain('The hero enters the old tower.');
    expect(content).toContain('Make the tower scary and short.');
    expect(content).toContain('Marked text to rewrite:');
    expect(content).toContain('scary');
  });

  it('streams chunks through onChunk so the caller can show live progress', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['["a dark ', 'tower looms.",', '"a calm shore."]']));
    const chatService = await openRewriteStory();
    const runner = TestBed.inject(LlmFlowRunner);

    const chunks: string[] = [];
    const slots = await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'a1')!,
      usecase: 'rewrite-selection',
      vars: { content: 'the old tower', contextMode: 'none', modelId: 'alpha/model', providerId: 'prov-1' }
    }, {
      onChunk: c => { if (c.content) chunks.push(c.content); }
    });

    // Chunks reach the caller as they arrive (the dialog updates the last
    // word per chunk); the final slot still holds the whole answer.
    expect(chunks.join('')).toBe('["a dark tower looms.","a calm shore."]');
    expect(slots.text?.value).toBe('["a dark tower looms.","a calm shore."]');
  });
});

describe('LLM orchestration — interpretation only when the description is NOT already stored', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function setup(): Promise<{ chatService: ChatService; factory: UsecaseContextFactory }> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' },
        { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }
      ]
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = [
      makeNode({ id: 'n1', chatId: CHAT_ID, parentId: null, role: 'user', content: 'Opening.', isCurrent: true }),
      makeNode({ id: 'a1', chatId: CHAT_ID, parentId: 'n1', role: 'assistant', content: 'Chapter.', isCurrent: true }),
      makeNode({ id: 'q1', chatId: CHAT_ID, parentId: 'a1', role: 'user', content: 'A direction', isCurrent: true, modelId: 'alpha/model', attachments: [IMG as never] })
    ];
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'beta/model' });
    const chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    return { chatService, factory: TestBed.inject(UsecaseContextFactory) };
  }

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('needsImageInterpretation: fresh images → true; after a stored record → false; new images → true', async () => {
    const { chatService, factory } = await setup();
    const q = chatService.nodes().find(n => n.id === 'q1')!;
    expect(factory.needsImageInterpretation(q, q.attachments)).toBe(true);

    // Store a matching record (as the send flow would).
    const record = factory.buildImageDescriptionRecord(q.attachments as never, 'A red ball.');
    const merged = factory.mergeDirectionWithDescription('A direction', 'A red ball.');
    await chatService.patchNode(CHAT_ID, q.id, {
      content: merged,
      attachments: [...(q.attachments ?? []), record as never]
    });
    const stored = chatService.nodes().find(n => n.id === 'q1')!;
    expect(factory.needsImageInterpretation(stored, stored.attachments)).toBe(false);

    // A DIFFERENT image set needs interpretation again.
    const other = { id: 'img2', name: 'other.png', mimeType: 'image/png', size: 4, dataUrl: 'data:image/png;base64,BBBB' };
    expect(factory.needsImageInterpretation(stored, [other as never])).toBe(true);
  });

  it('append-with-images: interprets + stores the record; a second run does NOT re-interpret', async () => {
    // Run 1: interpret (beta/model) + streamed answer.
    fetchMock.mockResolvedValueOnce(textResponse('A red ball on green grass.'));
    fetchMock.mockResolvedValueOnce(sseResponse(['The ball rolls.']));
    const { chatService } = await setup();
    const q = chatService.nodes().find(n => n.id === 'q1')!;
    const runner = TestBed.inject(LlmUseCaseRunner);

    const slots1 = await runner.run({
      chat: api.chats[0],
      node: q,
      usecase: 'append-with-images',
      vars: { content: 'A direction', attachments: q.attachments }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // interpret + answer
    // The merged content + record are exposed for the caller to persist.
    expect(slots1.interpretation?.value?.content).toContain('A red ball on green grass.');
    expect(slots1.interpretation?.value?.record.name).toBe('image-description.txt');

    // Persist exactly like chat-node does.
    const interpretation = slots1.interpretation!.value!;
    await chatService.patchNode(CHAT_ID, q.id, {
      content: interpretation.content,
      attachments: [...(q.attachments ?? []), interpretation.record as never]
    });

    // Run 2: the description is already stored → NO interpret call, just the
    // streamed answer (1 fetch).
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(sseResponse(['A second answer.']));
    const q2 = chatService.nodes().find(n => n.id === 'q1')!;
    const slots2 = await runner.run({
      chat: api.chats[0],
      node: q2,
      usecase: 'append-with-images',
      vars: { content: q2.content, attachments: q2.attachments }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // answer only — no re-interpret
    expect(slots2.interpretation).toBeUndefined(); // nothing newly merged
    expect(slots2.text?.value).toBe('A second answer.');
  });

  it('forces text modality when the interpret model can also generate images', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('A red ball on green grass.'));
    fetchMock.mockResolvedValueOnce(sseResponse(['The ball rolls.']));
    const { chatService } = await setup();
    // Mark the interpret model as ALSO image-generating → the request must
    // force text modality.
    const settings = TestBed.inject(SettingsService);
    const beta = settings.models().find(m => m.modelId === 'beta/model')!;
    beta.architecture = { input_modalities: ['image'], output_modalities: ['text', 'image'] };
    const q = chatService.nodes().find(n => n.id === 'q1')!;
    const runner = TestBed.inject(LlmUseCaseRunner);

    await runner.run({
      chat: api.chats[0],
      node: q,
      usecase: 'append-with-images',
      vars: { content: 'A direction', attachments: q.attachments }
    });

    const interpretBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(interpretBody.modalities).toEqual(['text']);
  });

  it('does not merge a placeholder when the interpret reply carries no text', async () => {
    // Image-only non-stream response: the model answered with an image, not a
    // description — the merge must be skipped, not filled with a placeholder.
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]
          }
        }]
      })
    } as unknown as Response);
    fetchMock.mockResolvedValueOnce(sseResponse(['Plain fallback answer.']));
    const { chatService } = await setup();
    // Mark the interpret model as ALSO image-generating so the text-modality
    // path is exercised; it still answers with an image → no description.
    const settings = TestBed.inject(SettingsService);
    const beta = settings.models().find(m => m.modelId === 'beta/model')!;
    beta.architecture = { input_modalities: ['image'], output_modalities: ['text', 'image'] };
    const q = chatService.nodes().find(n => n.id === 'q1')!;
    const runner = TestBed.inject(LlmUseCaseRunner);

    const slots = await runner.run({
      chat: api.chats[0],
      node: q,
      usecase: 'append-with-images',
      vars: { content: 'A direction', attachments: q.attachments }
    });

    expect(slots.interpretation).toBeUndefined();
    expect(slots.text?.value).toBe('Plain fallback answer.');
    const sendBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const finalContent = String(sendBody.messages[sendBody.messages.length - 1].content);
    expect(finalContent).toBe('A direction');
    expect(finalContent).not.toContain('(no text response)');
  });});

describe('LLM synchronization — excludeFromContext flag in the request builder', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function openChat(nodes: ReturnType<typeof makeNode>[]): Promise<ChatService> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    const now = new Date().toISOString();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' }
      ]
    });
    api.chats.push(makeChat({ id: CHAT_ID, title: 'Story', created_at: now, updated_at: now }));
    api.nodes = nodes.map(n => ({ ...n, chatId: CHAT_ID }));
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const chatService = TestBed.inject(ChatService);
    await chatService.loadChats();
    await chatService.selectChat(CHAT_ID);
    return chatService;
  }

  function textOf(messages: { role: string; content: unknown }[]): string {
    return messages.map(m => String(m.content)).join('\n');
  }

  it('skips an excludeFromContext history node but still sends the current question', async () => {
    const chatService = await openChat([
      makeNode({ id: 'meta', role: 'user', content: 'continue', isCurrent: true, excludeFromContext: true }),
      makeNode({ id: 'a1', parentId: 'meta', role: 'assistant', content: 'The door opens.', isCurrent: false }),
      makeNode({ id: 'dir', parentId: 'a1', role: 'user', content: 'Next beat.', isCurrent: true }),
      makeNode({ id: 'a2', parentId: 'dir', role: 'assistant', content: 'She steps through.', isCurrent: true })
    ]);
    const factory = TestBed.inject(UsecaseContextFactory);
    const messages = factory.buildSendMessagesEx({ chatId: CHAT_ID, nodeId: 'dir' });
    const text = textOf(messages);
    expect(text).not.toContain('continue');
    expect(text).toContain('The door opens.');
    expect(text).toContain('Next beat.');
  });

  it('inlines a text attachment on the current question into the final user message', async () => {
    const chatService = await openChat([
      makeNode({ id: 'a0', role: 'assistant', content: 'The door opens.', isCurrent: true }),
      makeNode({
        id: 'q1', parentId: 'a0', role: 'user', content: 'Summarise my notes.',
        isCurrent: true,
        attachments: [{
          id: 'att-1', name: 'notes.txt', mimeType: 'text/plain', size: 4,
          dataUrl: 'data:text/plain;charset=utf-8,The%20secret%20word%20is%20Harbour.'
        }]
      })
    ]);
    const factory = TestBed.inject(UsecaseContextFactory);
    const messages = factory.buildSendMessagesEx({ chatId: CHAT_ID, nodeId: 'q1' });
    const final = messages[messages.length - 1];
    expect(String(final.content)).toContain('Summarise my notes.');
    expect(String(final.content)).toContain('--- attached file: notes.txt (text/plain) ---');
    expect(String(final.content)).toContain('The secret word is Harbour.');
  });

  it('keeps a content override and still inlines text attachments on the current question', async () => {
    const chatService = await openChat([
      makeNode({ id: 'a0', role: 'assistant', content: 'The door opens.', isCurrent: true }),
      makeNode({
        id: 'q1', parentId: 'a0', role: 'user', content: '',
        isCurrent: true,
        attachments: [{
          id: 'att-1', name: 'notes.txt', mimeType: 'text/plain', size: 4,
          dataUrl: 'data:text/plain;charset=utf-8,The%20secret%20word%20is%20Harbour.'
        }]
      })
    ]);
    const factory = TestBed.inject(UsecaseContextFactory);
    const messages = factory.buildSendMessagesEx({
      chatId: CHAT_ID, nodeId: 'q1', contentOverride: 'Draft direction'
    });
    const final = messages[messages.length - 1];
    expect(String(final.content)).toContain('Draft direction');
    expect(String(final.content)).toContain('The secret word is Harbour.');
  });

  it('still sends an excluded node while it IS the current question (sent once then excluded)', async () => {
    const chatService = await openChat([
      makeNode({ id: 'meta', role: 'user', content: 'continue', isCurrent: true, excludeFromContext: true }),
      makeNode({ id: 'a1', parentId: 'meta', role: 'assistant', content: 'The door opens.', isCurrent: true })
    ]);
    const factory = TestBed.inject(UsecaseContextFactory);
    const messages = factory.buildSendMessagesEx({ chatId: CHAT_ID, nodeId: 'meta' });
    expect(textOf(messages)).toContain('continue');
  });

  it('includes an excludeAfterSend (one-shot lore) node until it was sent, then flips it on a real send', async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(sseResponse(['She glances at the ring.']));
    const chatService = await openChat([
      makeNode({ id: 'lore', role: 'user', content: 'Ashley is married to Dr. Harvey.', isCurrent: true, excludeAfterSend: true }),
      makeNode({ id: 'a0', parentId: 'lore', role: 'assistant', content: 'The air smells of rain.', isCurrent: false }),
      makeNode({ id: 'q1', parentId: 'a0', role: 'user', content: 'Describe the ring.', isCurrent: true })
    ]);
    const factory = TestBed.inject(UsecaseContextFactory);

    // Before the send: the lore node is part of the context (one-shot pending).
    const before = factory.buildSendMessagesEx({ chatId: CHAT_ID, nodeId: 'q1' });
    expect(textOf(before)).toContain('Ashley is married to Dr. Harvey.');

    // A real send completes → markSentOnceExcluded flips it to excludeFromContext.
    const runner = TestBed.inject(LlmFlowRunner);
    await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'q1')!,
      usecase: 'send-branch',
      vars: { content: 'Describe the ring.' }
    });
    const flipped = chatService.nodes().find(n => n.id === 'lore')!;
    expect(flipped.excludeFromContext).toBe(true);
    expect(flipped.excludeAfterSend).toBe(false);

    // After the send the lore node is documented but no longer re-shipped.
    const after = factory.buildSendMessagesEx({ chatId: CHAT_ID, nodeId: 'q1' });
    expect(textOf(after)).not.toContain('Ashley is married to Dr. Harvey.');
    vi.unstubAllGlobals();
  });

  it('buildLoreNodeContent wraps raw lore with a prefix AND a suffix', () => {
    expect(buildLoreNodeContent('Ashley is married to Dr. Harvey.')).toBe(
      '[Current chat-lore — fixed canon that must be respected and never contradicted]\nAshley is married to Dr. Harvey.\n[/End of chat-lore]'
    );
    expect(buildLoreNodeContent('   ')).toBe('');
    expect(buildLoreNodeContent(undefined)).toBe('');
  });

  it('ensureLoreNodeBefore inserts a wrapped lore node in front of the direction, sent once then deactivated; the next direction gets a fresh one', async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(sseResponse(['The ring glints.']));
    const chatService = await openChat([
      makeNode({ id: 'a0', role: 'assistant', content: 'The air smells of rain.', isCurrent: true }),
      makeNode({ id: 'd1', parentId: 'a0', role: 'user', content: 'Describe the ring.', isCurrent: true })
    ]);
    await chatService.patchChatMeta(CHAT_ID, { lore: 'Ashley is married to Dr. Harvey.' });
    const factory = TestBed.inject(UsecaseContextFactory);

    // Direction 1: a lore node is materialized IN FRONT of it (as its parent),
    // wrapped with prefix + suffix, armed as one-shot.
    await chatService.ensureLoreNodeBefore(CHAT_ID, 'd1');
    let d1 = chatService.nodes().find(n => n.id === 'd1')!;
    const lore1 = chatService.nodes().find(n => n.id === d1.parentId)!;
    expect(isChatLoreNode(lore1)).toBe(true);
    expect(lore1.excludeAfterSend).toBe(true);
    expect(lore1.excludeFromContext).toBe(false);
    expect(lore1.content).toContain('[Current chat-lore');
    expect(lore1.content).toContain('[/End of chat-lore]');
    expect(lore1.content).toContain('Ashley is married to Dr. Harvey.');

    // The lore is included in the message stream for that direction.
    expect(textOf(factory.buildSendMessagesEx({ chatId: CHAT_ID, nodeId: 'd1' })))
      .toContain('Ashley is married to Dr. Harvey.');

    // A real send of that direction completes → the lore node is deactivated.
    const runner = TestBed.inject(LlmFlowRunner);
    await runner.run({
      chat: api.chats[0],
      node: d1,
      usecase: 'send-branch',
      vars: { content: 'Describe the ring.' }
    });
    d1 = chatService.nodes().find(n => n.id === 'd1')!;
    const deactivated = chatService.nodes().find(n => n.id === d1.parentId)!;
    expect(isChatLoreNode(deactivated)).toBe(true);
    expect(deactivated.excludeFromContext).toBe(true);
    expect(deactivated.excludeAfterSend).toBe(false);

    // The deactivated lore is no longer re-shipped.
    expect(textOf(factory.buildSendMessagesEx({ chatId: CHAT_ID, nodeId: 'd1' })))
      .not.toContain('Ashley is married to Dr. Harvey.');

    // Next direction: a new draft under the fresh answer gets a NEW lore node
    // generated in front of it.
    const answer = chatService.nodes().find(n => n.role === 'assistant' && n.content === 'The ring glints.')!;
    const draft = await chatService.addNode(CHAT_ID, {
      parentId: answer.id,
      role: 'user',
      content: 'Next direction.'
    });
    await chatService.ensureLoreNodeBefore(CHAT_ID, draft.id);
    const lore2 = chatService.nodes().find(n => n.id === draft.parentId)!;
    expect(isChatLoreNode(lore2)).toBe(true);
    expect(lore2.id).not.toBe(deactivated.id);
    expect(lore2.excludeAfterSend).toBe(true);
    expect(lore2.excludeFromContext).toBe(false);
    expect(lore2.content).toContain('Ashley is married to Dr. Harvey.');
    vi.unstubAllGlobals();
  });

  function loreText(): string {
    return buildLoreNodeContent('Ashley is married to Dr. Harvey.');
  }

  /** Parse the messages of the FIRST chat-completion fetch (streaming) call. */
  function firstFetchBodyText(): string {
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string };
    const payload = JSON.parse(init?.body ?? '{}');
    const msgs = Array.isArray(payload.messages) ? payload.messages : [];
    return msgs.map((m: { role?: string; content?: unknown }) => String(m.content ?? '')).join('\n');
  }

  it('send-regenerate: clears the exclude flag of the lore node before the assistant and re-sends the lore', async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(sseResponse(['A freshly told ring.']));
    // State after the first send: L (dir/lore) → D (direction) → A (answer),
    // with L deactivated (excludeFromContext) because it was already sent once.
    const chatService = await openChat([
      makeNode({ id: 'L', role: 'user', content: loreText(), isCurrent: true, excludeFromContext: true, excludeAfterSend: false }),
      makeNode({ id: 'D', parentId: 'L', role: 'user', content: 'Describe the ring.', isCurrent: true }),
      makeNode({ id: 'A', parentId: 'D', role: 'assistant', content: 'The ring glints.', isCurrent: true })
    ]);
    await chatService.patchChatMeta(CHAT_ID, { lore: 'Ashley is married to Dr. Harvey.' });

    const runner = TestBed.inject(LlmFlowRunner);
    await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'A')!,
      usecase: 'send-regenerate',
      vars: {}
    });

    // The re-sent request carries the lore (it was re-armed before the send).
    expect(firstFetchBodyText()).toContain('Ashley is married to Dr. Harvey.');
    // After the regenerated send the lore node is deactivated again.
    const lore = chatService.nodes().find(n => n.id === 'L')!;
    expect(isChatLoreNode(lore)).toBe(true);
    expect(lore.excludeFromContext).toBe(true);
    expect(lore.excludeAfterSend).toBe(false);
    vi.unstubAllGlobals();
  });

  it('send-rewrite: clears the exclude flag of the lore node before the assistant and re-sends the lore', async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(sseResponse(['A rewritten ring.']));
    const chatService = await openChat([
      makeNode({ id: 'L', role: 'user', content: loreText(), isCurrent: true, excludeFromContext: true, excludeAfterSend: false }),
      makeNode({ id: 'D', parentId: 'L', role: 'user', content: 'Describe the ring.', isCurrent: true }),
      makeNode({ id: 'A', parentId: 'D', role: 'assistant', content: 'The ring glints.', isCurrent: true })
    ]);
    await chatService.patchChatMeta(CHAT_ID, { lore: 'Ashley is married to Dr. Harvey.' });

    const runner = TestBed.inject(LlmFlowRunner);
    await runner.run({
      chat: api.chats[0],
      node: chatService.nodes().find(n => n.id === 'A')!,
      usecase: 'send-rewrite',
      vars: {}
    });

    expect(firstFetchBodyText()).toContain('Ashley is married to Dr. Harvey.');
    const lore = chatService.nodes().find(n => n.id === 'L')!;
    expect(lore.excludeFromContext).toBe(true);
    expect(lore.excludeAfterSend).toBe(false);
    vi.unstubAllGlobals();
  });

  it('send-insert: re-arms the shared lore node of the direction being inserted above so the new direction gets the lore', async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(sseResponse(['An inserted direction answer.']));
    const chatService = await openChat([
      makeNode({ id: 'L', role: 'user', content: loreText(), isCurrent: true, excludeFromContext: true, excludeAfterSend: false }),
      makeNode({ id: 'D', parentId: 'L', role: 'user', content: 'Describe the ring.', isCurrent: true })
    ]);
    await chatService.patchChatMeta(CHAT_ID, { lore: 'Ashley is married to Dr. Harvey.' });
    const d = chatService.nodes().find(n => n.id === 'D')!;

    const runner = TestBed.inject(LlmFlowRunner);
    await runner.run({
      chat: api.chats[0],
      node: d,
      usecase: 'send-insert',
      vars: { content: 'Inserted direction.', modelId: 'alpha/model', providerId: 'prov-1' }
    });

    expect(firstFetchBodyText()).toContain('Ashley is married to Dr. Harvey.');
    const lore = chatService.nodes().find(n => n.id === 'L')!;
    expect(lore.excludeFromContext).toBe(true);
    expect(lore.excludeAfterSend).toBe(false);
    vi.unstubAllGlobals();
  });
});
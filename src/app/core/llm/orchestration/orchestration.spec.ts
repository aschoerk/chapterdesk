import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode, makeModel, makeProvider, makeAttachment } from '../../../../../test-helpers/factories';
import { SettingsService } from '../../settings/settings.service';
import { GenerationSettingsService } from '../../settings/generation-settings.service';
import { ChatService } from '../../chat/chat.service';

import {
  evaluateCompletion,
  evaluateImagesResponse,
  evaluateDescriptions,
  foldStreamChunk,
  finalizeStream,
  isContentModeration,
  moderationReason
} from './evaluators';
import { pickUsecase, LlmUseCaseRunner } from './usecases';
import { LlmOrchestratorService } from './orchestrator';
import { LlmTransportService } from './transport';
import { LlmPostprocessorService } from './postprocessor';
import { LlmLogService, type LlmLogEntry } from '../llm-log.service';
import type { EvalSlots, UsecaseVars } from './types';
import { I18nService } from '../../i18n/i18n.service';

describe('LLM orchestration — evaluators (pure, never throw)', () => {
  it('evaluates a success completion into text + thinking slots', () => {
    const slots = evaluateCompletion({
      raw: {
        choices: [{ message: { role: 'assistant', content: 'Hello world', reasoning: 'think…' } }]
      }
    });
    expect(slots.text?.status).toBe('ok');
    expect(slots.text?.value).toBe('Hello world');
    expect(slots.thinking?.value).toBe('think…');
  });

  it('evaluates an image completion into an images slot', () => {
    const slots = evaluateCompletion({
      raw: {
        choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] } }]
      }
    });
    expect(slots.images?.status).toBe('ok');
    expect(slots.images?.value).toHaveLength(1);
  });

  it('marks an empty/refused completion as refused (never throws)', () => {
    const slots = evaluateCompletion({ raw: { choices: [{ message: { refusal: 'I cannot do that' } }] } });
    expect(slots.images?.status).toBe('refused');
  });

  it('turns a transport error into a refused slot for moderation', () => {
    const err = { status: 400, text: '{"error":{"message":"Content policy violation"}}' };
    const slots = evaluateImagesResponse({ error: err });
    expect(slots.images?.status).toBe('refused');
  });

  it('turns a timeout/abort into an error slot with reason (never throws)', () => {
    const slots = evaluateCompletion({ error: { status: 0, text: '' }, aborted: true });
    expect(slots.error?.status).toBe('error');
    expect(slots.error?.value).toBe('aborted');
  });

  it('evaluates the planning pass into descriptions', () => {
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content: '{"pictures":["A castle at dawn.","A rider in the mist."]}' } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('castle');
  });

  it('splits a DOUBLE-ENCODED JSON list from the planning model', () => {
    // Some models escape the array into a STRING value instead of a real array:
    // {"pictures": "[\"desc 1\",\"desc 2\"]"}
    const inner = JSON.stringify(['A castle at dawn.', 'A rider in the mist.']);
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content: JSON.stringify({ pictures: inner }) } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('castle');
    expect(slots.descriptions?.value?.[1].text).toContain('rider');
  });

  it('splits a bare JSON array when the model drops the wrapper object', () => {
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content: JSON.stringify(['A bridge.', 'A lantern.']) } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('bridge');
  });

  it('splits a JSON object embedded in surrounding prose and keeps brackets inside descriptions intact', () => {
    const json = JSON.stringify({
      pictures: ['A sign reading "[EXIT]" above the door.', 'A lantern at dusk.']
    });
    const content = `Sure, here are the frozen frames:\n${json}\nEnjoy!`;
    const slots = evaluateDescriptions({
      raw: { choices: [{ message: { content } }] }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('[EXIT]');
    expect(slots.descriptions?.value?.[1].text).toContain('lantern');
  });

  it('splits a map keyed 0..n from the planning model', () => {
    const slots = evaluateDescriptions({
      raw: {
        choices: [{
          message: {
            content: JSON.stringify({ pictures: { '0': 'First frame.', '1': 'Second frame.' } })
          }
        }]
      }
    });
    expect(slots.descriptions?.status).toBe('ok');
    expect(slots.descriptions?.value).toHaveLength(2);
    expect(slots.descriptions?.value?.[0].text).toContain('First frame');
    expect(slots.descriptions?.value?.[1].text).toContain('Second frame');
  });

  it('returns refused descriptions when planning output is unusable', () => {
    const slots = evaluateDescriptions({ raw: { choices: [{ message: { content: '' } }] } });
    expect(slots.descriptions?.status).toBe('refused');
  });

  it('detects content moderation across provider shapes', () => {
    expect(isContentModeration('Request Moderated')).toBe(true);
    expect(moderationReason('{"error":{"message":"Content policy violation"}}')).toContain('Content');
    expect(isContentModeration('transport failure 500')).toBe(false);
  });

  describe('streaming fold + finalize (SSE reaches the node DURING)', () => {
    it('folds chunks into a partial text slot', () => {
      let running = foldStreamChunk({}, { content: 'The' });
      running = foldStreamChunk(running, { content: ' castle' });
      running = foldStreamChunk(running, { thinking: 'hmm' });
      expect(running.text?.status).toBe('partial');
      expect(running.text?.value).toBe('The castle');
      expect(running.thinking?.value).toBe('hmm');
    });

    it('finalizes a partial stream into ok on success', () => {
      const running = foldStreamChunk({}, { content: 'The answer' });
      const done = finalizeStream(running, { raw: { choices: [{ message: { role: 'assistant', content: 'The answer' } }] } });
      expect(done.text?.status).toBe('ok');
      expect(done.text?.value).toBe('The answer');
    });

    it('finalizes an aborted stream into an error slot, preserving the partial', () => {
      const running = foldStreamChunk({}, { content: 'Half' });
      const done = finalizeStream(running, { error: { status: 0, text: '' }, aborted: true });
      expect(done.error?.status).toBe('error');
      expect(done.error?.value).toBe('aborted');
      expect(done.text?.value).toBe('Half'); // partial data is never lost
    });

    it('surfaces generated images streamed back by an image-capable model', () => {
      // An image-capable text use case (e.g. append) can stream images but no
      // text — the raw carries the images so finalize surfaces them.
      const done = finalizeStream({}, {
        raw: { choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] } }] }
      });
      expect(done.text?.status).toBe('refused'); // no text, but that's fine
      expect(done.images?.status).toBe('ok');
      expect(done.images?.value).toHaveLength(1);
    });
  });
});

describe('LLM orchestration — dispatch (plain if-chain)', () => {
  it('maps dialog vars to the 5 use cases', () => {
    const v = (o: UsecaseVars) => o;
    expect(pickUsecase(v({ count: 3, planDescriptions: false }))).toBe('storyboard-direct');
    expect(pickUsecase(v({ count: 3, planDescriptions: true, singleCall: true }))).toBe('planned-enblock');
    expect(pickUsecase(v({ count: 3, purePictures: true }))).toBe('planned-enblock');
    expect(pickUsecase(v({ count: 1, purePictures: true }))).toBe('planned-enblock');
    expect(pickUsecase(v({ count: 3, planDescriptions: true }))).toBe('planned-scenes');
    expect(pickUsecase(v({ count: 1, historyMode: 'full' }))).toBe('render-full');
    expect(pickUsecase(v({ count: 1, historyMode: 'window' }))).toBe('render-window');
    expect(pickUsecase(v({ count: 1 }))).toBe('render-node');
  });
});

describe('LLM orchestration — transport fallbacks (the retries stay in transport)', () => {
  let transport: LlmTransportService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
    void TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient()]
    });
    transport = TestBed.inject(LlmTransportService);
  });

  afterEach(() => vi.unstubAllGlobals());

  function imagesResponse(count: number): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: Array.from({ length: count }).map((_, i) => ({
          b64_json: `AAA${i}`, media_type: 'image/png'
        }))
      })
    } as unknown as Response;
  }

  function errorResponse(status: number, message: string): Response {
    return {
      ok: false,
      status,
      text: async () => message
    } as unknown as Response;
  }

  const model = makeModel({ architecture: { input_modalities: [], output_modalities: ['image'] } });
  const provider = makeProvider();

  it('routes an image-only model (404 Qwen hint) to /images', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"qwen/qwen-image-3 is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.","code":404}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));

    const raw = await transport.completeImage({
      provider, model,
      messages: [{ role: 'user', content: 'Draw a castle' }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chat/completions');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/images');
    expect((raw as { data: unknown[] }).data).toHaveLength(1);
  });

  it('falls back to /images on a context-overflow error', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(
      400,
      '{"error":{"message":"This endpoint\'s maximum context length is 65536 tokens. However, you requested about 78089 tokens…"}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));
    const raw = await transport.completeImage({
      provider, model,
      messages: [{ role: 'user', content: 'Draw a castle at dusk' }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((raw as { data: unknown[] }).data).toHaveLength(1);
  });

  it('retries once without the modalities field when it is rejected', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, '{"error":{"message":"Unsupported parameter: modalities"}}'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] } }] })
    } as unknown as Response);
    const raw = await transport.completeImage({ provider, model, messages: [{ role: 'user', content: 'x' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((raw as { choices: unknown[] }).choices).toHaveLength(1);
  });

  it('keeps images streamed back in the log response and the returned raw (image-capable text use case)', async () => {
    const enc = new TextEncoder();
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const imageUrl = 'data:image/png;base64,AAAA';
    const body = frame({ choices: [{ delta: { content: 'A picture: ' } }] })
      + frame({ choices: [{ delta: { content: [{ type: 'image_url', image_url: { url: imageUrl } }] } }] })
      + 'data: [DONE]\n\n';
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'text/event-stream' },
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(enc.encode(body)); controller.close(); }
      })
    } as unknown as Response);

    const textModel = makeModel({ modelId: 'alpha/model' }); // non-image-capable → no modalities
    const logRecordSpy = vi.spyOn(TestBed.inject(LlmLogService), 'record');
    const completion = await transport.complete({
      provider, model: textModel,
      messages: [{ role: 'user', content: 'render the scene' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' }
    });

    // The assembled result + raw carry the streamed image.
    expect(completion.images).toHaveLength(1);
    expect(completion.images![0].url).toBe(imageUrl);
    const rawMsg = ((completion.raw as { choices: { message: Record<string, unknown> }[] }).choices[0].message);
    expect(rawMsg['images']).toHaveLength(1);
    // The persisted log entry's response ALSO carries the image (so the user
    // sees it on the /logs page instead of only { content, thinking }).
    const entry = logRecordSpy.mock.results[0].value as LlmLogEntry;
    const response = (entry.response as { images?: unknown[] });
    expect(response?.images).toHaveLength(1);
    logRecordSpy.mockRestore();
  });

  it('requests streamed usage and attaches it to the log entry (include_usage)', async () => {
    const enc = new TextEncoder();
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const usage = { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42, total_cost: 0.0001 };
    const body = frame({ choices: [{ delta: { content: 'Streamed ' } }] })
      + frame({ choices: [{ delta: { content: 'answer.' } }] })
      + frame({ choices: [], usage })
      + 'data: [DONE]\n\n';
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'text/event-stream' },
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(enc.encode(body)); controller.close(); }
      })
    } as unknown as Response);

    const textModel = makeModel({ modelId: 'alpha/model' });
    const logRecordSpy = vi.spyOn(TestBed.inject(LlmLogService), 'record');
    const completion = await transport.complete({
      provider, model: textModel,
      messages: [{ role: 'user', content: 'Hello' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' }
    });

    // Assembled stream text is untouched.
    expect(completion.content).toBe('Streamed answer.');

    // The request asks the provider to stream usage back.
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });

    // The final usage chunk reached the persisted log entry's response.
    const entry = logRecordSpy.mock.results[0].value as LlmLogEntry;
    expect((entry.response as { usage?: unknown }).usage).toEqual(usage);
    logRecordSpy.mockRestore();
  });

  it('handles a `stream: true` request answered with a plain JSON body as NON-stream (model cannot stream)', async () => {
    // The endpoint ignores `stream: true` and replies with the COMPLETE JSON
    // body (content-type application/json). The transport must NOT parse it
    // as SSE — that would silently drop every byte — but surface it as a
    // non-stream response whose raw carries the full text.
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Full answer.' } }] })
    } as unknown as Response);

    const result = await transport.complete({
      provider, model,
      messages: [{ role: 'user', content: 'Continue the story' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.streamed).toBe(false);
    const rawMsg = (result.raw as { choices: { message: { content: string } }[] }).choices[0].message;
    expect(rawMsg.content).toBe('Full answer.');
  });

  it('surfaces images from a NON-stream image-only JSON body (model cannot stream)', async () => {
    // A model that cannot stream answers the direction request with ONLY an
    // image in a plain JSON body — the transport must keep the images in the
    // raw so the caller can attach them to the assistant node.
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

    const result = await transport.complete({
      provider, model,
      messages: [{ role: 'user', content: 'Render the scene' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' }
    });

    expect(result.streamed).toBe(false);
    const parts = ((result.raw as { choices: { message: { content: unknown[] } }[] }).choices[0].message.content as unknown[]);
    expect(parts).toHaveLength(1);
  });

  it('retries ONCE without streaming when the provider rejects `stream: true`', async () => {
    // Some endpoints cannot stream and answer with an ERROR instead of
    // ignoring the flag — the text path must fall back to a non-stream call.
    fetchMock.mockResolvedValueOnce(errorResponse(
      400,
      '{"error":{"message":"streaming is not supported for this model."}}'
    ));
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Fallback answer.' } }] })
    } as unknown as Response);

    const result = await transport.complete({
      provider, model,
      messages: [{ role: 'user', content: 'Continue' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as { stream?: boolean };
    expect(retryBody.stream).toBe(false);
    expect(result.streamed).toBe(false);
    const rawMsg = (result.raw as { choices: { message: { content: string } }[] }).choices[0].message;
    expect(rawMsg.content).toBe('Fallback answer.');
  });

  it('routes a TEXT-path completion to /images when an image-GENERATION model rejects chat completions', async () => {
    // The "writing model" is an image model served ONLY on /images (e.g. a
    // Qwen image model). The text path (send-branch / send-rewrite / append)
    // must route to /images — the returned picture lands as `raw` with
    // streamed:false so the orchestrator evaluates it into image slots.
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"qwen/qwen-image is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead."}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));

    const result = await transport.complete({
      provider, model,
      messages: [{ role: 'user', content: 'Draw a castle' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chat/completions');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/images');
    expect(result.streamed).toBe(false);
    expect((result.raw as { data: unknown[] }).data).toHaveLength(1);
  });

  it('routes to /images even on the non-stream retry when an image model rejects chat completions', async () => {
    // First attempt stream:true is rejected as unsupported → retried with
    // stream:false → THAT also hits the images-endpoint error → routes to
    // /images. The retry goes through complete() again so it benefits from
    // the routing.
    fetchMock.mockResolvedValueOnce(errorResponse(
      400,
      '{"error":{"message":"streaming is not supported for this model."}}'
    ));
    fetchMock.mockResolvedValueOnce(errorResponse(
      404,
      '{"error":{"message":"model cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead."}}'
    ));
    fetchMock.mockResolvedValueOnce(imagesResponse(1));

    const result = await transport.complete({
      provider, model,
      messages: [{ role: 'user', content: 'Draw a castle at dusk' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/chat/completions');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/images');
    // The non-stream retry's body was a non-stream call (stream:false).
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as { stream?: boolean };
    expect(retryBody.stream).toBe(false);
    expect(result.streamed).toBe(false);
    expect((result.raw as { data: unknown[] }).data).toHaveLength(1);
  });

  it('sends modalities for an imageCapable WRITE-model completion and surfaces the 200 image (the empty-200 fix)', async () => {
    // An image-GENERATION model used as the WRITING model (send-* / append):
    // the request MUST carry `modalities` so the model actually generates —
    // without it such models answer 200 with `{content:'', thinking:''}` and
    // no picture. The 200 image body is surfaced as `streamed:false` raw so
    // the orchestrator extracts it into `slots.images`.
    const imageUrl = 'data:image/png;base64,QQ==';
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: [{ type: 'image_url', image_url: { url: imageUrl } }] } }]
      })
    } as unknown as Response);

    const imageModel = makeModel({ modelId: 'vendor/img', architecture: { input_modalities: [], output_modalities: ['image'] } });
    const result = await transport.complete({
      provider, model: imageModel,
      messages: [{ role: 'user', content: 'Render the scene' }],
      extras: { stream: true },
      chat: { id: 'c', title: 't', usecase: 'append' },
      imageCapable: true
    });

    // The request carried modalities (which output the image).
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      modalities?: string[]; stream?: boolean;
    };
    expect(sent.modalities).toEqual(['image']);
    expect(result.streamed).toBe(false);
    expect((result.raw as { choices: { message: { content: { type: string; image_url: { url: string } }[] } }[] })
      .choices[0].message.content[0].image_url.url).toBe(imageUrl);
  });
});

describe('LLM orchestration — planned-scenes pipeline (use case 3)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'img', displayName: 'Image', modelId: 'vendor/image', architecture: { input_modalities: [], output_modalities: ['image'] } },
        { id: 'txt', displayName: 'Texter', modelId: 'vendor/text' }
      ]
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
  });

  afterEach(() => vi.unstubAllGlobals());

  function textResponse(text: string): Response {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: text } }] }) } as unknown as Response;
  }
  function completionImage(n: number): Response {
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { images: Array.from({ length: n }).map((_, i) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,IMG${i}` } })) } }] })
    } as unknown as Response;
  }

  it('plans then renders ALL scenes in ONE en-block call; a batch that returns anything stops immediately (one picture or none)', async () => {
    // 1 planning + 1 scene one-shot. The batch returns just 1 picture even
    // though 2 were requested — per the "one picture or none" model the whole
    // use case STOPS here (no per-scene fallback, no reprise).
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // 2 network calls total: 1 planning + 1 en-block render.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const storyboard = slots.storyboard?.value ?? [];
    // One scene record holding the single produced image.
    expect(storyboard).toHaveLength(1);
    expect(slots.images?.value).toHaveLength(1);
    expect(storyboard[0].images).toHaveLength(1);
    // The batch prompt uses the SCENE render template (image.one-shot-scenes),
    // heads with the drawing instruction, embeds the derived scene
    // descriptions, and never carries the raw assistant chapter text
    // ('A chapter.' is the node being illustrated).
    expect(storyboard[0].prompt).toContain('Scene one-shot');
    expect(storyboard[0].prompt).toContain('Illustrate this beat');
    expect(storyboard[0].prompt).toContain('bridge');
    expect(storyboard[0].prompt).toContain('lantern');
    expect(storyboard[0].prompt).not.toContain('A chapter.');

    // Postprocess → placement plan with prompt files.
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, { chat: { id: 'chat-1' } as never, node: makeNode({ id: aid, role: 'assistant' }) as never, usecase: 'planned-scenes', vars: {} });
    expect(plan).not.toBeNull();
    expect(plan?.attachments.some(a => a.name.startsWith('illustration-'))).toBe(true);
    expect(plan?.attachments.some(a => a.name === 'prompt-1.txt')).toBe(true);
  });

  it('uses the SCENE-oriented planning prompt for planned-scenes (fewer stills, more scenes)', async () => {
    // 1 planning + 1 scene one-shot render.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // First fetch = the planning call: body carries the SCENE-oriented prompt
    // (image.planning-scenes), not the static-still template (image.planning).
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: string }[];
    };
    // The plan prompt is the LAST user message (the earlier ones are context).
    const user = [...body.messages].reverse().find(m => m.role === 'user')!.content;
    expect(user).toContain('CONCRETE SCENES');
    expect(user).toMatch(/feel ALIVE/);
    expect(user).not.toContain('frozen instant');
    // The planner is told the story scope: depict the current beat, with the
    // full story text up to it as the established context ('single' mode).
    expect(user).toContain('The full story text up to this beat is the established context');
  });

  it('tells the planning model the WINDOW scope (last N beats) when window mode is chosen', async () => {
    // 1 planning + 1 scene one-shot render.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2, historyMode: 'window', historyNodes: 4 }
    });

    // First fetch = the planning call: the prompt now names the window scope —
    // the last 4 beats up to and including the current one (NOT the full text).
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: string }[];
    };
    const user = [...body.messages].reverse().find(m => m.role === 'user')!.content;
    expect(user).toContain('last 4 story beats up to and including the current one');
    expect(user).not.toContain('The full story text up to this beat is the established context');
  });

  it('planning includes the current ChatNode as the beat to depict', async () => {
    // The node the user pressed Illustrate on must reach the planning model —
    // its text is appended as the "beat to depict" before the plan prompt.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'CURRENT BEAT TEXT.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'CURRENT BEAT TEXT.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // First fetch = the planning call: besides the plan prompt (the LAST user
    // message) the CURRENT node's text is sent as the "beat to depict".
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: string }[];
    };
    const beatMsg = body.messages
      .filter(m => m.role === 'user')
      .find(m => m.content.includes('The beat to depict is:'));
    expect(beatMsg?.content).toContain('CURRENT BEAT TEXT.');
    // The plan prompt is still the final user message.
    const user = [...body.messages].reverse().find(m => m.role === 'user')!.content;
    expect(user).toContain('CONCRETE SCENES');
  });

  it('does NOT forward reference attachments to the image model after planning', async () => {
    // The render model can also READ images — prior illustrations exist along
    // the path, but the post-planning render must still drive the image model
    // from the derived descriptions ONLY (no image_url parts / binaries).
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    // 1 planning + 1 scene one-shot render.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern."]}'));
    fetchMock.mockResolvedValueOnce(completionImage(1));

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction.' }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 2 }
    });

    // 2 network calls: 1 planning + 1 scene one-shot render.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const i of [1]) {
      const body = JSON.parse((fetchMock.mock.calls[i][1] as { body: string }).body) as {
        messages: { role: string; content: unknown }[];
      };
      const user = body.messages.find(m => m.role === 'user')!;
      // The render prompt is a PLAIN string — no image_url parts, no binaries.
      expect(typeof user.content).toBe('string');
      expect(JSON.stringify(body.messages)).not.toContain('image_url');
      expect(JSON.stringify(body.messages)).not.toContain('REFIMAGE');
    }
  });

  it('planned-scenes: when the scene one-shot returns NOTHING, the per-scene fallback + reprise behave exactly like planned-enblock (scene template)', async () => {
    // planning → 3 scene descriptions; the scene one-shot batch → 0 (moderated).
    // The per-scene fallback then renders scenes 1 + 2 individually; scene 3 is
    // refused → the reprise (2 successes) re-renders the full set.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern.","A castle."]}')); // planning
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'moderated' } }] }) } as unknown as Response
    ); // scene one-shot → 0/3
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 1
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 2
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'still nothing' } }] }) } as unknown as Response
    ); // per-scene scene 3 → refused
    fetchMock.mockResolvedValueOnce(completionImage(3)); // reprise → full consistent set

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 3 }
    });

    // 1 planning + 1 empty scene one-shot + 3 per-scene fallbacks + 1 reprise.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // The reprise reuses the SAME SCENE render template (image.one-shot-scenes)
    // as the initial batch, embeds ONLY the successful scene descriptions and
    // adapts `total` to their REAL count (2) — identical to planned-enblock's
    // reprise rule, just with the scene template.
    const repriseBody = JSON.parse((fetchMock.mock.calls[5][1] as { body: string }).body) as {
      messages: { role: string; content: string }[];
    };
    const repriseSerialized = JSON.stringify(repriseBody.messages);
    expect(repriseSerialized).not.toContain('image_url');
    expect(repriseSerialized).not.toContain('IMG');
    expect(repriseSerialized).toContain('Scene one-shot'); // the scene render template
    expect(repriseSerialized).toContain('create EXACTLY 2 pictures'); // total = successful count
    expect(repriseSerialized).not.toContain('storyboard artist'); // NOT the planning prompt
    expect(repriseSerialized).toContain('bridge'); // successful scene description
    expect(repriseSerialized).toContain('lantern'); // successful scene description
    expect(repriseSerialized).not.toContain('castle'); // never the missing one
    // The reprise re-rendered the FULL set → a single scene record with 3 images.
    expect(slots.images?.value).toHaveLength(3);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard).toHaveLength(1);
    expect(storyboard[0].images).toHaveLength(3);
    expect(storyboard[0].refused).toBe(false);
  });

  it('storyboard-direct does NOT send attachments to the image model either', async () => {
    // The render model can also READ images and the path already contains an
    // illustration attachment — but storyboard-direct must send TEXT only
    // (chat text + the one-shot prompt), never the binaries / references.
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    fetchMock.mockResolvedValueOnce(completionImage(2)); // the one storyboard render

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    const handImage = makeAttachment({
      id: 'hand', name: 'memo.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,HANDIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 5, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction with a picture.', attachments: [handImage] as never }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 5, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'storyboard-direct',
      vars: { count: 2, planDescriptions: false }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no planning, one render
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    // The chat's TEXT context is still there, but NO images reach the model.
    for (const m of body.messages) {
      expect(typeof m.content).toBe('string');
    }
    expect(serialized).toContain('A direction with a picture'); // text context kept
    expect(serialized).toContain('A chapter.'); // the current chatnode MUST be there
    expect(serialized).not.toContain('image_url');
    expect(serialized).not.toContain('REFIMAGE');
    expect(serialized).not.toContain('HANDIMAGE');
  });

  it('storyboard-direct: when the one-shot returns NOTHING, the per-scene fallback fills every picture and NO reprise runs', async () => {
    // one-shot → 0 (moderated/refused); the per-scene fallback renders scenes
    // 1 + 2 individually. After that every picture exists → no reprise.
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'moderated' } }] }) } as unknown as Response
    ); // one-shot → 0/2
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 1
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 2

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'storyboard-direct',
      vars: { count: 2, planDescriptions: false }
    });

    // 1 one-shot + 2 per-scene fallbacks. The reprise is NOT called because
    // the fallback already produced every requested picture.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(slots.images?.value).toHaveLength(2);
    const storyboard = slots.storyboard?.value ?? [];
    // Per-scene records: scene 1 (from the fallback) + scene 2 (from fallback).
    expect(storyboard).toHaveLength(2);
    expect(storyboard[0].images).toHaveLength(1);
    expect(storyboard[1].images).toHaveLength(1);
    expect(storyboard[0].refused).toBe(false);
    expect(storyboard[1].refused).toBe(false);
  });

  it('storyboard-direct: fires onImages progressively as each per-scene fallback picture is ready', async () => {
    // one-shot → 0 (moderated/refused); the per-scene fallback then renders
    // scenes 1 + 2 individually. onImages must fire after EACH scene with the
    // growing snapshot so a caller can attach pictures the moment they exist.
    const onImages = vi.fn();
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'moderated' } }] }) } as unknown as Response
    ); // one-shot → 0/2
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 1
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 2

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'storyboard-direct',
      vars: { count: 2, planDescriptions: false }
    }, { onImages });

    // 1 one-shot + 2 per-scene fallbacks; no reprise (every picture filled).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onImages).toHaveBeenCalledTimes(2);
    // First snapshot: scene 1 came back (1 image).
    const first = onImages.mock.calls[0][0] as import('./types').ImageScene[];
    expect(first).toHaveLength(1);
    expect(first[0].scene).toBe(1);
    expect(first[0].images).toHaveLength(1);
    expect(first[0].refused).toBe(false);
    // Second snapshot: scenes 1 + 2 are both ready (the snapshot grows).
    const second = onImages.mock.calls[1][0] as import('./types').ImageScene[];
    expect(second).toHaveLength(2);
    expect(second[0].scene).toBe(1);
    expect(second[1].scene).toBe(2);
    expect(second[1].images).toHaveLength(1);
    expect(second[1].refused).toBe(false);
  });

  it('storyboard-direct: a one-shot that returns every picture performs NO fallback at all', async () => {
    fetchMock.mockResolvedValueOnce(completionImage(2)); // one-shot → 2/2

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'storyboard-direct',
      vars: { count: 2, planDescriptions: false }
    });

    // A single one-shot call — no per-scene fallback, no reprise.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slots.images?.value).toHaveLength(2);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard).toHaveLength(1);
    expect(storyboard[0].images).toHaveLength(2);
    expect(storyboard[0].refused).toBe(false);
  });

  it('planned-enblock: reprise embeds ONLY the successful descriptions and adapts total to their count; skipped when ≤1 success', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern.","A castle."]}')); // planning → 3 descriptions
    // one-shot batch → 0 (moderated) → the per-scene fallback renders each
    // scene individually: scenes 1+2 succeed, scene 3 is refused → reprise.
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'moderated' } }] }) } as unknown as Response
    ); // one-shot → 0/3
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 1
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 2
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'still nothing' } }] }) } as unknown as Response
    ); // per-scene scene 3 → refused
    fetchMock.mockResolvedValueOnce(completionImage(3)); // reprise → full consistent set

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-enblock',
      vars: { count: 3, singleCall: true, planDescriptions: true }
    });

    // 1 planning + 1 empty one-shot + 3 per-scene fallbacks + 1 reprise.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // The one-shot + per-scene render requests (indices 1..4 — index 0 is the
    // PLANNING call which now deliberately carries the current beat text) must
    // NOT carry the raw assistant chapter text ('A chapter.' = the node being
    // illustrated); the descriptions drive the scenes.
    for (const i of [1, 2, 3, 4]) {
      const body = JSON.parse((fetchMock.mock.calls[i][1] as { body: string }).body) as {
        messages: { role: string; content: unknown }[];
      };
      expect(JSON.stringify(body.messages)).not.toContain('A chapter.');
    }
    // The reprise uses the SAME DEFAULT render prompt (image.one-shot) as the
    // initial batch — NOT the planning prompt — embeds ONLY the SUCCESSFUL
    // descriptions ('bridge' + 'lantern') and adapts `total` to their REAL
    // count (2), NOT the full 3.
    const repriseBody = JSON.parse((fetchMock.mock.calls[5][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const repriseSerialized = JSON.stringify(repriseBody.messages);
    expect(repriseSerialized).not.toContain('image_url');
    expect(repriseSerialized).not.toContain('IMG');
    expect(repriseSerialized).toContain('create EXACTLY 2 pictures'); // total = successful count
    expect(repriseSerialized).not.toContain('storyboard artist'); // NOT the planning prompt
    expect(repriseSerialized).toContain('bridge'); // successful description
    expect(repriseSerialized).toContain('lantern'); // successful description
    expect(repriseSerialized).not.toContain('castle'); // never the missing/failed one
    // The reprise re-rendered the FULL set → a single scene record with 3 images.
    expect(slots.images?.value).toHaveLength(3);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard).toHaveLength(1);
    expect(storyboard[0].images).toHaveLength(3);
    expect(storyboard[0].refused).toBe(false);
  });

  it('planned-enblock: NO reprise runs when only ONE picture succeeded', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern.","A castle."]}')); // planning → 3 descriptions
    // one-shot batch → 0 (moderated) → per-scene fallback: scene 1 succeeds,
    // scenes 2 + 3 are refused → only ONE success → no reprise.
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'moderated' } }] }) } as unknown as Response
    ); // one-shot → 0/3
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 1 (success)
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'no' } }] }) } as unknown as Response
    ); // per-scene scene 2 → refused
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'no' } }] }) } as unknown as Response
    ); // per-scene scene 3 → refused

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-enblock',
      vars: { count: 3, singleCall: true, planDescriptions: true }
    });

    // 1 planning + 1 empty one-shot + 3 per-scene fallbacks — NO reprise (≤1 success).
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const storyboard = slots.storyboard?.value ?? [];
    // Only the single success survives; the rest stay refused.
    expect(slots.images?.value).toHaveLength(1);
    expect(storyboard.filter(s => s.refused)).toHaveLength(2);
  });

  it('ATTACHES the fallback + reprise images to the chapter via the postprocessor', async () => {
    // planning → 3 descriptions; the one-shot batch returns 0 (moderated);
    // the per-scene fallback renders scenes 1+2, scene 3 is refused; the
    // reprise (2 successes) returns the full set.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern.","A castle."]}')); // planning
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'moderated' } }] }) } as unknown as Response
    ); // one-shot → 0/3
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 1
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 2
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'still nothing' } }] }) } as unknown as Response
    ); // per-scene scene 3 → refused
    fetchMock.mockResolvedValueOnce(completionImage(3)); // reprise → full consistent set

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const cx = {
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-enblock',
      vars: { count: 3, singleCall: true, planDescriptions: true }
    } as never;
    const slots = await runner.run(cx);

    // The postprocessor must attach ALL images the fallback + reprise produced
    // (scene records carry the images → buildIllustrationAttachments).
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, cx);
    expect(plan).not.toBeNull();
    expect(plan!.summary.imagesTotal).toBe(3);
    const illustrations = (plan!.attachments || []).filter(a => a.name.startsWith('illustration-'));
    expect(illustrations).toHaveLength(3);
  });

  it('render-full does NOT send attachments to the image model either', async () => {
    // Full-chat context: the render model can read images and the path carries
    // both a prior illustration and a hand-attached image — but render-full
    // must forward the chat TEXT only (context + anchor), never binaries.
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    fetchMock.mockResolvedValueOnce(completionImage(1)); // the single render

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    const handImage = makeAttachment({
      id: 'hand', name: 'memo.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,HANDIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction with a picture.', attachments: [handImage] as never }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'render-full',
      vars: { count: 1, historyMode: 'full' }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    // The chat's TEXT context survives, but no image payload reaches the model.
    for (const m of body.messages) {
      expect(typeof m.content).toBe('string');
    }
    expect(serialized).toContain('A direction with a picture'); // text context kept
    expect(serialized).toContain('A chapter.'); // the anchor
    expect(serialized).not.toContain('image_url');
    expect(serialized).not.toContain('REFIMAGE');
    expect(serialized).not.toContain('HANDIMAGE');
  });

  it('render-window counts beats in ASSISTANT nodes only and keeps the current chapter', async () => {
    // A window of 3 beats INCLUDING the current chapter → the image model
    // sees the last 2 ASSISTANT chapters before the anchor (C2, C3) plus the
    // current CH chapter as the anchor — the D1/C1 beat (too old) never
    // counts, and user directions travel with their chapter but don't count.
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    fetchMock.mockResolvedValueOnce(completionImage(1)); // the single render

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 8, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'D1' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'C1' }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'D2' }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'C2' }),
      makeNode({ id: 'u2', chatId: 'chat-1', parentId: 'a1', role: 'user', content: 'D3' }),
      makeNode({ id: 'a2', chatId: 'chat-1', parentId: 'u2', role: 'assistant', content: 'C3' }),
      makeNode({ id: 'u3', chatId: 'chat-1', parentId: 'a2', role: 'user', content: 'D4' }),
      makeNode({ id: 'a3', chatId: 'chat-1', parentId: 'u3', role: 'assistant', content: 'CH', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');
    chatService.setActiveChild('a1', 'u2');
    chatService.setActiveChild('u2', 'a2');
    chatService.setActiveChild('a2', 'u3');
    chatService.setActiveChild('u3', 'a3');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 8, created_at: now, updated_at: now },
      node: makeNode({ id: 'a3', chatId: 'chat-1', parentId: 'u3', role: 'assistant', content: 'CH', isCurrent: true }),
      usecase: 'render-window',
      vars: { count: 1, historyMode: 'window', historyNodes: 3 }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    for (const m of body.messages) {
      expect(typeof m.content).toBe('string');
    }
    // The window (C2/D3/C3/D4) and the current anchor (CH) survive…
    expect(serialized).toContain('C2');
    expect(serialized).toContain('D3');
    expect(serialized).toContain('C3');
    expect(serialized).toContain('D4');
    expect(serialized).toContain('CH');
    // …but the too-old D1/C1 beat is NOT sent.
    expect(serialized).not.toContain('D1');
    expect(serialized).not.toContain('C1');
  });

  it('render-node does NOT send attachments to the image model either', async () => {
    // Current-node only, but the render model can read images and the path
    // carries an illustration + a hand-attached image — the render must still
    // send ONLY the anchor text prompt (no reference/attachment images).
    api.models = [
      makeModel({
        id: 'img', displayName: 'Image', modelId: 'vendor/image',
        architecture: { input_modalities: ['image'], output_modalities: ['image'] }
      }),
      makeModel({ id: 'txt', displayName: 'Texter', modelId: 'vendor/text' })
    ];
    fetchMock.mockResolvedValueOnce(completionImage(1)); // the single render

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const now = new Date().toISOString();
    const priorImage = makeAttachment({
      id: 'img0', name: 'illustration-0.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    const handImage = makeAttachment({
      id: 'hand', name: 'memo.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,HANDIMAGE'
    });
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', content: 'Prior direction.' }),
      makeNode({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', content: 'Prior chapter.', attachments: [priorImage] as never }),
      makeNode({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', content: 'A direction with a picture.', attachments: [handImage] as never }),
      makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    chatService.setActiveChild(null, 'u0');
    chatService.setActiveChild('u0', 'a0');
    chatService.setActiveChild('a0', 'u1');
    chatService.setActiveChild('u1', 'a1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 4, created_at: now, updated_at: now },
      node: makeNode({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'render-node',
      vars: { count: 1 }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    for (const m of body.messages) {
      expect(typeof m.content).toBe('string');
    }
    expect(serialized).toContain('A chapter.'); // the anchor prompt text
    expect(serialized).not.toContain('image_url');
    expect(serialized).not.toContain('REFIMAGE');
    expect(serialized).not.toContain('HANDIMAGE');
  });

  it('keeps previously collected images when one scene is refused (partial survival)', async () => {
    // The scene one-shot batch → 0 (moderated); the per-scene fallback renders
    // scenes 1+2, scene 3 is refused → with 2 successes (>1) the unifying
    // reprise runs with those 2 successful descriptions and total = 2. It is
    // refused too → partial result kept.
    fetchMock.mockResolvedValueOnce(textResponse('{"pictures":["A bridge.","A lantern.","A castle."]}'));
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'moderated' } }] }) } as unknown as Response
    ); // scene one-shot → 0/3
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 1
    fetchMock.mockResolvedValueOnce(completionImage(1)); // per-scene scene 2
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'I cannot draw that' } }] }) } as unknown as Response
    ); // per-scene scene 3 → refused
    // Unifying reprise — refused again, so the per-scene collection is kept.
    fetchMock.mockResolvedValueOnce(
      { ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'still nothing' } }] }) } as unknown as Response
    );

    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });
    generation.update('image-interpret', { providerId: 'prov-1', modelId: 'vendor/text' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'planned-scenes',
      vars: { count: 3 }
    });

    // 1 planning + 1 empty scene one-shot + 3 per-scene fallbacks + 1 reprise.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const repriseBody = JSON.parse((fetchMock.mock.calls[5][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    const repriseSerialized = JSON.stringify(repriseBody.messages);
    // The reprise uses the SCENE one-shot template with ONLY the successful
    // descriptions ('bridge' + 'lantern'), total adapted to their count (2),
    // NOT the missing 'castle', and no image URLs.
    expect(repriseSerialized).not.toContain('image_url');
    expect(repriseSerialized).not.toContain('IMG');
    expect(repriseSerialized).toContain('create EXACTLY 2 pictures'); // total = successful count
    expect(repriseSerialized).toContain('bridge');
    expect(repriseSerialized).toContain('lantern');
    expect(repriseSerialized).not.toContain('castle'); // never the missing/failed one
    // The reprise is refused again → scenes 1+2 collected, scene 3 refused.
    expect(slots.images?.value).toHaveLength(2);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard[0].refused).toBe(false);
    expect(storyboard[1].refused).toBe(false);
    expect(storyboard[2].refused).toBe(true);
    // The refused prompt stays findable via the postprocessor.
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, { chat: { id: 'chat-1' } as never, node: makeNode({ id: aid, role: 'assistant' }) as never, usecase: 'planned-scenes', vars: {} });
    expect(plan?.attachments.some(a => a.name === 'refused-prompt-3.txt')).toBe(true);
    expect(plan?.summary.partial).toBe(true);
  });
});

describe('LLM orchestration — image-generation (explicit single picture)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'img', displayName: 'Image', modelId: 'vendor/image', architecture: { input_modalities: [], output_modalities: ['image'] } }
      ]
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('renders ONE picture from vars.promptText, no storytelling planning', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,IMG0' } }] } }] })
    } as unknown as Response);

    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), { provide: CHAT_API, useValue: api }]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'Raw direction full of prose.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'Chapter full of prose.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');

    const runner = TestBed.inject(LlmUseCaseRunner);
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'Chapter full of prose.', isCurrent: true }),
      usecase: 'image-generation',
      vars: { promptText: 'Assistant:\nA softer scene, lit by torchlight', count: 1 }
    });

    // Exactly one image-generation call — no planning pass.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard).toHaveLength(1);
    expect(slots.images?.value).toHaveLength(1);
    // The scene = drawing instruction + the EXPLICIT promptText (the node's
    // saved content must NOT leak into the scene).
    const prompt = storyboard[0].prompt;
    expect(prompt).toContain('Illustrate this beat');
    expect(prompt).toContain('A softer scene, lit by torchlight');
    expect(prompt).not.toContain('Chapter full of prose');
    expect(storyboard[0].refused).toBe(false);

    // Postprocess → illustration-1 + prompt-1 records.
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, { chat: { id: 'chat-1' } as never, node: makeNode({ id: aid, role: 'assistant' }) as never, usecase: 'image-generation', vars: {} });
    expect(plan).not.toBeNull();
    expect(plan?.attachments.some(a => a.name === 'illustration-1.png')).toBe(true);
    expect(plan?.attachments.some(a => a.name === 'prompt-1.txt')).toBe(true);
  });
});

describe('LLM orchestration — image-send (create image from text, occasional reference images)', () => {
  let api: InMemoryChatApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'img', displayName: 'Image', modelId: 'vendor/image', architecture: { input_modalities: [], output_modalities: ['image'] } }
      ]
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
  });

  afterEach(() => vi.unstubAllGlobals());

  function completionImage(n: number): Response {
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { images: Array.from({ length: n }).map((_, i) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,IMG${i}` } })) } }] })
    } as unknown as Response;
  }

  async function setup() {
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    const generation = TestBed.inject(GenerationSettingsService);
    generation.update('image-create', { providerId: 'prov-1', modelId: 'vendor/image' });

    const chatService = TestBed.inject(ChatService);
    const uid = 'u1';
    const aid = 'a1';
    const now = new Date().toISOString();
    api.chats.push({ id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now });
    api.nodes = [
      makeNode({ id: uid, chatId: 'chat-1', parentId: null, role: 'user', content: 'A direction.' }),
      makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true })
    ];
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    return { aid, uid, now, runner: TestBed.inject(LlmUseCaseRunner) };
  }

  it('sends the combined constant + marked text AS-IS (no drawing instruction, no refs)', async () => {
    fetchMock.mockResolvedValueOnce(completionImage(1));
    const { aid, uid, now, runner } = await setup();

    const prompt = 'noir ink drawing\n\nthe hero climbs the tower';
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'image-send',
      vars: { promptText: prompt, count: 1 }
    });

    // Exactly one image-model call — no planning, no drawing-instruction
    // template prepended. The message content is the EXACT user text.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { role: string; content: unknown }[];
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe(prompt);
    expect(JSON.stringify(body)).not.toContain('image_url'); // no refs → text only

    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard).toHaveLength(1);
    expect(storyboard[0].prompt).toBe(prompt);
    expect(storyboard[0].prompt).not.toContain('Illustrate this beat');
    expect(storyboard[0].refused).toBe(false);
    expect(slots.images?.value).toHaveLength(1);

    // The model used in the fetch body is the settings image-create default.
    const mbody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { model: string };
    expect(mbody.model).toBe('vendor/image');

    // Postprocess → illustration-1 + prompt-1 records.
    const post = TestBed.inject(LlmPostprocessorService);
    const plan = post.plan(slots, { chat: { id: 'chat-1' } as never, node: makeNode({ id: aid, role: 'assistant' }) as never, usecase: 'image-send', vars: {} });
    expect(plan).not.toBeNull();
    expect(plan?.attachments.some(a => a.name === 'illustration-1.png')).toBe(true);
    expect(plan?.attachments.some(a => a.name === 'prompt-1.txt')).toBe(true);
  });

  it('an explicit modelId in vars wins over the settings image-create default', async () => {
    // Add a second image-capable model on the same provider.
    api.models.push(makeModel({
      id: 'img2', displayName: 'Image 2', modelId: 'vendor/image2',
      providerId: 'prov-1', architecture: { input_modalities: [], output_modalities: ['image'] }
    }));
    fetchMock.mockResolvedValueOnce(completionImage(1));
    const { aid, uid, now, runner } = await setup();

    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'image-send',
      vars: { promptText: 'x', count: 1, modelId: 'vendor/image2', providerId: 'prov-1' }
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { model: string };
    expect(body.model).toBe('vendor/image2');
  });

  it('a stale/missing providerId must NOT silently drop the chosen model for the settings default', async () => {
    // The user chose vendor/image2, but the remembered providerId no longer
    // exists (provider renamed/removed). The chosen model must STILL be used
    // (with its own provider), never replaced by the image-create default.
    api.models.push(makeModel({
      id: 'img2', displayName: 'Image 2', modelId: 'vendor/image2',
      providerId: 'prov-1', architecture: { input_modalities: [], output_modalities: ['image'] }
    }));
    fetchMock.mockResolvedValueOnce(completionImage(1));
    const { aid, uid, now, runner } = await setup();

    await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'image-send',
      vars: { promptText: 'x', count: 1, modelId: 'vendor/image2', providerId: 'no-such-provider' }
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { model: string };
    expect(body.model).toBe('vendor/image2');
  });

  it('forwards reference images as image_url parts when attached', async () => {
    fetchMock.mockResolvedValueOnce(completionImage(1));
    const { aid, uid, now, runner } = await setup();

    const ref = makeAttachment({
      id: 'ref1', name: 'memo.png', mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,REFIMAGE'
    });
    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'image-send',
      vars: { promptText: 'make a variant of this', count: 1, attachments: [ref] as never }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      messages: { content: unknown }[];
    };
    const serialized = JSON.stringify(body.messages);
    expect(serialized).toContain('image_url');
    expect(serialized).toContain('REFIMAGE');
    expect(serialized).toContain('make a variant of this');

    expect(slots.images?.value).toHaveLength(1);
  });

  it('turns a moderation refusal into a refused scene with the reason', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { refusal: 'I cannot draw that' } }] })
    } as unknown as Response);
    const { aid, uid, now, runner } = await setup();

    const slots = await runner.run({
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 2, created_at: now, updated_at: now },
      node: makeNode({ id: aid, chatId: 'chat-1', parentId: uid, role: 'assistant', content: 'A chapter.', isCurrent: true }),
      usecase: 'image-send',
      vars: { promptText: 'something the model refuses', count: 1 }
    });

    const storyboard = slots.storyboard?.value ?? [];
    expect(storyboard[0].refused).toBe(true);
    expect((storyboard[0].content ?? '').toLowerCase()).toContain('cannot draw');
    expect(slots.images?.status).toBe('refused');
    expect(slots.images?.value).toBeNull();
  });
});

describe('LLM orchestration — orchestrator does not throw (error → slots)', () => {
  let orch: LlmOrchestratorService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.resetTestingModule();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('turns a network failure into refused image slots', async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient()]
    }).compileComponents();
    orch = TestBed.inject(LlmOrchestratorService);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response);

    const model = makeModel({ architecture: { input_modalities: [], output_modalities: ['image'] } });
    const provider = makeProvider();
    const slots = await orch.completeImage(
      { chat: { id: 'c', title: 't' } as never },
      { model, provider, messages: [{ role: 'user', content: 'x' }] },
      { expect: 'images' }
    );
    expect(slots.images?.status).toBe('refused');
    expect((slots.images as unknown as { reason?: string }).reason).toContain('boom');
  });
});
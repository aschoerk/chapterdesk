import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ProviderConfig } from '../models/chat-config';
import { CHAT_API } from '../api/chat-api.token';
import { SettingsService } from './settings.service';
import { InMemoryChatApi } from '../../../test-helpers/in-memory-chat-api';

describe('SettingsService.fetchModels', () => {
  let settings: SettingsService;
  let api: InMemoryChatApi;
  let http: HttpTestingController;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    settings = TestBed.inject(SettingsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  async function addOpenRouterProvider(): Promise<ProviderConfig> {
    return settings.addProvider({
      name: 'OpenRouter',
      type: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test-1234',
      enabled: true
    });
  }

  /** Flush the pending proxied request and let the awaited continuation run,
   *  so the next request (if any) is issued before the next expectOne. */
  async function flushAndNext(urlPart: string, body: unknown, error?: { status: number; statusText: string }) {
    const req = http.expectOne(r => r.url.endsWith(urlPart));
    if (error) {
      req.flush({}, { status: error.status, statusText: error.statusText });
    } else {
      req.flush(body as any);
    }
    await new Promise(r => setTimeout(r, 0));
  }

  it('merges the OpenRouter image catalog so image-only models are fetched', async () => {
    const provider = await addOpenRouterProvider();

    const fetchPromise = settings.fetchModels(provider);

    await flushAndNext('/proxy/models', {
      data: [
        {
          id: 'openai/gpt-4o-mini',
          name: 'OpenAI: GPT-4o mini',
          architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] }
        }
      ]
    });
    await flushAndNext('/proxy/images/models', {
      data: [
        {
          id: 'x-ai/grok-imagine-image-2.0',
          name: 'xAI: Grok Imagine Image 2.0',
          description: 'Image generation model',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] }
        }
      ]
    });

    await fetchPromise;

    const models = settings.models();
    const image = models.find(m => m.modelId === 'x-ai/grok-imagine-image-2.0');
    expect(image).toBeTruthy();
    expect(image?.providerId).toBe(provider.id);
    expect(image?.architecture?.output_modalities).toContain('image');
    // Newly fetched models are added disabled so the user can enable them explicitly.
    expect(image?.enabled).toBe(false);
    expect(models.some(m => m.modelId === 'openai/gpt-4o-mini')).toBe(true);
  });

  it('prefers the chat catalog entry when a model exists in both', async () => {
    await addOpenRouterProvider();

    const fetchPromise = settings.fetchModels(
      settings.providers().find(p => p.type === 'openrouter')!
    );

    await flushAndNext('/proxy/models', {
      data: [
        {
          id: 'x-ai/grok-4.7',
          name: 'xAI: Grok 4.7',
          architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
          top_provider: { context_length: 131072, max_completion_tokens: 128000, is_moderated: true }
        }
      ]
    });
    await flushAndNext('/proxy/images/models', {
      data: [
        {
          id: 'x-ai/grok-4.7',
          name: 'xAI: Grok 4.7 (image)',
          architecture: { input_modalities: ['image'], output_modalities: ['image'] }
        }
      ]
    });

    await fetchPromise;

    const model = settings.models().find(m => m.modelId === 'x-ai/grok-4.7');
    // Richer chat entry (name + text architecture) wins over the image entry.
    expect(model?.displayName).toBe('xAI: Grok 4.7');
    expect(model?.architecture?.input_modalities).toEqual(['text']);
    expect(model?.architecture?.output_modalities).toEqual(['text']);
  });

  it('does not query an image catalog for non-OpenRouter providers', async () => {
    const provider = await settings.addProvider({
      name: 'Local',
      type: 'custom',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'abc-1234',
      enabled: true
    });

    const fetchPromise = settings.fetchModels(provider);

    await flushAndNext('/proxy/models', {
      data: [{ id: 'llama3', name: 'Llama 3' }]
    });

    await fetchPromise;

    expect(settings.models().some(m => m.modelId === 'llama3')).toBe(true);
  });

  it('tolerates a missing image catalog (404) for OpenRouter', async () => {
    await addOpenRouterProvider();

    const fetchPromise = settings.fetchModels(
      settings.providers().find(p => p.type === 'openrouter')!
    );

    await flushAndNext('/proxy/models', {
      data: [{ id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini' }]
    });
    await flushAndNext('/proxy/images/models', {}, { status: 404, statusText: 'Not Found' });

    await fetchPromise;

    expect(settings.models().some(m => m.modelId === 'openai/gpt-4o-mini')).toBe(true);
  });

  it('discovers Gemini modalities + context + local pricing via x-goog-api-key', async () => {
    const provider = await settings.addProvider({
      name: 'Google',
      type: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIza-1234567890',
      enabled: true
    });

    const fetchPromise = settings.fetchModels(provider);

    // Gemini uses the key header, not Bearer, and must NOT hit /images/models.
    const req = http.expectOne(r => r.url.endsWith('/proxy/models'));
    expect(req.request.headers.get('x-goog-api-key')).toBe('AIza-1234567890');
    expect(req.request.headers.get('x-target-base')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(req.request.headers.get('Authorization')).toBeNull();
    req.flush({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          description: 'Fast multimodal model',
          inputTokenLimit: 1048576,
          supportedGenerationMethods: ['generateContent', 'generateImages'],
          inputModalities: ['TEXT', 'IMAGE'],
          outputModalities: ['TEXT', 'IMAGE']
        },
        {
          name: 'models/gemini-1.0-pro',
          displayName: 'Gemini 1.0 Pro',
          inputTokenLimit: 30720,
          supportedGenerationMethods: ['generateContent'],
          inputModalities: ['TEXT'],
          outputModalities: ['TEXT']
        }
      ]
    });

    await fetchPromise;

    const models = settings.models();
    const flash = models.find(m => m.modelId === 'gemini-2.5-flash');
    expect(flash).toBeTruthy();
    expect(flash?.providerId).toBe(provider.id);
    expect(flash?.displayName).toBe('Gemini 2.5 Flash');
    expect(flash?.contextLength).toBe(1048576);
    expect(flash?.architecture?.input_modalities).toEqual(['text', 'image']);
    expect(flash?.architecture?.output_modalities).toEqual(['text', 'image']);
    expect(flash?.enabled).toBe(false);
    // Not a pricing-bearing catalog → falls back to the local Gemini table.
    expect(flash?.pricing?.prompt).toBe('0.0000003'); // $0.30 / 1M
    expect(flash?.pricing?.completion).toBe('0.0000025'); // $2.50 / 1M
    expect(Number(flash?.pricing?.prompt) * 1_000_000).toBeCloseTo(0.30, 6);

    // The text-only sibling keeps text modalities (no image).
    const pro = models.find(m => m.modelId === 'gemini-1.0-pro');
    expect(pro?.architecture?.input_modalities).toEqual(['text']);
    expect(pro?.architecture?.output_modalities).toEqual(['text']);
  });

  it('discovers Anthropic models (display_name) via x-api-key + anthropic-version', async () => {
    const provider = await settings.addProvider({
      name: 'Anthropic',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-1234',
      enabled: true
    });

    const fetchPromise = settings.fetchModels(provider);

    const req = http.expectOne(r => r.url.endsWith('/proxy/models'));
    expect(req.request.headers.get('x-api-key')).toBe('sk-ant-1234');
    expect(req.request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(req.request.headers.get('Authorization')).toBeNull();
    req.flush({
      data: [
        { id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', created_at: 1710000000 }
      ]
    });

    await fetchPromise;

    const model = settings.models().find(m => m.modelId === 'claude-sonnet-4');
    expect(model).toBeTruthy();
    expect(model?.displayName).toBe('Claude Sonnet 4');
    // Anthropic models carry no modalities in the catalog.
    expect(model?.architecture).toBeUndefined();
    // Pricing falls back to the local table.
    expect(Number(model?.pricing?.prompt) * 1_000_000).toBeCloseTo(3.0, 6);
  });

  it('normalizes an AI Studio console URL to the Gemini API when saving', async () => {
    const provider = await settings.addProvider({
      name: 'Google',
      type: 'gemini',
      baseUrl: 'https://aistudio.google.com/v1beta',
      apiKey: 'AIza-saved-key',
      enabled: true
    });

    expect(provider.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(settings.providers().find(p => p.id === provider.id)?.baseUrl)
      .toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('sends the normalized Gemini API URL even when the stored base URL is the AI Studio console', async () => {
    const provider = await settings.addProvider({
      name: 'Google',
      type: 'gemini',
      baseUrl: 'https://aistudio.google.com',
      apiKey: 'AIza-normalize-on-request',
      enabled: true
    });

    const pending = settings.testProvider(provider);
    const req = http.expectOne(r => r.url.endsWith('/proxy/models'));
    expect(req.request.headers.get('x-target-base'))
      .toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(req.request.headers.get('x-goog-api-key')).toBe('AIza-normalize-on-request');
    req.flush({ models: [] });
    await pending;
  });

  it('keeps a versioned generic URL and fixes an unversioned one', async () => {
    const g1 = await settings.addProvider({
      name: 'Google',
      type: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1',
      apiKey: 'k',
      enabled: true
    });
    expect(g1.baseUrl).toBe('https://generativelanguage.googleapis.com/v1');

    const g2 = await settings.addProvider({
      name: 'Google',
      type: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'k',
      enabled: true
    });
    expect(g2.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('upgrades a legacy custom provider with an AI Studio URL to gemini on load', async () => {
    // Simulate a provider saved before the gemini kind existed.
    api.providers.push({
      id: 'legacy-1',
      name: 'Google (old)',
      type: 'custom',
      baseUrl: 'https://aistudio.google.com/v1beta',
      apiKey: 'AIza-legacy',
      enabled: true
    });
    await settings.loadAll();

    const p = settings.providers().find(x => x.id === 'legacy-1');
    expect(p?.type).toBe('gemini');
    expect(p?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    // Persisted to the backend store too (so x-provider-id uses the right kind).
    expect(api.providers.find(x => x.id === 'legacy-1')?.type).toBe('gemini');
    expect(api.providers.find(x => x.id === 'legacy-1')?.baseUrl)
      .toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('saving a custom provider with a Google URL stores it as gemini', async () => {
    const p = await settings.addProvider({
      name: 'Google',
      type: 'custom',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIza-x',
      enabled: true
    });
    expect(p.type).toBe('gemini');
  });

  it('sends x-goog-api-key even when the provider record is not typed gemini but the URL is Google', async () => {
    // Defensive path: a record that loadAll has not yet upgraded.
    const raw: ProviderConfig = {
      id: 'not-upgraded',
      name: 'Google',
      type: 'custom',
      baseUrl: 'https://aistudio.google.com',
      apiKey: 'AIza-defensive',
      enabled: true
    };
    const pending = settings.testProvider(raw);
    const req = http.expectOne(r => r.url.endsWith('/proxy/models'));
    expect(req.request.headers.get('x-goog-api-key')).toBe('AIza-defensive');
    expect(req.request.headers.get('Authorization')).toBeNull();
    expect(req.request.headers.get('x-target-base'))
      .toBe('https://generativelanguage.googleapis.com/v1beta');
    req.flush({ models: [] });
    await pending;
  });
});
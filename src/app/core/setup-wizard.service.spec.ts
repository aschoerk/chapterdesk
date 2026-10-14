import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../api/chat-api.token';
import { InMemoryChatApi } from '../../../test-helpers/in-memory-chat-api';
import { makeModel, makeProvider, seedApi } from '../../../test-helpers/factories';
import { SetupWizardService } from './setup-wizard.service';
import { SettingsService } from './settings.service';
import { GenerationSettingsService } from './generation-settings.service';
import { DemoDataService } from './demo-data/demo-data.service';

describe('SetupWizardService', () => {
  let api: InMemoryChatApi;
  let service: SetupWizardService;
  let settings: SettingsService;
  let generation: GenerationSettingsService;
  let demoData: DemoDataService;

  beforeEach(() => {
    localStorage.removeItem('chat.demoData.loadedV1');
    api = new InMemoryChatApi();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    });
    service = TestBed.inject(SetupWizardService);
    settings = TestBed.inject(SettingsService);
    generation = TestBed.inject(GenerationSettingsService);
    demoData = TestBed.inject(DemoDataService);
  });

  afterEach(() => {
    localStorage.removeItem('chat.demoData.loadedV1');
  });

  it('opens on the welcome step and resolves "skipped" via skip()', async () => {
    const promise = service.open();
    expect(service.current()?.step).toBe('welcome');
    expect(service.settingsHasProvider()).toBe(false);

    service.skip();

    expect(await promise).toBe('skipped');
    expect(service.current()).toBeNull();
  });

  it('saveProviderAndFetch adds a fresh provider and advances to the models step', async () => {
    const fetchSpy = vi.spyOn(settings, 'fetchModels').mockImplementation(async provider => {
      await api.createModel({
        displayName: 'Claude X',
        modelId: 'claude-x',
        providerId: provider.id,
        type: 'fetched',
        enabled: false,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }
      });
      await settings.loadAll();
    });

    const promise = service.open();
    service.patch({ apiKey: 'sk-test-1234567890' });
    await service.saveProviderAndFetch();

    const state = service.current()!;
    expect(state.step).toBe('models');
    expect(state.providerSavedId).toBeTruthy();
    expect(state.providerId).toBe(state.providerSavedId);
    expect(settings.providers().length).toBe(1);
    // the freshly created model is listed and, not being enabled, no default
    // writing model is preselected
    expect(state.models.length).toBe(1);
    expect(state.models[0].modelId).toBe('claude-x');
    expect(state.writingModelId).toBe('');
    expect(fetchSpy).toHaveBeenCalledOnce();
    service.skip();
    void promise;
  });

  it('saveProviderAndFetch refuses to continue without an API key', async () => {
    service.open();
    service.patch({ apiKey: '' });
    await service.saveProviderAndFetch();

    expect(service.current()?.providerError).toBe('apiKeyRequired');
    expect(service.current()?.step).toBe('welcome');
    expect(settings.providers().length).toBe(0);
  });

  it('saveProviderAndFetch reuses an existing provider', async () => {
    seedApi(api, {
      providers: [makeProvider({ id: 'prov-1', name: 'Existing' })]
    });
    await settings.loadAll();
    const fetchSpy = vi.spyOn(settings, 'fetchModels').mockResolvedValue();

    service.open();
    service.patch({ apiKey: 'sk-test-1234567890' });
    await service.saveProviderAndFetch();

    const state = service.current()!;
    expect(state.providerId).toBe('prov-1');
    expect(settings.providers().length).toBe(1); // no duplicate
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.step).toBe('models');
  });

  it('onWritingModelChange enables a disabled model and remembers it', async () => {
    seedApi(api, {
      providers: [makeProvider({ id: 'prov-1' })],
      models: [
        makeModel({
          id: 'm-1',
          modelId: 'alpha/model',
          providerId: 'prov-1',
          enabled: false
        })
      ]
    });
    await settings.loadAll();

    service.open();
    service.patch({ providerId: 'prov-1', models: settings.models() });
    await service.onWritingModelChange('alpha/model');

    expect(settings.models().find(m => m.modelId === 'alpha/model')?.enabled).toBe(true);
    // the selection is remembered, letting finish() set the default tasks
    service.patch({ writingModelId: service.current()!.writingModelId });
    expect(service.current()?.writingModelId).toBe('alpha/model');
  });

  it('finish() sets the default generation tasks and resolves "configured"', async () => {
    seedApi(api, {
      providers: [makeProvider({ id: 'prov-1' })],
      models: [makeModel({ id: 'm-1', modelId: 'alpha/model', providerId: 'prov-1', enabled: false })]
    });
    await settings.loadAll();

    const promise = service.open();
    service.patch({
      providerId: 'prov-1',
      writingModelId: 'alpha/model',
      loadDemo: false,
      models: settings.models()
    });
    await service.finish();

    for (const kind of ['title', 'headings', 'overview', 'language-check'] as const) {
      expect(generation.get(kind).providerId).toBe('prov-1');
      expect(generation.get(kind).modelId).toBe('alpha/model');
    }
    expect(settings.models().find(m => m.modelId === 'alpha/model')?.enabled).toBe(true);
    expect(await promise).toBe('configured');
    expect(service.current()).toBeNull();
  });

  it('finish() loads the demo data when the user opted in', async () => {
    const loadSpy = vi.spyOn(demoData, 'loadDemoData').mockResolvedValue('demo-chat-1');
    const openSpy = vi.spyOn(demoData, 'openFirstDemoChat').mockResolvedValue();

    seedApi(api, { providers: [makeProvider({ id: 'prov-1' })] });
    await settings.loadAll();

    const promise = service.open();
    service.patch({ providerId: 'prov-1', writingModelId: '', loadDemo: true, models: [] });
    await service.finish();

    expect(loadSpy).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledOnce();
    expect(await promise).toBe('configured');
  });

  it('useMock() registers the mock provider, sets defaults and finishes', async () => {
    const ensureSpy = vi.spyOn(demoData, 'ensureMockProvider').mockResolvedValue();

    await settings.loadAll(); // empty workspace — no provider configured
    expect(settings.providers().length).toBe(0);

    seedApi(api, {
      providers: [{ id: 'prov-mock', name: 'Mock (no key)' }],
      models: [{ id: 'm-mock', modelId: 'mock-writer', providerId: 'prov-mock', enabled: false }]
    });
    await settings.loadAll();

    const promise = service.open();
    service.patch({ loadDemo: false });
    await service.useMock();

    expect(ensureSpy).toHaveBeenCalledOnce();
    // defaults point at the mock model
    for (const kind of ['title', 'headings', 'overview', 'language-check'] as const) {
      expect(generation.get(kind).providerId).toBe('prov-mock');
      expect(generation.get(kind).modelId).toBe('mock-writer');
    }
    const mockModel = settings.models().find(m => m.modelId === 'mock-writer');
    expect(mockModel?.enabled).toBe(true);
    expect(await promise).toBe('configured');
    expect(service.current()).toBeNull();
  });
});
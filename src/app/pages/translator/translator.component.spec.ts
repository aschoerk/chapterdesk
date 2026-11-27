import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { ModelEntry, ProviderConfig } from '../../models/chat-config';
import { TranslatorComponent } from './translator.component';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings/settings.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { ModelRecencyService } from '../../core/settings/model-recency.service';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';
import { LlmOrchestratorService } from '../../core/llm/orchestration';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';

const MODEL: ModelEntry = {
  id: 'm-1',
  displayName: 'Alpha',
  modelId: 'alpha/model',
  providerId: 'prov-1',
  type: 'preset',
  enabled: true,
};

const PROVIDER: ProviderConfig = {
  id: 'prov-1',
  name: 'Provider',
  type: 'openai',
  baseUrl: 'https://example.test/v1',
  apiKey: 'key',
  enabled: true,
};

/** Model picker stub — the translator only reads the enabled models. */
const settingsStub = {
  enabledModels: () => [MODEL],
  providers: () => [PROVIDER],
};

/** Mutable generation-task stub: tests can configure per-task model + prompt. */
let taskConfig: { translateModel: ModelEntry | null; prompt: string };

const generationStub = {
  modelFor: (kind: string) =>
    kind === 'translate' ? taskConfig.translateModel : MODEL,
  get: (_kind: string) => ({
    kind: 'translate', providerId: '', modelId: '', prompt: taskConfig.prompt,
  }),
};

const promptStub = {
  effective: (id: string) => (id === 'language.translate' ? 'TRANSLATE-IT' : ''),
};

describe('TranslatorComponent', () => {
  let fixture: ComponentFixture<TranslatorComponent>;
  let component: TranslatorComponent;
  let completion: ReturnType<typeof vi.fn>;
  let orch: { completion: ReturnType<typeof vi.fn> };
  let recency: { recentIds: () => string[]; remember: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    localStorage.clear();
    taskConfig = { translateModel: null, prompt: '' };
    completion = vi.fn().mockResolvedValue({
      text: { status: 'ok', value: '  The cat sleeps.  ' },
    });
    orch = { completion };
    recency = { recentIds: () => [], remember: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [TranslatorComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() },
        { provide: SettingsService, useValue: settingsStub },
        { provide: GenerationSettingsService, useValue: generationStub },
        { provide: ModelRecencyService, useValue: recency },
        { provide: PromptDefaultsService, useValue: promptStub },
        { provide: LlmOrchestratorService, useValue: orch },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    fixture = TestBed.createComponent(TranslatorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('preselects the default generation model', () => {
    expect(component.modelId()).toBe('alpha/model');
    expect(component.models().length).toBe(1);
  });

  it('preselects the model configured for the translate generation task', async () => {
    // Settings → G"default" task model.
    const other: ModelEntry = { ...MODEL, id: 'm-2', displayName: 'Beta', modelId: 'beta/model' };
    taskConfig.translateModel = other;
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [TranslatorComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() },
        {
          provide: SettingsService,
          useValue: { enabledModels: () => [MODEL, other], providers: () => [PROVIDER] },
        },
        { provide: GenerationSettingsService, useValue: generationStub },
        { provide: ModelRecencyService, useValue: recency },
        { provide: PromptDefaultsService, useValue: promptStub },
        { provide: LlmOrchestratorService, useValue: orch },
      ],
    }).compileComponents();
    const local = TestBed.createComponent(TranslatorComponent);
    local.detectChanges();
    expect(local.componentInstance.modelId()).toBe('beta/model');
  });

  it('prefers the translate task prompt over the prompt default', async () => {
    taskConfig.prompt = 'TASK-PROMPT';
    component.source.set('Hallo');
    await component.translate();
    const [, req] = completion.mock.calls[0];
    expect(req.messages[0]).toEqual({ role: 'system', content: 'TASK-PROMPT' });
  });

  it('translates the German text with the chosen model and shows the answer', async () => {
    component.source.set('  Die Katze schläft.  ');
    expect(component.canTranslate()).toBe(true);

    await component.translate();

    expect(completion).toHaveBeenCalledTimes(1);
    const [cx, req, opts] = completion.mock.calls[0];
    // The editable language.translate instruction heads the request; the
    // German text is the user message.
    expect(req.messages[0]).toEqual({ role: 'system', content: 'TRANSLATE-IT' });
    expect(req.messages[1]).toEqual({ role: 'user', content: 'Die Katze schläft.' });
    expect(req.model).toBe(MODEL);
    expect(req.provider.baseUrl).toBe(PROVIDER.baseUrl);
    expect(req.stream).toBe(false);
    expect(opts.expect).toBe('text');
    expect(cx.chat.id).toBe('translator');

    // The answer is trimmed and kept, and the model becomes "recently used".
    expect(component.result()).toBe('The cat sleeps.');
    expect(component.loading()).toBe(false);
    expect(component.error()).toBe('');
    expect(recency.remember).toHaveBeenCalledWith('alpha/model');
  });

  it('Ctrl+Enter in the input translates like the button', async () => {
    component.source.set('Hallo');
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('textarea.tr-source') as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await fixture.whenStable();
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it('does nothing without text or while a request runs', async () => {
    await component.translate(); // empty source → no call
    expect(completion).not.toHaveBeenCalled();

    component.source.set('Hallo');
    component.loading.set(true);
    expect(component.canTranslate()).toBe(false);
    await component.translate();
    expect(completion).not.toHaveBeenCalled();
  });

  it('shows the model reason when the call refuses', async () => {
    completion.mockResolvedValueOnce({
      text: { status: 'refused', value: null, reason: 'content filtered' },
    });
    component.source.set('Hallo');
    await component.translate();
    expect(component.result()).toBe('');
    expect(component.error()).toBe('content filtered');
  });

  it('reports a missing model instead of calling out', async () => {
    component.modelId.set('');
    component.source.set('Hallo');
    // The guard already blocks the action…
    expect(component.canTranslate()).toBe(false);
    await component.translate();
    expect(completion).not.toHaveBeenCalled();
  });

  it('change of the picker keeps the provider in sync', () => {
    component.onModelChange('alpha/model');
    expect(component.providerId()).toBe('prov-1');
    component.onModelChange('unknown/model');
    expect(component.providerId()).toBe('');
  });

  it('copies the translation to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    component.result.set('The cat sleeps.');
    await component.copyResult();
    expect(writeText).toHaveBeenCalledWith('The cat sleeps.');
  });
});

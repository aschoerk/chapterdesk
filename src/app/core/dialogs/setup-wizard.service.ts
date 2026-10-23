import { Injectable, computed, inject, signal } from '@angular/core';
import { SettingsService } from '../settings/settings.service';
import { GenerationSettingsService } from '../settings/generation-settings.service';
import { DemoDataService } from '../demo-data/demo-data.service';
import { ProviderConfig, ModelEntry } from '../../models/chat-config';
import { GenerationTaskKind } from '../../models/generation-task';
import { MOCK_MODEL_ID, MOCK_PROVIDER_NAME } from '../mock-llm/mock-llm-config';

/** Result of a setup wizard run. */
export type SetupResult = 'configured' | 'skipped';

export type SetupStep = 'welcome' | 'provider' | 'models' | 'demo';

export interface SetupWizardState {
  step: SetupStep;
  // provider form
  providerName: string;
  providerType: ProviderConfig['type'];
  baseUrl: string;
  apiKey: string;
  // provider actions
  providerSavedId: string | null;
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
  savingProvider: boolean;
  providerError: string | null;
  fetching: boolean;
  fetchError: string | null;
  // models step
  providerId: string;
  models: ModelEntry[];
  writingModelId: string;
  enablingModel: boolean;
  // demo step
  loadDemo: boolean;
  demoLoaded: boolean;
  demoBusy: boolean;
  // finish
  finishing: boolean;
  error: string | null;
  resolve?: (value: SetupResult) => void;
}

/** Generation tasks whose default model should follow the chosen writing model. */
const WRITING_TASKS: GenerationTaskKind[] = [
  'default',
  'title',
  'headings',
  'overview',
  'language-check'
];

function normName(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

function initialState(settings: SettingsService, demo: DemoDataService): SetupWizardState {
  const firstProvider = settings.providers()[0];
  return {
    step: 'welcome',
    providerName: 'OpenRouter',
    providerType: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    providerSavedId: null,
    testing: false,
    testResult: null,
    savingProvider: false,
    providerError: null,
    fetching: false,
    fetchError: null,
    providerId: firstProvider?.id ?? '',
    models: [],
    writingModelId: '',
    enablingModel: false,
    loadDemo: !demo.isLoaded(),
    demoLoaded: demo.isLoaded(),
    demoBusy: false,
    finishing: false,
    error: null
  };
}

/**
 * Drives the skippable first-run Setup wizard shown whenever ChapterDesk
 * starts without a configured provider. The wizard is a small state machine:
 *
 *   welcome → provider → models → demo → (configured | skipped)
 *
 * The component renders `current()`; every state mutation + side effect lives
 * here so the flow is unit-testable.
 */
@Injectable({ providedIn: 'root' })
export class SetupWizardService {
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly demoData = inject(DemoDataService);

  /** The open wizard state, or null when closed. */
  readonly current = signal<SetupWizardState | null>(null);

  /** True when at least one provider exists (the provider step becomes a note). */
  readonly settingsHasProvider = computed(() => this.settings.providers().length > 0);

  /** Open the wizard. Resolves 'configured' when finished, 'skipped' when dismissed. */
  open(): Promise<SetupResult> {
    const existing = this.current();
    if (existing?.resolve) {
      return new Promise(resolve => {
        this.current.update(s => (s ? { ...s, resolve } : s));
      });
    }
    return new Promise(resolve => {
      this.current.set({ ...initialState(this.settings, this.demoData), resolve });
    });
  }

  /** Advance to a wizard step (only forward navigation is allowed). */
  go(step: SetupStep): void {
    this.patch({ step });
  }

  /** Merge a partial into the open state (no-op when closed). */
  patch(patch: Partial<SetupWizardState>): void {
    const s = this.current();
    if (!s) return;
    this.current.set({ ...s, ...patch });
  }

  /** Test the connection of the provider currently entered in the form. */
  async testProvider(): Promise<void> {
    const s = this.requireState();
    this.patch({ testing: true, testResult: null, providerError: null });
    try {
      const provider: ProviderConfig = {
        id: s.providerSavedId ?? 'prospective',
        name: s.providerName.trim() || 'Unnamed provider',
        type: s.providerType,
        baseUrl: s.baseUrl.trim() || 'https://openrouter.ai/api/v1',
        apiKey: s.apiKey.trim(),
        enabled: true
      };
      const result = await this.settings.testProvider(provider);
      this.patch({ testing: false, testResult: result });
    } catch (err: any) {
      this.patch({
        testing: false,
        testResult: { ok: false, message: err?.message || 'Test failed' }
      });
    }
  }

  /**
   * Persist the entered provider and fetch its model catalog, then jump to the
   * models step. When a provider already exists (e.g. the wizard opened with
   * configured providers but no enabled model) it reuses the first one and
   * just (re-)fetches its catalog.
   */
  async saveProviderAndFetch(): Promise<void> {
    const s = this.requireState();
    this.patch({ savingProvider: true, providerError: null, fetchError: null, fetching: false });

    try {
      let provider: ProviderConfig | undefined;
      if (s.providerSavedId) {
        provider = this.settings.providers().find(p => p.id === s.providerSavedId);
      }
      if (!provider) {
        const existing = this.settings.providers()[0];
        if (existing) {
          provider = existing;
        } else {
          if (!s.apiKey.trim()) {
            this.patch({
              savingProvider: false,
              providerError: 'apiKeyRequired'
            });
            return;
          }
          provider = await this.settings.addProvider({
            name: s.providerName.trim() || 'OpenRouter',
            type: s.providerType,
            baseUrl: s.baseUrl.trim() || 'https://openrouter.ai/api/v1',
            apiKey: s.apiKey.trim(),
            enabled: true
          });
          this.patch({ providerSavedId: provider.id });
        }
      }

      this.patch({ savingProvider: false, fetching: true, providerId: provider.id });
      await this.settings.fetchModels(provider);
      const models = this.modelsFor(provider.id);
      this.patch({
        fetching: false,
        models,
        // Preselect the first enabled model so the default step has a value.
        writingModelId: models.find(m => m.enabled)?.modelId ?? ''
      });
      this.go('models');
    } catch (err: any) {
      this.patch({
        savingProvider: false,
        fetching: false,
        fetchError: err?.message || (err?.error?.message as string) || 'Fetch failed'
      });
    }
  }

  /** Re-fetch the catalog for the models step when it is empty. */
  async fetchModelsForProvider(providerId: string): Promise<void> {
    const provider = this.settings.providers().find(p => p.id === providerId);
    if (!provider) return;
    this.patch({ fetching: true, fetchError: null });
    try {
      await this.settings.fetchModels(provider);
      const models = this.modelsFor(providerId);
      const currentModelId = this.current()?.writingModelId ?? '';
      this.patch({
        fetching: false,
        models,
        writingModelId: currentModelId || (models.find(m => m.enabled)?.modelId ?? '')
      });
    } catch (err: any) {
      this.patch({ fetching: false, fetchError: err?.message || 'Fetch failed' });
    }
  }

  /** Models of a provider, sorted by display name. */
  private modelsFor(providerId: string): ModelEntry[] {
    return this.settings
      .models()
      .filter(m => m.providerId === providerId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Choose the default writing model. The chosen model is enabled if it is
   * not already — an enabled model is what the chat UI falls back to when a
   * section has no explicit model binding.
   */
  async onWritingModelChange(modelId: string): Promise<void> {
    const s = this.requireState();
    this.patch({ writingModelId: modelId, enablingModel: true });
    const model = (s.models.length ? s.models : this.settings.models()).find(
      m => m.modelId === modelId || m.id === modelId
    );
    if (model && !model.enabled) {
      try {
        await this.settings.toggleModelEnabled(model.id);
      } catch {
        // the selection is still remembered even if enabling fails server-side
      }
    }
    this.patch({ enablingModel: false });
  }

  /** Finish the wizard: apply defaults, load demo data if wanted, close. */
  async finish(): Promise<void> {
    const s = this.requireState();
    this.patch({ finishing: true, error: null });

    try {
      const writing = (s.models.length ? s.models : this.settings.models()).find(
        m => m.modelId === s.writingModelId || m.id === s.writingModelId
      );
      if (writing && s.providerId) {
        // Make sure the chosen default is enabled, then point the common
        // authoring tasks at it ("default models").
        if (!writing.enabled) {
          await this.settings.toggleModelEnabled(writing.id);
        }
        for (const kind of WRITING_TASKS) {
          this.generation.update(kind, {
            providerId: s.providerId,
            modelId: writing.modelId
          });
        }
      }

      if (s.loadDemo && !this.demoData.isLoaded()) {
        this.patch({ demoBusy: true });
        const chatId = await this.demoData.loadDemoData();
        if (chatId) {
          await this.demoData.openFirstDemoChat();
        }
        this.patch({ demoBusy: false, demoLoaded: this.demoData.isLoaded() });
      }

      this.closeResolve('configured');
    } catch (err: any) {
      this.patch({
        finishing: false,
        error: err?.message || 'Setup failed'
      });
    }
  }

  /**
   * Skip the wizard and resolve 'skipped'. No state is persisted — per
   * requirement the wizard simply starts again whenever no provider is
   * configured.
   */
  skip(): void {
    this.closeResolve('skipped');
  }

  /**
   * "Play without a key": register the built-in mock provider/model, set the
   * common authoring tasks to it, optionally load the demo data, and finish.
   * Lets an installed ChapterDesk be used end-to-end (writing, titles,
   * headings, language checks) with no API key — the mock answers through the
   * local API server.
   */
  async useMock(): Promise<void> {
    const s = this.requireState();
    this.patch({ finishing: true, error: null });
    try {
      await this.demoData.ensureMockProvider();

      const provider = this.settings
        .providers()
        .find(p => normName(p.name) === normName(MOCK_PROVIDER_NAME));
      if (provider) {
        const model = this.settings
          .models()
          .find(m => m.providerId === provider.id && m.modelId === MOCK_MODEL_ID);
        if (model && !model.enabled) {
          await this.settings.toggleModelEnabled(model.id);
        }
        for (const kind of WRITING_TASKS) {
          this.generation.update(kind, { providerId: provider.id, modelId: MOCK_MODEL_ID });
        }
      }

      if (s.loadDemo && !this.demoData.isLoaded()) {
        this.patch({ demoBusy: true });
        const chatId = await this.demoData.loadDemoData();
        if (chatId) {
          await this.demoData.openFirstDemoChat();
        }
        this.patch({ demoBusy: false });
      }

      this.closeResolve('configured');
    } catch (err: any) {
      this.patch({
        finishing: false,
        error: err?.message || 'Setup failed'
      });
    }
  }

  private closeResolve(value: SetupResult): void {
    const s = this.current();
    if (!s) return;
    s.resolve?.(value);
    this.current.set(null);
  }

  private requireState(): SetupWizardState {
    const s = this.current();
    if (!s) throw new Error('Setup wizard is not open');
    return s;
  }
}
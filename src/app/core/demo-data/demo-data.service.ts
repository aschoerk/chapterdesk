import { Injectable, computed, inject, signal } from '@angular/core';
import { BundleService } from '../import-export/bundle.service';
import { ChatService } from '../chat/chat.service';
import { ProjectService } from '../settings/project.service';
import { SettingsService } from '../settings/settings.service';
import { GenerationSettingsService } from '../settings/generation-settings.service';
import { GenerationTaskKind } from '../../models/generation-task';
import { DEMO_BUNDLE } from './demo-bundle';
import {
  MOCK_IMAGE_MODEL_DISPLAY,
  MOCK_IMAGE_MODEL_ID,
  MOCK_MODEL_DISPLAY,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_NAME,
  mockProviderBaseUrl,
} from '../mock-llm/mock-llm-config';

/** Name used by the bundled demo project (the idempotency guard). */
export const DEMO_PROJECT_NAME = 'ChapterDesk Demo';

const MOCK_DEFAULT_TASKS: GenerationTaskKind[] = [
  'default',
  'title',
  'headings',
  'overview',
  'language-check',
];

function normName(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

/**
 * Loads the built-in demo workspace (see `demo-bundle.ts`) exactly once.
 *
 * It demonstrates structure, reading and editing without needing an LLM
 * provider/model. Idempotency is based on the ACTUAL presence of the
 * "ChapterDesk Demo" project (not on a localStorage marker), so no stale
 * browser-storage state is ever left behind: if the user deletes the demo
 * workspace the demo becomes loadable again.
 */
@Injectable({ providedIn: 'root' })
export class DemoDataService {
  private readonly bundleService = inject(BundleService);
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);

  /** True while an import is running (for UI spinners). */
  readonly loading = signal(false);

  /**
   * True when the demo workspace is present. Reactive: it mirrors the loaded
   * project list, so it flips back to false as soon as the demo project is
   * deleted (→ the demo can be loaded again, no stale flag blocks it).
   */
  readonly loaded = computed(() => this.hasDemoProject());

  private hasDemoProject(): boolean {
    for (const p of this.projectService.projects()) {
      if (normName(p.name) === normName(DEMO_PROJECT_NAME)) return true;
    }
    return false;
  }

  /** True when the demo workspace is present. */
  isLoaded(): boolean {
    return this.hasDemoProject();
  }

  /** True when the key-free mock provider is registered. */
  mockProviderExists(): boolean {
    return this.settings.providers().some(p => normName(p.name) === normName(MOCK_PROVIDER_NAME));
  }

  /**
   * Register the built-in "Mock (no key)" provider + preset model (idempotent
   * by provider name). Lets an installed ChapterDesk be played with without
   * any API key — the mock's baseUrl points back at the local API server's
   * `/chat/completions` and `/models` endpoints.
   */
  async ensureMockProvider(): Promise<void> {
    await this.settings.loadAll();
    let provider = this.settings.providers().find(
      p => normName(p.name) === normName(MOCK_PROVIDER_NAME)
    );
    if (!provider) {
      provider = await this.settings.addProvider({
        name: MOCK_PROVIDER_NAME,
        type: 'custom',
        baseUrl: mockProviderBaseUrl(),
        apiKey: 'local', // never called anywhere external
        enabled: true,
      });
    }

    const exists = this.settings
      .models()
      .some(m => m.providerId === provider.id && m.modelId === MOCK_MODEL_ID);
    if (!exists) {
      await this.settings.addPreset(
        MOCK_MODEL_DISPLAY,
        MOCK_MODEL_ID,
        provider.id,
        { input_modalities: ['text'], output_modalities: ['text'] }
      );
    }

    // Also register the key-free IMAGE model (output modality image): it lets
    // the Illustrate / image-send use cases run against the local server's
    // mock-image endpoint, which returns a small deterministic picture — no
    // provider key needed. Idempotent by model id, same as the writer.
    const imageExists = this.settings
      .models()
      .some(m => m.providerId === provider.id && m.modelId === MOCK_IMAGE_MODEL_ID);
    if (!imageExists) {
      await this.settings.addPreset(
        MOCK_IMAGE_MODEL_DISPLAY,
        MOCK_IMAGE_MODEL_ID,
        provider.id,
        { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] }
      );
    }
  }

  /** Register Mock Writer and use it only for authoring tasks without a default. */
  async ensureMockWriterDefaults(): Promise<void> {
    await this.ensureMockProvider();
    const provider = this.settings.providers().find(
      p => normName(p.name) === normName(MOCK_PROVIDER_NAME)
    );
    if (!provider) return;

    const model = this.settings.models().find(
      m => m.providerId === provider.id && m.modelId === MOCK_MODEL_ID
    );
    if (!model) return;
    if (!model.enabled) await this.settings.toggleModelEnabled(model.id);

    for (const kind of MOCK_DEFAULT_TASKS) {
      const config = this.generation.get(kind);
      if (!config.providerId && !config.modelId) {
        this.generation.update(kind, { providerId: provider.id, modelId: MOCK_MODEL_ID });
      }
    }

    // The key-free image model becomes the image-create default so Illustrate
    // works out of the box (a small mock picture instead of a key). It only
    // fills the task when nothing is configured yet — a real provider choice
    // always wins.
    const imageModel = this.settings.models().find(
      m => m.providerId === provider.id && m.modelId === MOCK_IMAGE_MODEL_ID
    );
    if (imageModel) {
      if (!imageModel.enabled) await this.settings.toggleModelEnabled(imageModel.id);
      const imageConfig = this.generation.get('image-create');
      if (!imageConfig.providerId && !imageConfig.modelId) {
        this.generation.update('image-create', { providerId: provider.id, modelId: MOCK_IMAGE_MODEL_ID });
      }
    }
  }

  /**
   * Import the demo bundle (idempotent). Returns the demo chat that should be
   * opened, or null when the import was skipped (demo already present).
   */
  async loadDemoData(): Promise<string | null> {
    await this.bundleService.loadAll();
    if (this.hasDemoProject()) {
      return null;
    }
    this.loading.set(true);
    try {
      await this.bundleService.importBundle(DEMO_BUNDLE, 'create');
      await this.bundleService.loadAll();
      return this.firstDemoChatId();
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Auto-load the demo data when the workspace is completely empty (a fresh
   * install). Returns the first-run demo chat id, or null when nothing was
   * imported (workspace already had data or demo was already loaded).
   */
  async ensureDemoData(): Promise<string | null> {
    await this.bundleService.loadAll();
    const empty =
      this.chatService.chats().length === 0 &&
      this.projectService.projects().length === 0;
    if (!empty) return null;
    return this.loadDemoData();
  }

  /** The most instructive demo chat (the tour) — opened by default. */
  private firstDemoChatId(): string | null {
    const chats = this.chatService.chats();
    const tour = chats.find(c => c.title === 'Reader & Editor Tour');
    const story = chats.find(c => c.title === 'The Lantern Keeper');
    return (tour ?? story ?? chats[0])?.id ?? null;
  }

  /** Select the first demo chat so the user lands on content immediately. */
  async openFirstDemoChat(): Promise<void> {
    const id = this.firstDemoChatId();
    if (!id) return;
    await this.chatService.selectChat(id);
  }
}
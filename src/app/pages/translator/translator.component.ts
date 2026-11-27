import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Chat } from '../../models/chat';
import type { ModelEntry, ProviderConfig } from '../../models/chat-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings/settings.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { ModelRecencyService } from '../../core/settings/model-recency.service';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';
import { LlmOrchestratorService } from '../../core/llm/orchestration';
import type { UsecaseKind } from '../../core/llm/orchestration';
import { ModelSelectComponent } from '../../components/model-select/model-select.component';

/**
 * German → English translator.
 *
 * A small, self-contained tool page. It is not part of the story workflow, so
 * it has no entry in the main navigation — it is linked from the SETTINGS
 * sidebar (Settings → Translator) and otherwise exists only under its URL.
 *
 * The page asks the selected model to translate one block of text and shows the
 * result. Ctrl+Enter in the input box and the Translate button do the same
 * thing (the input box keeps the caret, so Ctrl+Enter is the fast path).
 */
@Component({
  selector: 'app-translator',
  standalone: true,
  imports: [FormsModule, ModelSelectComponent],
  templateUrl: './translator.component.html',
  styleUrl: './translator.component.css',
})
export class TranslatorComponent {
  readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly recency = inject(ModelRecencyService);
  private readonly orch = inject(LlmOrchestratorService);

  /** German source text. */
  readonly source = signal('');
  /** Last translation returned by the model. */
  readonly result = signal('');
  /** True while the request runs (button + Ctrl+Enter are disabled). */
  readonly loading = signal(false);
  /** Failure message of the last request ('' = none). */
  readonly error = signal('');
  /** Model chosen in the picker. */
  readonly modelId = signal('');
  readonly providerId = signal('');

  readonly models = computed(() => this.settings.enabledModels());
  /** Nothing to send yet / already sending → the action is disabled. */
  readonly canTranslate = computed(
    () => !!this.source().trim() && !!this.modelId() && !this.loading(),
  );

  constructor() {
    this.modelId.set(this.initialModelId());
  }

  /**
   * Preselected model: the model configured for the `translate` generation
   * task (Settings → Generation tasks), else the "default" task model, else the
   * most recently used writing model, else the first enabled one.
   */
  private initialModelId(): string {
    const model =
      this.generation.modelFor('translate')
      ?? this.generation.modelFor('default')
      ?? this.models().find(m =>
        this.recency.recentIds().some(id => id === m.modelId || id === m.id))
      ?? this.models()[0];
    return model?.modelId ?? '';
  }

  /** Keep the provider in sync with the model chosen in the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
    this.providerId.set(this.resolveProvider(modelId)?.id ?? '');
  }

  private resolveModel(modelId: string): ModelEntry | undefined {
    return this.models().find(m => m.modelId === modelId || m.id === modelId);
  }

  private resolveProvider(modelId: string): ProviderConfig | undefined {
    const model = this.resolveModel(modelId);
    if (!model) return undefined;
    return this.settings.providers().find(p => p.id === model.providerId);
  }

  /** Ctrl+Enter inside the input box translates, like pressing the button. */
  @HostListener('keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void this.translate();
    }
  }

  /**
   * Send ONE instruction message ("translate this") with the source text and
   * show the answer. The instruction is the `translate` generation task's
   * prompt when configured, else the editable `language.translate` prompt
   * default — so the wording can be tuned in Settings → Generation tasks or
   * Settings → Prompt defaults.
   */
  async translate(): Promise<void> {
    if (!this.canTranslate()) return;
    const model = this.resolveModel(this.modelId());
    const provider = this.resolveProvider(this.modelId());
    if (!model || !provider) {
      this.error.set(this.i18n.t('translator.modelMissing'));
      return;
    }

    this.loading.set(true);
    this.error.set('');
    try {
      const instruction =
        this.generation.get('translate').prompt.trim()
        || this.promptDefaults.effective('language.translate');
      const messages = [
        { role: 'system' as const, content: instruction },
        { role: 'user' as const, content: this.source().trim() },
      ];
      // The translator is a standalone tool: no chat exists, so the log entry
      // is attributed to a synthetic chat. It is non-streaming — one clean
      // answer that is shown as a whole.
      const cx = {
        chat: { id: 'translator', title: 'Translator' } as Chat,
        usecase: 'translate' as UsecaseKind,
      };
      const slots = await this.orch.completion(
        cx,
        {
          model,
          provider: {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            type: provider.type,
          },
          messages,
          stream: false,
          textOnlyModalities: true,
        },
        { expect: 'text' },
      );

      const text = slots.text?.status === 'ok' ? (slots.text.value ?? '').trim() : '';
      if (text) {
        this.result.set(text);
        this.recency.remember(model.modelId);
      } else {
        this.result.set('');
        this.error.set(
          slots.error?.reason
          ?? slots.text?.reason
          ?? this.i18n.t('translator.empty'),
        );
      }
    } catch (err: unknown) {
      this.error.set(
        this.i18n.t('translator.failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      this.loading.set(false);
    }
  }

  /** Copy the translation to the clipboard (best effort, silently ignored). */
  async copyResult(): Promise<void> {
    const text = this.result().trim();
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable (non-secure context) — nothing to report */
    }
  }
}

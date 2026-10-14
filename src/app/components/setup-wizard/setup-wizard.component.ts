import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { SetupWizardService, SetupWizardState } from '../../core/setup-wizard.service';
import { ModelEntry } from '../../models/chat-config';

const STEP_ORDER = ['welcome', 'provider', 'models', 'demo'] as const;
type StepKey = (typeof STEP_ORDER)[number];

@Component({
  selector: 'app-setup-wizard',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './setup-wizard.component.html',
  styleUrl: './setup-wizard.component.css'
})
export class SetupWizardComponent {
  readonly wizard = inject(SetupWizardService);
  readonly i18n = inject(I18nService);

  readonly s = computed(() => this.wizard.current());
  /** Steps that are actual configuration steps (welcome excluded) for the stepper. */
  readonly steps = computed<{ key: StepKey; labelKey: string }[]>(() => [
    { key: 'welcome', labelKey: 'setupWizard.stepWelcome' },
    { key: 'provider', labelKey: 'setupWizard.stepProvider' },
    { key: 'models', labelKey: 'setupWizard.stepModels' },
    { key: 'demo', labelKey: 'setupWizard.stepDemo' }
  ]);

  readonly stepIndex = computed(() => {
    const step = this.s()?.step ?? 'welcome';
    const idx = STEP_ORDER.indexOf(step as StepKey);
    return idx < 0 ? 0 : idx;
  });

  readonly providerTypes = [
    { value: 'openrouter', labelKey: 'setupWizard.providerTypeOpenrouter' },
    { value: 'openai', labelKey: 'setupWizard.providerTypeOpenai' },
    { value: 'custom', labelKey: 'setupWizard.providerTypeCustom' }
  ];

  /** Models of the provider currently being configured (from the state snapshot). */
  readonly models = computed(() => this.s()?.models ?? []);

  /** Enable the chosen default model + remember it (calls the API). */
  onWritingModelChange(modelId: string): void {
    void this.wizard.onWritingModelChange(modelId);
  }

  go(step: StepKey): void {
    this.wizard.go(step);
  }

  testProvider(): void {
    void this.wizard.testProvider();
  }

  saveAndFetch(): void {
    void this.wizard.saveProviderAndFetch();
  }

  fetchModels(): void {
    const providerId = this.s()?.providerId;
    if (providerId) void this.wizard.fetchModelsForProvider(providerId);
  }

  finish(): void {
    void this.wizard.finish();
  }

  /** "Play without a key": register the built-in mock provider and finish. */
  useMock(): void {
    void this.wizard.useMock();
  }

  skip(): void {
    this.wizard.skip();
  }
}
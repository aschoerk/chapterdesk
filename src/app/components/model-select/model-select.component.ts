import { Component, computed, inject, input, output } from '@angular/core';
import { ModelEntry } from '../../models/chat-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ModelRecencyService } from '../../core/settings/model-recency.service';
import { orderModelChoices, type ModelChoiceGroup } from '../../core/settings/model-choices';

/**
 * The app's shared MODEL picker: a `<select>` whose options are grouped as
 * **current model → recently used → all models**, so switching back to the
 * model that wrote the previous chapter is one click instead of a scan
 * through the catalog.
 *
 * Use it wherever the user picks a WRITING model for a single action (the
 * direction editor, prepend, rewrite in place, elaborate, chapter
 * descriptions, log resend). Pickers whose default is dictated by a
 * generation task setting (illustrate / create image → `image-create`) keep
 * their own plain list.
 *
 * The inner `<select>` receives `selectClass` so each host keeps its own
 * styling hooks (`.model-select`, `.elaborate-model-select`, …).
 */
@Component({
  selector: 'app-model-select',
  standalone: true,
  templateUrl: './model-select.component.html',
  styleUrl: './model-select.component.css'
})
export class ModelSelectComponent {
  readonly i18n = inject(I18nService);
  private readonly recency = inject(ModelRecencyService);

  /** Models to offer (usually `settings.enabledModels()`, alphabetical). */
  readonly models = input<readonly ModelEntry[]>([]);
  /** Currently selected model id (`modelId`). */
  readonly value = input<string>('');
  /** Disables the select (e.g. while a request runs). */
  readonly disabled = input(false);
  /** Tooltip of the select. */
  readonly title = input('');
  /** Extra class applied to the inner `<select>` (styling hook of the host). */
  readonly selectClass = input('');

  /** Emits the picked model id. */
  readonly valueChange = output<string>();

  /** The grouped options, recomputed when the model list / selection changes. */
  readonly groups = computed<ModelChoiceGroup[]>(() => orderModelChoices(
    this.models(),
    this.value(),
    this.recency.recentIds(),
    {
      current: this.i18n.t('node.modelGroupCurrent'),
      recent: this.i18n.t('node.modelGroupRecent'),
      all: this.i18n.t('node.modelGroupAll'),
    },
  ));

  onPick(modelId: string): void {
    this.valueChange.emit(modelId);
  }
}

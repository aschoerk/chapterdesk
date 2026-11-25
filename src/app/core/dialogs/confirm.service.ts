import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from '../i18n/i18n.service';

/** One selectable entry of the optional model picker. */
export interface ConfirmModelOption {
  /** Option value (a model id, e.g. `m.modelId`). */
  id: string;
  /** Shown in the dropdown. */
  label: string;
  /** Provider owning the model (carried through to the caller). */
  providerId: string;
}

/** Optional model selector shown below the editable prompt. */
export interface ConfirmModelOptions {
  /** Label above the select. */
  label: string;
  /** Pre-selected model id; falls back to the first option when unknown. */
  value?: string;
  /** Tooltip (title) of the select. */
  title?: string;
  /** The models the user may pick from (flat list — used when `groups` is absent). */
  options: ConfirmModelOption[];
  /**
   * Optional grouped view of the same entries (current model → recently used →
   * all models). Rendered as `<optgroup>`s; `options` stays as the flat
   * fallback so callers/tests keep working.
   */
  groups?: { label: string; options: ConfirmModelOption[] }[];
}

/** Optional editable text field shown inside the confirmation dialog. */
export interface ConfirmPromptOptions {
  /** Label above the textarea. */
  label: string;
  /** Initial text (pre-filled, editable). */
  value: string;
  /** Placeholder shown when the field is empty. */
  placeholder?: string;
  /** Textarea height in rows (default 6). */
  rows?: number;
  /** Optional model picker shown under the textarea. */
  model?: ConfirmModelOptions;
}

/** What a prompt-carrying confirmation resolves with on confirm. */
export interface ConfirmPromptResult {
  /** The (possibly edited) prompt text. */
  text: string;
  /** The chosen model id, or '' when the dialog showed no model picker. */
  modelId: string;
  /** Provider of the chosen model, or '' when unknown. */
  providerId: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * When set, the dialog shows an editable textarea below the message and the
   * confirm call resolves with the EDITED TEXT instead of a boolean — see
   * {@link ConfirmService.askWithPrompt}.
   */
  prompt?: ConfirmPromptOptions;
}

/** What a confirmation resolves with: a decision, edited text/result, or a cancel. */
export type ConfirmOutcome = boolean | string | ConfirmPromptResult | null;

interface ConfirmState extends ConfirmRequest {
  resolve: (value: ConfirmOutcome) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly i18n = inject(I18nService);
  readonly current = signal<ConfirmState | null>(null);

  ask(req: ConfirmRequest): Promise<boolean> {
    return new Promise(resolve => {
      this.current.set({
        ...this.normalize(req),
        resolve: (value: ConfirmOutcome) => resolve(value === true)
      });
    });
  }

  /**
   * Like {@link ask}, but the dialog also shows an editable textarea
   * (`req.prompt`) and, optionally, a model picker (`req.prompt.model`).
   * Resolves with the EDITED TEXT plus the chosen model on confirm, or null
   * when the dialog is cancelled / dismissed. Used by "Rewrite in place" to let
   * the user adapt the original prompt (the direction that produced the answer)
   * and pick the model that re-writes it.
   */
  askWithPrompt(req: ConfirmRequest & { prompt: ConfirmPromptOptions }): Promise<ConfirmPromptResult | null> {
    return new Promise(resolve => {
      this.current.set({
        ...this.normalize(req),
        prompt: req.prompt,
        resolve: (value: ConfirmOutcome) => {
          if (typeof value === 'string') {
            // Tolerate plain-text resolutions (legacy callers/mocks).
            resolve({ text: value, modelId: '', providerId: '' });
          } else if (value && typeof value === 'object') {
            resolve(value);
          } else {
            resolve(null);
          }
        }
      });
    });
  }

  private normalize(req: ConfirmRequest): ConfirmRequest {
    return {
      title: req.title,
      message: req.message,
      confirmLabel: req.confirmLabel ?? this.i18n.t('common.discard'),
      cancelLabel: req.cancelLabel ?? this.i18n.t('common.keepEditing'),
      danger: req.danger ?? true
    };
  }

  /**
   * Resolve the open confirmation: `true`/`false` for a plain decision, a
   * string for the edited prompt text, or null when dismissed.
   */
  close(result: ConfirmOutcome): void {
    const cur = this.current();
    if (!cur) return;
    this.current.set(null);
    cur.resolve(result);
  }
}

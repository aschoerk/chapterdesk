import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from '../i18n/i18n.service';

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

/** What a confirmation resolves with: a decision, edited text, or a cancel. */
export type ConfirmOutcome = boolean | string | null;

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
   * (`req.prompt`). Resolves with the EDITED TEXT on confirm, or null when the
   * dialog is cancelled / dismissed. Used by "Rewrite in place" to let the user
   * adapt the original prompt (the direction that produced the answer) before
   * the answer is re-generated.
   */
  askWithPrompt(req: ConfirmRequest & { prompt: ConfirmPromptOptions }): Promise<string | null> {
    return new Promise(resolve => {
      this.current.set({
        ...this.normalize(req),
        prompt: req.prompt,
        resolve: (value: ConfirmOutcome) =>
          resolve(typeof value === 'string' ? value : null)
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

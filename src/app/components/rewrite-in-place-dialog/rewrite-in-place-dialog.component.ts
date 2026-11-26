import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { RewriteInPlaceDialogService } from '../../core/dialogs/rewrite-in-place-dialog.service';
import { ModelSelectComponent } from '../model-select/model-select.component';

/**
 * Dedicated "Rewrite in place" dialog.
 *
 * Before this dialog existed, the generic CONFIRM dialog was overloaded: it
 * carried an editable copy of the original prompt plus a model select. The
 * rewrite itself is now a different operation — rewrite the CURRENT chapter
 * text according to an additional specification, using the configured
 * `structure.rewriteInPlace` prompt and keeping the following text consistent
 * — so it gets its own dialog. The caller runs the `send-rewrite` flow with
 * the collected specification + model.
 */
@Component({
  selector: 'app-rewrite-in-place-dialog',
  standalone: true,
  imports: [FormsModule, ModelSelectComponent],
  templateUrl: './rewrite-in-place-dialog.component.html',
  styleUrl: './rewrite-in-place-dialog.component.css'
})
export class RewriteInPlaceDialogComponent {
  readonly dialog = inject(RewriteInPlaceDialogService);
  readonly i18n = inject(I18nService);

  /** The additional specification the model must follow (editable). */
  readonly specification = signal('');
  /** The chosen writing model. */
  readonly modelId = signal('');
  readonly providerId = signal('');

  /** Send the story history (everything before this answer) as context. */
  readonly includeHistory = signal(true);
  /** Send this answer's CURRENT text as the "content to rewrite". */
  readonly includeContent = signal(true);
  /** Send the following chapters so the rewrite keeps their details fitting. */
  readonly includeFollowing = signal(true);

  /** Enabled models from the open dialog entry. */
  readonly models = computed(() => this.dialog.current()?.models ?? []);

  /** How many following text(s) this answer has. */
  readonly followingCount = computed(() => this.dialog.current()?.followingCount ?? 0);

  /** The original prompt that produced this answer (may be empty). */
  readonly originalPrompt = computed(() => this.dialog.current()?.originalPrompt ?? '');

  constructor() {
    effect(() => {
      const state = this.dialog.current();
      if (!state) return;
      this.specification.set('');
      // Every new dialog starts from the "everything included" default; the
      // following-text box is only meaningful when something follows.
      this.includeHistory.set(true);
      this.includeContent.set(true);
      this.includeFollowing.set(state.followingCount > 0);
      this.applyModelSelection(state.modelId, state.providerId);
    });
  }

  /** The dialog message: mentions the following texts when there are any. */
  message(): string {
    const count = this.dialog.current()?.followingCount ?? 0;
    return count > 0
      ? this.i18n.t('node.regenerateInPlaceMsgExtra', { count })
      : this.i18n.t('node.regenerateInPlaceMsg');
  }

  /**
   * Toggle "send the current text of this answer". Turning it OFF means the
   * answer is written from scratch — the specification box is then pre-filled
   * with the ORIGINAL PROMPT that produced this answer so it can be adapted.
   * Turning it back ON clears that auto-fill again (unless the user edited it).
   */
  setIncludeContent(value: boolean): void {
    const was = this.includeContent();
    this.includeContent.set(value);
    if (was === value) return;
    const prompt = this.originalPrompt();
    if (!value) {
      if (!this.specification().trim()) this.specification.set(prompt);
    } else if (this.specification() === prompt) {
      this.specification.set('');
    }
  }

  /** Set model + provider from a picked model id (falling back to the first). */
  applyModelSelection(modelId: string, fallbackProvider = ''): void {
    const model = this.models().find(m => m.modelId === modelId || m.id === modelId)
      ?? (!modelId ? this.models()[0] : undefined);
    this.modelId.set(model ? model.modelId : modelId);
    this.providerId.set(model?.providerId ?? fallbackProvider);
  }

  onModelChange(modelId: string): void {
    this.applyModelSelection(modelId);
  }

  /** Confirm: resolve with the specification + chosen model. */
  submit(): void {
    if (!this.dialog.current()) return;
    this.dialog.close({
      specification: this.specification(),
      includeHistory: this.includeHistory(),
      includeContent: this.includeContent(),
      includeFollowing: this.followingCount() > 0 && this.includeFollowing(),
      modelId: this.modelId(),
      providerId: this.providerId(),
    });
  }

  cancel(): void {
    this.dialog.cancel();
  }

  /** True when the current click interaction started with a pointer press on
   *  the backdrop itself (so a text-selection drag ending there does not
   *  dismiss the dialog). */
  private backdropPressStarted = false;

  onBackdropMousedown(ev: MouseEvent): void {
    this.backdropPressStarted = ev.target === ev.currentTarget;
  }

  onBackdrop(ev: MouseEvent): void {
    const dismiss = ev.target === ev.currentTarget && this.backdropPressStarted;
    this.backdropPressStarted = false;
    if (dismiss) this.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.cancel();
    // Enter inserts newlines in the textarea; Ctrl/Cmd+Enter confirms.
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      this.submit();
    }
  }

  /**
   * Escape cancels at document level so it works even when focus is outside
   * the dialog (the backdrop only catches keys once an inner control has
   * focus). Guarded by the open state, so it never interferes while closed.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.cancel();
    }
  }
}

import { Component, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import type { ConfirmOutcome } from '../../core/dialogs/confirm.service';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.css'
})
export class ConfirmDialogComponent {
  readonly confirm = inject(ConfirmService);

  /**
   * The user's edit of the optional prompt field. `promptEntry` remembers which
   * pending confirmation the draft belongs to, so every NEW confirmation starts
   * from its own pre-filled text (and a closed dialog never leaks the old
   * draft into the next one).
   */
  private readonly draft = signal('');
  private draftEntry: unknown = null;

  /** The text the prompt textarea shows (the request's value until edited). */
  promptValue(): string {
    const d = this.confirm.current();
    return this.draftEntry === d ? this.draft() : (d?.prompt?.value ?? '');
  }

  /** Remember the edited text for the OPEN confirmation. */
  onPromptInput(value: string): void {
    this.draftEntry = this.confirm.current();
    this.draft.set(value ?? '');
  }

  /** True when the pending request shows the editable prompt field. */
  hasPrompt(): boolean {
    return !!this.confirm.current()?.prompt;
  }

  /** True when the prompt field is shown but empty (confirm stays disabled). */
  promptBlank(): boolean {
    return this.hasPrompt() && !this.promptValue().trim();
  }

  /** Confirm: resolve with the edited prompt text, or `true` without one. */
  submit(): void {
    if (this.promptBlank()) return;
    const result: ConfirmOutcome = this.hasPrompt() ? this.promptValue() : true;
    this.confirm.close(result);
  }

  /** True when the current click interaction started with a pointer press
   *  on the backdrop itself. A backdrop click only dismisses the dialog
   *  when the press also started on the backdrop — otherwise a text-
   *  selection drag that began inside the message and ended on the
   *  backdrop would close the dialog while marking text to copy. */
  private backdropPressStarted = false;

  onBackdropMousedown(ev: MouseEvent): void {
    this.backdropPressStarted = ev.target === ev.currentTarget;
  }

  onBackdrop(ev: MouseEvent): void {
    const dismiss = ev.target === ev.currentTarget && this.backdropPressStarted;
    this.backdropPressStarted = false;
    if (dismiss) this.confirm.close(false);
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.confirm.close(false);
    // A plain Enter confirms only without the prompt field — inside the
    // textarea Enter must insert a newline. Ctrl/Cmd+Enter always confirms.
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey || !this.hasPrompt())) {
      ev.preventDefault();
      this.submit();
    }
  }

  /**
   * Escape cancels the dialog. Handled at document level so it works even
   * when focus is outside the dialog (the backdrop only catches keys once
   * an inner control has focus). Guarded by the open state, so it never
   * interferes while the dialog is closed.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.confirm.current()) {
      ev.preventDefault();
      this.confirm.close(false);
    }
  }
}

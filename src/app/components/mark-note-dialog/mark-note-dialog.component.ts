import { Component, ElementRef, HostListener, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { MarkNoteDialogService } from '../../core/dialogs/mark-note-dialog.service';

/**
 * Modal that collects the NOTICE (annotation) for a reading mark — a position
 * or a selected text range inside a section. Mounted once in the app root.
 *
 * Escape / backdrop click cancel (no mark is created, no notice changed),
 * Ctrl+Enter or the Save button confirms.
 */
@Component({
  selector: 'app-mark-note-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './mark-note-dialog.component.html',
  styleUrl: './mark-note-dialog.component.css'
})
export class MarkNoteDialogComponent {
  readonly dialog = inject(MarkNoteDialogService);
  readonly i18n = inject(I18nService);

  readonly note = signal('');
  private readonly noteInput = viewChild<ElementRef<HTMLTextAreaElement>>('noteInput');

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      this.note.set(s.note);
      // Focus the textarea so the user can type the notice right away.
      queueMicrotask(() => this.noteInput()?.nativeElement.focus());
    });
  }

  submit(): void {
    this.dialog.submit(this.note());
  }

  /** True when the current click interaction started on the backdrop itself
   *  (a text-selection drag that ends there must not dismiss the dialog). */
  private backdropPressStarted = false;

  onBackdropMousedown(ev: MouseEvent): void {
    this.backdropPressStarted = ev.target === ev.currentTarget;
  }

  onBackdrop(ev: MouseEvent): void {
    const dismiss = ev.target === ev.currentTarget && this.backdropPressStarted;
    this.backdropPressStarted = false;
    if (dismiss) this.dialog.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.dialog.cancel();
      return;
    }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      this.submit();
    }
  }

  /**
   * Escape / Ctrl+Enter at DOCUMENT level, so they work even when focus has
   * not entered the dialog yet (the backdrop only sees keys once an inner
   * control has focus). Guarded by the open state.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (!this.dialog.current()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.dialog.cancel();
      return;
    }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      this.submit();
    }
  }
}

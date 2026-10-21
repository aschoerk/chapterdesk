import { Component, inject, HostListener } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.css'
})
export class ConfirmDialogComponent {
  readonly confirm = inject(ConfirmService);

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
    if (ev.key === 'Enter') this.confirm.close(true);
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

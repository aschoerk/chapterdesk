import { Injectable } from '@angular/core';
import { createModalState } from './modal-state';

/**
 * State of the open "notice for a reading mark" dialog.
 *
 * A mark is a POSITION or a TEXT SELECTION in a section; the dialog collects
 * the notice (annotation) that belongs to it. Opened
 *  - when a mark is created from the node context menu / Ctrl+M, and
 *  - when an existing mark's notice is edited.
 */
export interface MarkNoteDialogState {
  /** The notice text (pre-filled when editing). */
  note: string;
  /** The selected text the mark refers to ('' for a bare position). */
  quote: string;
  /** True when the mark is a bare position (no selected text). */
  isPosition: boolean;
}

/**
 * Holds the open state of the "notice for a mark" dialog (mounted once in the
 * app root, mirroring ConfirmDialog / PrependDialog / IllustrateDialog).
 */
@Injectable({ providedIn: 'root' })
export class MarkNoteDialogService {
  private readonly modal = createModalState<MarkNoteDialogState, string>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  /**
   * Open the dialog for a mark. Resolves with the (possibly emptied) notice
   * text, or null when cancelled — in which case the caller must NOT create
   * the mark.
   */
  open(state: Partial<MarkNoteDialogState> = {}): Promise<string | null> {
    return this.modal.open({
      note: state.note ?? '',
      quote: state.quote ?? '',
      isPosition: state.isPosition ?? !state.quote
    });
  }

  /** Save the edited notice (an empty string is a valid notice-free mark). */
  submit(note: string): void {
    this.modal.close((note ?? '').trim());
  }

  /** Cancel — the mark is not created / the notice is not changed. */
  cancel(): void {
    this.modal.close(null);
  }
}

import { Injectable } from '@angular/core';
import { createModalState } from './modal-state';

/**
 * State of the open "Prepend director" dialog: the proposed (or existing)
 * director instruction text, prefilled and editable, plus whether a director
 * already exists for this node (so the dialog can offer removal).
 */
export interface PrependDialogState {
  /** The proposed / existing director text (pre-filled, editable). */
  text: string;
  /** Whether a director instruction already exists for the current node. */
  hasExisting: boolean;
}

/**
 * Holds the open state of the "Prepend director" dialog (mounted once in the
 * app root, mirroring ConfirmDialog / IllustrateDialog). Lets the user edit
 * the director instruction that will be prepended to the following chapters.
 */
@Injectable({ providedIn: 'root' })
export class PrependDialogService {
  private readonly modal = createModalState<PrependDialogState, string>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  /**
   * Open the dialog prefilled with `text`. Resolves with the (possibly
   * edited) director text, or null on cancel.
   */
  open(text: string, hasExisting: boolean): Promise<string | null> {
    return this.modal.open({ text, hasExisting });
  }

  /** Confirm with the edited text. An empty text removes the director. */
  submit(text: string): void {
    this.modal.close(text ?? '');
  }

  /** Cancel — close without changing the stored text. */
  cancel(): void {
    this.modal.close(null);
  }
}
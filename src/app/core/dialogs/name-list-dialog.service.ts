import { Injectable } from '@angular/core';
import { createModalState } from './modal-state';

/**
 * State of the open "Name lists" settings dialog. The dialog manages the name
 * dictionary (add / edit / delete / import) directly through
 * NameDictionaryService and resolves with `true` when anything changed (for a
 * toast), or null on cancel.
 */
export interface NameListDialogState {
  /** Language the dialog starts filtered to (null = all). */
  language?: string | null;
}

/**
 * Holds the open state of the "Name lists" settings dialog (mounted once in
 * the app root). Resolves with `true` when the dictionary was modified, null
 * on cancel.
 */
@Injectable({ providedIn: 'root' })
export class NameListDialogService {
  private readonly modal = createModalState<NameListDialogState, boolean>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  open(state?: NameListDialogState): Promise<boolean | null> {
    return this.modal.open(state ?? {});
  }

  /** Confirm — the dictionary was modified. */
  submit(changed: boolean): void {
    this.modal.close(changed);
  }

  /** Cancel — close without reporting a change. */
  cancel(): void {
    this.modal.close(null);
  }
}
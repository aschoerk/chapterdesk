import { Injectable } from '@angular/core';
import { createModalState } from './modal-state';
import type { NameOccurrence, NameReplaceRow, NameTextUnit } from '../names/name-replace';

/**
 * State of the open "Replace names" dialog.
 *
 * The dialog is mounted once in the app root (mirroring ConfirmDialog /
 * RewriteDialog). The page that opens it supplies the visible text units and
 * an `apply` callback that persists the replacement back through the chat
 * API. The dialog itself computes the rows (find + propose + overlap) and
 * resolves with the approved rows on confirm.
 */
export interface NameReplaceDialogState {
  /** The visible text units (chat nodes) the names are found in. */
  units: NameTextUnit[];
  /**
   * Persist the replaced units. Called once with the full updated unit list
   * when the user confirms.
   */
  apply: (units: NameTextUnit[]) => Promise<void>;
  /**
   * Optional: scroll to + highlight ONE concrete occurrence of a name (the
   * exact unit + range). Drives the per-name ◀/▶ navigation buttons.
   */
  navigate?: (occ: NameOccurrence) => void;
  /** Language the text is written in (filters the dictionary). */
  language?: string | null;
  /**
   * Names ALREADY handled in this chat (replaced or explicitly excluded).
   * They are hidden from the list; the dialog can also let the user remove
   * them again (see {@link saveHandled}).
   */
  handled?: string[];
  /**
   * Persist the updated handled-names list (per chat — replaces the list).
   * Called when the user applies decisions and when a handled name is
   * restored from the "handled" panel.
   */
  saveHandled?: (names: string[]) => Promise<void>;
}

/**
 * Holds the open state of the "Replace names" dialog. Resolves with the
 * approved rows (null on cancel) so the caller can report what changed.
 */
@Injectable({ providedIn: 'root' })
export class NameReplaceDialogService {
  private readonly modal = createModalState<NameReplaceDialogState, NameReplaceRow[]>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  open(state: NameReplaceDialogState): Promise<NameReplaceRow[] | null> {
    return this.modal.open(state);
  }

  /** Confirm with the approved rows. */
  submit(rows: NameReplaceRow[]): void {
    this.modal.close(rows);
  }

  /** Cancel — close without applying anything. */
  cancel(): void {
    this.modal.close(null);
  }
}
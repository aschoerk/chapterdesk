import { Injectable } from '@angular/core';
import { createModalState } from './modal-state';
import { ChatNode } from '../../models/chat';

/**
 * State of the open "Compare versions / siblings" dialog.
 *
 * The dialog always has an EDITABLE "new" side (`newText`) and a READ-ONLY
 * "compare-with" side that is chosen from a dropdown:
 *   - `versions` → prior versions of the node (compare-versions mode).
 *   - `siblings` → other nodes at the same level (compare-siblings mode), the
 *     current node being the editable one.
 * Exactly one of `versions` / `siblings` is provided.
 */
export interface NodeVersionDiffDialogState {
  /** Current (new) content — the editable side the dialog edits a copy of. */
  newText: string;
  /** Prior versions of the node, newest first (compare-versions mode). */
  versions?: ChatNode[];
  /** Sibling nodes to compare against (compare-siblings mode). */
  siblings?: ChatNode[];
}

/**
 * Holds the open state of the "Compare versions" dialog (mounted once in the
 * app root, mirroring PrependDialog / IllustrateDialog). Lets the user compare
 * the current draft against an earlier version, restore whole diff blocks or
 * individual lines from the old version, and hand-edit the new version.
 * Resolves with the edited new text, or null on cancel.
 */
@Injectable({ providedIn: 'root' })
export class NodeVersionDiffDialogService {
  private readonly modal = createModalState<NodeVersionDiffDialogState, string>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  /** Open the dialog. Resolves with the edited text, or null on cancel. */
  open(state: NodeVersionDiffDialogState): Promise<string | null> {
    return this.modal.open(state);
  }

  /** Apply the edited new text back to the caller. */
  submit(text: string): void {
    this.modal.close(text);
  }

  /** Cancel — the caller's draft is left untouched. */
  cancel(): void {
    this.modal.close(null);
  }
}
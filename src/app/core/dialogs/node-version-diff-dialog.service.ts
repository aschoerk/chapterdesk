import { Injectable } from '@angular/core';
import { createModalState } from './modal-state';
import { ChatNode } from '../../models/chat';

/**
 * One read-only text the dialog can compare the "current" text against.
 * Used for the generic text comparisons (topic / environment / persona texts,
 * prompt templates) next to the chat-node version / sibling comparisons.
 */
export interface TextDiffOption {
  /** Stable id (usually the version id). */
  id: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** The full text recorded by this option. */
  text: string;
}

/**
 * State of the open "Compare versions / siblings" dialog.
 *
 * The dialog always has an EDITABLE "new" side (`newText`) and a READ-ONLY
 * "compare-with" side that is chosen from a dropdown:
 *   - `versions` → prior versions of the node (compare-versions mode).
 *   - `siblings` → other nodes at the same level (compare-siblings mode), the
 *     current node being the editable one.
 *   - `texts`    → generic read-only texts (topic/system-prompt history,
 *     environment definition/greeting, persona description, prompt versions).
 * Exactly one of `texts` / `versions` / `siblings` is provided.
 */
export interface NodeVersionDiffDialogState {
  /** Current (new) content — the editable side the dialog edits a copy of. */
  newText: string;
  /**
   * Explicit dialog title. When omitted the node titles
   * (`nodeVersionDiff.title` / `titleSiblings`) are used.
   */
  title?: string;
  /** Label of the left (compare-with) pane; defaults to the node labels. */
  originalLabel?: string;
  /** Label of the right (current) pane; defaults to the node labels. */
  modifiedLabel?: string;
  /** Generic read-only texts to compare `newText` against. */
  texts?: TextDiffOption[];
  /** Option preselected on the left side (defaults to the first one). */
  initialId?: string;
  /**
   * Read-only comparison: the right side cannot be edited, the restore-change
   * button and Apply are hidden. The dialog just shows the differences.
   */
  readOnly?: boolean;
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
 *
 * It also serves the READ-ONLY text comparisons of versioned general texts
 * (topic / environment / persona fields) and prompt-version comparisons.
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
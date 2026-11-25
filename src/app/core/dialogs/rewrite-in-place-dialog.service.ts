import { Injectable } from '@angular/core';
import { Chat, ChatNode } from '../../models/chat';
import { ModelEntry } from '../../models/chat-config';
import { createModalState } from './modal-state';

/**
 * State of the open "Rewrite in place" dialog: the answer about to be
 * rewritten, the enabled writing models for the picker and the number of
 * following text(s) that will be kept consistent.
 *
 * The dialog only collects input — the caller runs the `send-rewrite` flow (in
 * text-rewrite mode) with the returned specification + model.
 */
export interface RewriteInPlaceDialogState {
  /** The answer whose text is rewritten in place. */
  node: ChatNode;
  /** The chat the answer belongs to (null-safe). */
  chat: Chat | null;
  /** Enabled writing models offered in the picker. */
  models: readonly ModelEntry[];
  /** Pre-selected model id. */
  modelId: string;
  /** Provider of the pre-selected model. */
  providerId: string;
  /** How many following text(s) (children) the answer has. */
  followingCount: number;
}

/** What the dialog resolves with on confirm. */
export interface RewriteInPlaceResult {
  /** The additional specification entered by the user (may be empty). */
  specification: string;
  /** Send the story history (everything before the answer) as context. */
  includeHistory: boolean;
  /** Send the answer's CURRENT text as the "content to rewrite". */
  includeContent: boolean;
  /** Send the following chapters so the rewrite keeps their details fitting. */
  includeFollowing: boolean;
  /** The chosen model id, or '' when no picker was shown. */
  modelId: string;
  /** Provider of the chosen model, or '' when unknown. */
  providerId: string;
}

/**
 * Holds the open state of the "Rewrite in place" dialog (mounted once in the
 * app root, mirroring the other promise-based dialogs).
 *
 * Replaces the former adaptation of the generic confirm dialog: the rewrite
 * now uses the configured `structure.rewriteInPlace` prompt and an additional
 * specification, not an editable copy of the original prompt.
 */
@Injectable({ providedIn: 'root' })
export class RewriteInPlaceDialogService {
  private readonly modal = createModalState<
    RewriteInPlaceDialogState,
    RewriteInPlaceResult
  >();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  /**
   * Open the dialog for an assistant answer. Resolves with the specification +
   * chosen model, or null when the user cancels.
   */
  open(opts: {
    node: ChatNode;
    chat: Chat | null;
    models: readonly ModelEntry[];
    modelId?: string;
    providerId?: string;
    followingCount?: number;
  }): Promise<RewriteInPlaceResult | null> {
    return this.modal.open({
      node: opts.node,
      chat: opts.chat,
      models: opts.models,
      modelId: opts.modelId ?? '',
      providerId: opts.providerId ?? '',
      followingCount: opts.followingCount ?? 0,
    });
  }

  /** Confirm with the entered specification + chosen model. */
  close(result: RewriteInPlaceResult): void {
    this.modal.close(result);
  }

  /** Cancel — close without changing anything. */
  cancel(): void {
    this.modal.close(null);
  }
}

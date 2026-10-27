import { Injectable } from '@angular/core';
import { createModalState } from './modal-state';
import { ModelEntry } from '../../models/chat-config';
import { LlmLogEntry } from '../llm/llm-log.service';
import { ResendMessage } from '../llm/llm-log-resend.service';

/** What the resend dialog shows: the source log entry + the editable messages. */
export interface ResendDialogState {
  entry: LlmLogEntry;
  messages: ResendMessage[];
  /** Enabled models the user can re-send with (model select). */
  models: ModelEntry[];
  /** Default selection — the model the original call used (first enabled when gone). */
  modelId: string;
}

/** What the resend dialog resolves with: the edited messages + chosen model. */
export interface ResendDialogResult {
  messages: ResendMessage[];
  /** Chosen model id ('' = use the original call's model). */
  modelId: string;
}

/**
 * Holds the open state of the "Edit request & resend" dialog (mounted once in
 * the app root, mirroring PrependDialog / IllustrateDialog). The log-view
 * opens it with a chat entry; it resolves with the edited messages + the
 * chosen model, or null on cancel.
 */
@Injectable({ providedIn: 'root' })
export class ResendDialogService {
  private readonly modal = createModalState<ResendDialogState, ResendDialogResult>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  /** Open the dialog for a log entry, resolving with the edited messages + model. */
  open(state: ResendDialogState): Promise<ResendDialogResult | null> {
    return this.modal.open(state);
  }

  /** Confirm with the edited messages + chosen model. */
  submit(result: ResendDialogResult): void {
    this.modal.close(result);
  }

  /** Cancel — close without resending. */
  cancel(): void {
    this.modal.close(null);
  }
}

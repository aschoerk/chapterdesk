import { Injectable } from '@angular/core';
import { ModelEntry } from '../../models/chat-config';
import { createModalState } from './modal-state';

/**
 * What the "Prepend director" dialog is opened with besides the text: the
 * writing models the user may pick from and the initial selection (the
 * direction's own model, i.e. the model that would answer it).
 */
export interface PrependDialogOptions {
  /** Enabled writing models offered in the picker. */
  models?: ModelEntry[];
  /** Pre-selected model id (the direction's own model). */
  modelId?: string;
  /** Provider of the pre-selected model. */
  providerId?: string;
}

/**
 * State of the open "Prepend director" dialog: the proposed (or existing)
 * director instruction text, prefilled and editable, plus whether a director
 * already exists for this node (so the dialog can offer removal) and the
 * model picker entries.
 */
export interface PrependDialogState {
  /** The proposed / existing director text (pre-filled, editable). */
  text: string;
  /** Whether a director instruction already exists for the current node. */
  hasExisting: boolean;
  /** Models offered in the picker (empty → picker hidden). */
  models: ModelEntry[];
  /** Model selected when the dialog opened. */
  modelId: string;
  /** Provider of the selected model. */
  providerId: string;
}

/** What the dialog resolves with on confirm. */
export interface PrependDialogResult {
  /** The (possibly edited) director text. Empty = remove the director. */
  text: string;
  /** Model chosen for the director generation ('' = leave the default). */
  modelId: string;
  /** Provider of the chosen model. */
  providerId: string;
}

/**
 * Holds the open state of the "Prepend director" dialog (mounted once in the
 * app root, mirroring ConfirmDialog / IllustrateDialog). Lets the user edit
 * the director instruction that will be prepended to the following chapters
 * and pick the model that generates it — the picker behaves like the
 * direction editor's (current → recently used → all models).
 */
@Injectable({ providedIn: 'root' })
export class PrependDialogService {
  private readonly modal = createModalState<PrependDialogState, PrependDialogResult | string>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  /**
   * Open the dialog pre-filled with `text` (plus the model picker options).
   * Resolves with the (possibly edited) text + chosen model, or null on
   * cancel. Plain-text resolutions (legacy mocks) are normalized.
   */
  async open(
    text: string,
    hasExisting: boolean,
    options: PrependDialogOptions = {},
  ): Promise<PrependDialogResult | null> {
    const result = await this.modal.open({
      text,
      hasExisting,
      models: options.models ?? [],
      modelId: options.modelId ?? '',
      providerId: options.providerId ?? '',
    });
    if (result == null) return null;
    if (typeof result === 'string') {
      return { text: result, modelId: '', providerId: '' };
    }
    return result;
  }

  /**
   * Confirm with the edited text + the chosen model. An empty text removes the
   * director (the caller then skips the generation).
   */
  submit(text: string, modelId?: string): void {
    const state = this.current();
    const wanted = (modelId ?? state?.modelId ?? '').trim();
    const model = wanted
      ? (state?.models ?? []).find(m => m.modelId === wanted || m.id === wanted) ?? null
      : null;
    this.modal.close({
      text: text ?? '',
      modelId: model ? model.modelId : wanted,
      providerId: model?.providerId ?? (wanted ? state?.providerId ?? '' : ''),
    });
  }

  /** Cancel — close without changing the stored text. */
  cancel(): void {
    this.modal.close(null);
  }
}
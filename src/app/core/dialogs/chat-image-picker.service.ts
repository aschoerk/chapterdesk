import { Injectable } from '@angular/core';
import { NodeAttachment } from '../../models/chat';
import { ChatImageEntry } from '../chat/chat-images.service';
import { createModalState } from './modal-state';

/** Data handed to the picker: the images found in the current chat. */
export interface ChatImagePickerData {
  images: ChatImageEntry[];
}

/**
 * Holds the open state of the "add images from the current chat" picker
 * (mounted once in the app root, mirroring IllustrateDialogService). Lets the
 * user pick image attachments found in the current chat so they can be added
 * as reference images in the Illustrate / Create-image dialogs.
 *
 * Resolves with the selected `NodeAttachment[]`, or null on cancel.
 */
@Injectable({ providedIn: 'root' })
export class ChatImagePickerService {
  private readonly modal = createModalState<ChatImagePickerData, NodeAttachment[]>();

  /** The picker entry (the list of chat images), or null when closed. */
  readonly current = this.modal.current;

  /** Open the picker with the images found in the current chat. */
  open(images: ChatImageEntry[]): Promise<NodeAttachment[] | null> {
    return this.modal.open({ images });
  }

  /** Confirm with the selected attachments. */
  submit(selected: NodeAttachment[]): void {
    this.modal.close(selected);
  }

  /** Cancel — close without adding anything. */
  cancel(): void {
    this.modal.close(null);
  }
}
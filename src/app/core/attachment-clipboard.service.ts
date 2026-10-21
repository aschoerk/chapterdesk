import { Injectable, computed, signal } from '@angular/core';
import { NodeAttachment } from '../models/chat';

export type AttachmentClipboardAction = 'copy' | 'cut';

/**
 * Client-side clipboard for node attachments.
 *
 * A **copy** stages the attachments — clones are appended when pasted (the
 * originals stay in place). A **cut** only STAGES them: nothing is removed
 * from the source node here. The actual removal happens when the user pastes
 * them into another node ("cut is only done in reality when paste is done").
 * If no paste happens — or the staged cut is cancelled — the source keeps its
 * attachments exactly where they were.
 *
 * Kept in-memory on purpose: attachment payloads are base64 data-URLs (up to
 * several MB each) that would blow the localStorage quota if persisted here
 * (unlike the node/story clipboards, which store small ids / text content).
 */
export interface AttachmentClipboardEntry {
  action: AttachmentClipboardAction;
  /** The node the attachments were taken from — used to remove them on a cut paste. */
  sourceNodeId: string | null;
  sourceChatId: string | null;
  attachments: NodeAttachment[];
}

@Injectable({ providedIn: 'root' })
export class AttachmentClipboardService {
  /** The current attachment clipboard payload (null = empty). */
  readonly clipboard = signal<AttachmentClipboardEntry | null>(null);

  readonly hasContent = computed(
    () => (this.clipboard()?.attachments.length ?? 0) > 0
  );
  readonly count = computed(() => this.clipboard()?.attachments.length ?? 0);
  readonly action = computed(() => this.clipboard()?.action ?? null);

  /** Stage a copy: the attachments can be duplicated (cloned) on paste. */
  copy(
    sourceNodeId: string | null,
    sourceChatId: string | null,
    attachments: NodeAttachment[]
  ): void {
    this.stage('copy', sourceNodeId, sourceChatId, attachments);
  }

  /**
   * Stage a MOVE: remember the attachments with action 'cut' WITHOUT touching
   * the source node. They are only removed from it when the user pastes them
   * into another node — nothing is removed here.
   */
  cut(
    sourceNodeId: string | null,
    sourceChatId: string | null,
    attachments: NodeAttachment[]
  ): void {
    this.stage('cut', sourceNodeId, sourceChatId, attachments);
  }

  private stage(
    action: AttachmentClipboardAction,
    sourceNodeId: string | null,
    sourceChatId: string | null,
    attachments: NodeAttachment[]
  ): void {
    const list = attachments.filter(Boolean);
    if (!list.length) return;
    // Defensive copy: the clipboard must not share mutable references with the
    // node/draft arrays it was taken from.
    this.clipboard.set({
      action,
      sourceNodeId,
      sourceChatId,
      attachments: list.map(a => ({ ...a })),
    });
  }

  /** True when the given attachment is currently staged for a cut (pending move). */
  isCutAttachment(id: string): boolean {
    const entry = this.clipboard();
    return (
      entry?.action === 'cut' && entry.attachments.some(a => a.id === id)
    );
  }

  /** True when the given attachment is on the clipboard (any action). */
  isStaged(id: string): boolean {
    return this.clipboard()?.attachments.some(a => a.id === id) ?? false;
  }

  clear(): void {
    this.clipboard.set(null);
  }
}

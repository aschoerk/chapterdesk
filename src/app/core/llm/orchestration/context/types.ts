import { Chat, ChatNode } from '../../../../models/chat';
import { ModelEntry, ProviderConfig } from '../../../../models/chat-config';

/**
 * Types and module-level helpers of the use-case context factory.
 *
 * The factory was decomposed along its concerns:
 *   – types.ts     (this file — shared types + image-description record helpers)
 *   – topic.ts     (per-run prompt-topic scope state)
 *   – models.ts    (model + provider resolution, request extras)
 *   – messages.ts  (context / send-message building, image interpretation)
 *   – prompts.ts   (instruction / prompt-template builders)
 *   – factory.ts   (UsecaseContextFactory facade — preserves the public surface)
 */

/**
 * Name of the stored image-description record attachment. When a user node
 * carries this record (and its image signature matches the node's current
 * data: image attachments), the image descriptions are ALREADY part of the
 * node's text — interpretation must NOT run again.
 */
export const IMAGE_DESCRIPTION_RECORD = 'image-description.txt';
const IMAGE_DESCRIPTION_RECORD_RE = /^image-description\.txt$/i;

/** True when an attachment is the stored image-description record. */
export function isImageDescriptionRecord(a: Pick<NodeAttachmentLike, 'name'>): boolean {
  return IMAGE_DESCRIPTION_RECORD_RE.test(a?.name ?? '');
}

/** The stored image-description record (parsed), or null. */
export interface StoredImageDescription {
  images: string[];
  description: string;
}

/** Stable signature of an image set (used to detect already-interpreted). */
export function imageSetSignature(images: NodeAttachmentLike[]): string[] {
  return [...images]
    .map(img => {
      const data = img?.dataUrl ?? '';
      const comma = data.indexOf(',');
      const payload = comma >= 0 ? data.slice(comma + 1) : data;
      // Small, stable fingerprint per image: mime | length | tail-24.
      return `${img?.mimeType ?? 'image'}|${payload.length}|${payload.slice(-24)}`;
    })
    .sort();
}

/** Parse the stored image-description record (or null on any failure). */
export function parseStoredImageDescription(attachments: NodeAttachmentLike[] | undefined | null): StoredImageDescription | null {
  const rec = (attachments ?? []).find(isImageDescriptionRecord);
  if (!rec) return null;
  try {
    const text = decodeDataUrlToText(rec.dataUrl);
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      images: Array.isArray(parsed.images) ? parsed.images.map(String) : [],
      description: typeof parsed.description === 'string' ? parsed.description : ''
    };
  } catch {
    return null;
  }
}

/** One resolved model + provider pair (rendering or planning role). */
export interface ModelRef {
  model: ModelEntry;
  provider: ProviderConfig;
}

export interface BuildContext {
  chat: Chat | null;
  node: ChatNode | null;
  usecase: import('../types').UsecaseContext['usecase'];
  vars: import('../types').UsecaseVars;
}

/** Small structural alias so callers don't depend on NodeAttachment directly. */
export type NodeAttachmentLike = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

export type { ChatNode }; // re-export for convenience

// Local import kept after types for readability (avoids a top-of-file cycle).
import { decodeDataUrlToText } from '../../llm-message';
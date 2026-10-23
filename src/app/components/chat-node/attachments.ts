/**
 * attachments.ts
 *
 * File → NodeAttachment conversion helpers for the chat-node editor (the file
 * input and drag & drop). Kept as module functions (like the shared
 * `dom-metrics.ts`) so the conversion is testable without the component.
 */
import { NodeAttachment } from '../../models/chat';
import { inferMimeType } from '../../core/llm/llm-message';
import { newId } from '../../core/util/helpers';

/** Upper bound for a single attachment payload (base64 data-URL). */
export const MAX_ATTACHMENT_BYTES = 4_000_000;

/** Read a File as a base64 data-URL. */
export function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Turn a FileList / File[] into attachment records (base64 payloads). Files
 * that exceed the size cap are skipped and reported through `onTooLarge` so
 * the caller can surface a user-facing alert.
 */
export async function filesToAttachments(
  files: FileList | File[],
  opts: {
    /** Size cap (bytes); defaults to MAX_ATTACHMENT_BYTES. */
    maxBytes?: number;
    /** Called for each file that exceeds the cap. */
    onTooLarge?: (name: string) => void;
  } = {}
): Promise<NodeAttachment[]> {
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const result: NodeAttachment[] = [];
  for (const file of Array.from(files)) {
    if (file.size > maxBytes) {
      opts.onTooLarge?.(file.name);
      continue;
    }
    const dataUrl = await readAsDataURL(file);
    result.push({
      id: newId(),
      name: file.name,
      mimeType: inferMimeType(file.name, file.type),
      size: file.size,
      dataUrl
    });
  }
  return result;
}
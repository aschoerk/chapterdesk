import { ChatMessage, ChatNode, NodeAttachment } from '../../../models/chat';
import { decodeDataUrlToText, isImageMime, isTextualMime, resolvedMime } from './mime';
import { isGeneratedImageAttachment, isPromptRecordAttachment } from './image';

/**
 * MESSAGE-COMPOSITION helpers: the message-part types and turning chat nodes
 * / raw messages into OpenAI-compatible message content. Split out of the
 * former `llm-message.ts` utility bag (see `index.ts`).
 */

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

/** Rough token estimate; the repo bundles no tokenizer, so ~4 chars/token. */
export function estimateContentTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Text of a message (string content or the text parts of a parts array). */
export function messageText(m: { role: string; content: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(p => p && typeof p === 'object' && 'text' in p && p.text)
      .map(p => (p as { text: string }).text)
      .join('\n');
  }
  return '';
}

const TEXT_EMBED_LIMIT = 80_000;
export const PREPEND_MAX_TOKENS = 5000;

function clipText(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_EMBED_LIMIT) return { text, truncated: false };
  return {
    text: text.slice(0, TEXT_EMBED_LIMIT) + `\n\n[truncated, original ${text.length} characters]`,
    truncated: true
  };
}

function hasUsableDataUrl(dataUrl?: string | null): dataUrl is string {
  return !!dataUrl && dataUrl.startsWith('data:') && dataUrl.includes(',');
}

/**
 * Convert a chat node into OpenAI-compatible message content.
 * Images become image_url parts. Text-like files are inlined. Other files
 * are sent as file parts so providers that accept document input can read them.
 */
export function nodeToMessageContent(
  node: Pick<ChatNode, 'content' | 'attachments'>
): string | MessagePart[] {
  // Internal illustration metadata is never part of the story context sent to
  // the model: the recorded prompt files (prompt-N.txt / refused-prompt-N.txt)
  // AND the generated pictures themselves (illustration-N.*, whose base64
  // payload would bloat every story-progression call). Hand-attached images
  // (any other image name) are kept — those are intentional inputs the model
  // should see.
  const isContextMeta = (a: NodeAttachment): boolean =>
    isPromptRecordAttachment(a) || isGeneratedImageAttachment(a);
  const attachments = (node.attachments || []).filter(a => !isContextMeta(a));
  if (attachments.length === 0) {
    return node.content || '';
  }

  const images: NodeAttachment[] = [];
  const textual: NodeAttachment[] = [];
  const files: NodeAttachment[] = [];

  for (const raw of attachments) {
    const mime = resolvedMime(raw);
    if (isImageMime(mime) && hasUsableDataUrl(raw.dataUrl)) {
      images.push(raw);
    } else if (isTextualMime(mime) && hasUsableDataUrl(raw.dataUrl)) {
      textual.push(raw);
    } else if (hasUsableDataUrl(raw.dataUrl)) {
      files.push(raw);
    } else {
      files.push(raw);
    }
  }

  const textChunks: string[] = [];
  if (node.content?.trim()) textChunks.push(node.content);

  for (const file of textual) {
    const decoded = decodeDataUrlToText(file.dataUrl);
    if (decoded != null) {
      const { text } = clipText(decoded);
      textChunks.push(`--- attached file: ${file.name} (${resolvedMime(file)}) ---\n${text}`);
    } else {
      textChunks.push(`--- attached file: ${file.name} (${resolvedMime(file)}) [could not decode] ---`);
    }
  }

  const missing = files.filter(f => !hasUsableDataUrl(f.dataUrl));
  const sendableFiles = files.filter(f => hasUsableDataUrl(f.dataUrl));

  if (missing.length) {
    textChunks.push(
      '[Attached files missing data]\n' +
      missing.map(a => `- ${a.name} (${resolvedMime(a)})`).join('\n')
    );
  }

  if (sendableFiles.length) {
    textChunks.push(
      '[Attached files]\n' +
      sendableFiles.map(a => `- ${a.name} (${resolvedMime(a)})`).join('\n')
    );
  }

  const parts: MessagePart[] = [];
  const text = textChunks.join('\n\n');
  if (text.trim()) {
    parts.push({ type: 'text', text });
  }

  for (const img of images) {
    parts.push({
      type: 'image_url',
      image_url: { url: img.dataUrl }
    });
  }

  for (const file of sendableFiles) {
    parts.push({
      type: 'file',
      file: {
        filename: file.name,
        file_data: file.dataUrl
      }
    });
  }

  if (parts.length === 0) {
    return node.content || '';
  }
  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text;
  }
  return parts;
}

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (typeof message.content === 'string') return message;
    if (!Array.isArray(message.content)) return { ...message, content: '' };

    const parts: MessagePart[] = [];
    for (const raw of message.content as MessagePart[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type === 'text') {
        const text = raw.text ?? '';
        if (text.length) parts.push({ type: 'text', text });
        continue;
      }
      if (raw.type === 'image_url') {
        const url = raw.image_url?.url;
        if (hasUsableDataUrl(url) || (typeof url === 'string' && /^https?:\/\//i.test(url))) {
          parts.push({ type: 'image_url', image_url: { url } });
        }
        continue;
      }
      if (raw.type === 'file') {
        const filename = raw.file?.filename;
        const fileData = raw.file?.file_data;
        if (filename && hasUsableDataUrl(fileData)) {
          parts.push({ type: 'file', file: { filename, file_data: fileData } });
        }
      }
    }

    const hasMedia = parts.some(p => p.type === 'image_url' || p.type === 'file');
    const hasText = parts.some(p => p.type === 'text' && p.text.trim());
    if (hasMedia && !hasText) {
      parts.unshift({ type: 'text', text: 'See the attached file(s).' });
    }

    if (parts.length === 0) return { ...message, content: '' };
    if (parts.length === 1 && parts[0].type === 'text') {
      return { ...message, content: parts[0].text };
    }
    return { ...message, content: parts };
  });
}
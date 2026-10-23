import { NodeAttachment } from '../../../models/chat';
import { mimeFromDataUrl } from './mime';

/**
 * IMAGE-generation helpers: recorded-prompt detection, image part types and
 * extraction from chat-completion payloads, and building the persisted
 * `NodeAttachment`s. Split out of the former `llm-message.ts` utility bag
 * (see `index.ts`).
 */

// ---------------------------------------------------------------------------
// Recorded image prompts (illustration metadata, not story content)
// ---------------------------------------------------------------------------

/**
 * Names of the text attachments that record the exact prompt used for an
 * image (written next to each generated illustration) — or the prompt + the
 * model's refusal text for a refused/empty attempt.
 *
 * These are INTERNAL illustration metadata. They are stored next to the
 * pictures so the prompt of every image (and every failed attempt) stays
 * findable, but they are NOT part of the story and must be excluded from the
 * story progression context, the chat reader and any story export.
 */
const PROMPT_RECORD_NAMES = /^(?:refused-)?prompt(?:-\d+)?\.txt$/i;

/** True when the attachment is a recorded image prompt (`prompt-N.txt` / `refused-prompt-N.txt`). */
export function isPromptRecordAttachment(a: Pick<NodeAttachment, 'name'>): boolean {
  return PROMPT_RECORD_NAMES.test(a.name || '');
}

/**
 * Names of the image attachments created by the app's illustration flow
 * (`illustration-N.ext`, see `imagePartToAttachment`). These are GENERATED
 * pictures stored as attachments on the chapter so they render in the UI,
 * the reader and exports — but they are NOT part of the story text.
 *
 * Rule for LLM context: generated illustrations are excluded (their base64
 * payload would bloat every subsequent story-progression call for no story
 * value; the story already describes the scene in words). Images a user
 * attached BY HAND (anything that is not an `illustration-*` name) are kept —
 * those are intentional inputs the writing model should see.
 */
const GENERATED_IMAGE_NAMES = /^illustration-\d+\.[a-z0-9]+$/i;

/** True when the attachment is an app-generated illustration (`illustration-N.ext`). */
export function isGeneratedImageAttachment(a: Pick<NodeAttachment, 'name'>): boolean {
  return GENERATED_IMAGE_NAMES.test(a.name || '');
}

// ---------------------------------------------------------------------------
// Image-generation responses
// ---------------------------------------------------------------------------

/** One image returned by an image-capable chat completion. */
export interface LlmImagePart {
  /** `data:…;base64,…` or `https://…` URL of the generated image. */
  url: string;
  /** Optional provider-supplied caption / alt text. */
  altText?: string;
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif'
};

function isImageUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(data:|https?:\/\/)/i.test(value);
}

/**
 * OpenAI-style refusal: when a model declines to generate (e.g. a content
 * policy refusal), some providers return a 200 whose message carries a
 * `refusal` field instead of content. Read it so the user can see WHY nothing
 * was drawn.
 */
export function extractLlmRefusal(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const root = json as Record<string, unknown>;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0];
  if (!choice || typeof choice !== 'object') return '';
  const message = (choice as Record<string, unknown>)['message'];
  if (!message || typeof message !== 'object') return '';
  const refusal = (message as Record<string, unknown>)['refusal'];
  return typeof refusal === 'string' ? refusal.trim() : '';
}

/**
 * Pull image URLs out of free-text content. Several gateways (notably
 * OpenRouter and some Gemini/GLM image models) return the generated image not
 * as a structured part but as a markdown link (`![…](https://…)`) or a bare
 * URL inside the assistant text. Deduplicates and keeps usable URLs only.
 */
function extractImageUrlsFromText(text: string): string[] {
  const out: string[] = [];
  const md = /!\[[^\]]*\]\(\s*['"]?([^'")>\s]+)['"]?\s*\)/g;
  const bare = /https?:\/\/[^\s<)"'`]+/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text))) {
    const u = m[1];
    if (isImageUrl(u) && !out.includes(u)) out.push(u);
  }
  for (const u of text.match(bare) ?? []) {
    if (isImageUrl(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Pull generated images out of a non-stream chat-completion payload.
 *
 * Image-capable models reply with `choices[].message.content` as an array of
 * parts, including `{ type: 'image_url', image_url: { url } }`. Some gateways
 * use `images` arrays, root-level `data[].url` / `b64_json`, an OpenRouter-
 * style `output` list, or — very commonly — a markdown/plain URL inside a
 * plain string `content`. We scan all of those shapes and keep only images
 * that can actually be rendered (data: or http(s) URLs).
 */
export function extractLlmImages(json: unknown): LlmImagePart[] {
  if (!json || typeof json !== 'object') return [];
  const out: LlmImagePart[] = [];

  const pushUrl = (u: unknown, alt?: unknown): void => {
    if (isImageUrl(u)) out.push({ url: u, altText: typeof alt === 'string' ? alt : undefined });
  };

  const pushTextUrls = (text: unknown): void => {
    if (typeof text !== 'string') return;
    for (const url of extractImageUrlsFromText(text)) {
      out.push({ url });
    }
  };

  /** Scan one message/content array whose items are part objects (or URLs). */
  const scanParts = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const part of list) {
      if (typeof part === 'string') {
        pushTextUrls(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p['image_url'] && typeof p['image_url'] === 'object') {
        const iu = p['image_url'] as Record<string, unknown>;
        pushUrl(iu['url'], iu['alt_text'] ?? iu['alt']);
      } else if (p['image_url'] !== undefined) {
        pushUrl(p['image_url'], p['alt']);
      } else if (isImageUrl(p['url'])) {
        pushUrl(p['url'], p['alt_text'] ?? p['alt']);
      } else if (isImageUrl(p['data_url']) || isImageUrl(p['data'])) {
        pushUrl(p['data_url'] ?? p['data'], p['alt'] ?? p['alt_text']);
      } else if (typeof p['b64_json'] === 'string') {
        out.push({ url: `data:image/png;base64,${p['b64_json']}` });
      }
    }
  };

  /** Scan content that may be a string (markdown/URL) or a parts array. */
  const scanContent = (content: unknown): void => {
    if (typeof content === 'string') {
      pushTextUrls(content);
      return;
    }
    scanParts(content);
  };

  const choices = (json as Record<string, unknown>)['choices'];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      const message = c['message'];
      if (message && typeof message === 'object') {
        const m = message as Record<string, unknown>;
        scanContent(m['content']);
        scanParts(m['images']);
      }
      scanParts(c['images']);
    }
  }

  const root = json as Record<string, unknown>;
  scanParts(root['images']);

  const data = root['data'];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') {
        pushTextUrls(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const d = item as Record<string, unknown>;
      pushUrl(d['url'], d['alt_text'] ?? d['alt']);
      if (isImageUrl(d['data_url']) || isImageUrl(d['data'])) {
        pushUrl(d['data_url'] ?? d['data'], d['alt'] ?? d['alt_text']);
      }
      if (typeof d['b64_json'] === 'string') {
        out.push({ url: `data:image/png;base64,${d['b64_json']}` });
      }
    }
  }
  if (typeof root['b64_json'] === 'string') {
    out.push({ url: `data:image/png;base64,${root['b64_json']}` });
  }

  const output = root['output'];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string') {
        pushTextUrls(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      scanContent(o['content']);
      pushUrl(o['url'], o['alt_text'] ?? o['alt']);
      scanParts(o['images']);
    }
  }

  return out;
}

/** Estimate the byte size of a data/caption URL (used for attachment.size). */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  const payload = dataUrl.slice(comma + 1);
  const header = dataUrl.slice(0, comma);
  if (header.includes(';base64')) {
    return Math.round((payload.length * 3) / 4);
  }
  return payload.length;
}

/**
 * Convert a returned image part into a `NodeAttachment` so it can be stored on
 * a chat node and rendered by the existing attachment UI. The `id` is left
 * empty — the caller assigns a persistent one via `newId()`.
 */
export function imagePartToAttachment(part: LlmImagePart, index: number): NodeAttachment {
  const mime = mimeFromDataUrl(part.url) || (part.url.startsWith('https://') ? 'image/png' : 'application/octet-stream');
  const ext = IMAGE_MIME_EXT[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'png';
  return {
    id: '',
    name: `illustration-${index + 1}.${ext}`,
    mimeType: mime,
    size: estimateDataUrlBytes(part.url),
    dataUrl: part.url
  };
}

/**
 * Turn a plain-text string (e.g. the exact prompt used to generate an image)
 * into a `text/plain` NodeAttachment so it can be stored on the same node as
 * the picture and found later — and so the prompt used for a REFUSED image is
 * preserved even when the model returned nothing. `id` is left empty — the
 * caller assigns a persistent one via `newId()`.
 */
export function textPromptAttachment(name: string, text: string): NodeAttachment {
  const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  return {
    id: '',
    name,
    mimeType: 'text/plain',
    size: text.length,
    dataUrl
  };
}
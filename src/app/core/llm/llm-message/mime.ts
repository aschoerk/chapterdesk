import { NodeAttachment } from '../../../models/chat';

/**
 * MIME / attachment-metadata helpers — pure, no story or message logic.
 * Split out of the former `llm-message.ts` utility bag (see `index.ts`).
 */

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/x-python',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  cc: 'text/plain',
  hpp: 'text/plain',
  cs: 'text/plain',
  php: 'text/plain',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  log: 'text/plain',
  sql: 'text/plain',
  rtf: 'text/rtf'
};

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function inferMimeType(name: string, mimeType?: string | null): string {
  const given = (mimeType || '').trim().toLowerCase();
  if (given && given !== 'application/octet-stream') return given;

  const fromName = EXT_MIME[fileExtension(name)];
  if (fromName) return fromName;

  const fromDataUrl = mimeFromDataUrl(typeof mimeType === 'string' && mimeType.startsWith('data:') ? mimeType : '');
  return fromDataUrl || given || 'application/octet-stream';
}

export function mimeFromDataUrl(dataUrl?: string | null): string | null {
  if (!dataUrl) return null;
  const match = /^data:([^;,]+)/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() || null;
}

export function resolvedMime(attachment: Pick<NodeAttachment, 'name' | 'mimeType' | 'dataUrl'>): string {
  return inferMimeType(
    attachment.name,
    attachment.mimeType || mimeFromDataUrl(attachment.dataUrl) || ''
  );
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export function isTextualMime(mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/sql',
    'application/rtf'
  ].includes(mime);
}

/** Decode a `data:` URL (base64 or percent-encoded) into its text payload. */
export function decodeDataUrlToText(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;

  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const base64 = /;base64/i.test(header);

  try {
    if (base64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}
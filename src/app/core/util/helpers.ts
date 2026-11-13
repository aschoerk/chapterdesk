

/**
 * Whether a piece of text ends like a completed sentence (terminal
 * punctuation, optionally followed by closing quotes/brackets/markdown).
 */
export function isSentenceComplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A trailing markdown/quote character does not count as sentence end —
  // strip the closing punctuation wrappers first and look at the last word.
  return /[.!?…][”"’'）)\]}`*_~]*$/.test(trimmed);
}

/**
 * How many "complete the preceding …" directions may follow each other before
 * the sequence gives up and continues anyway. A completion answer can itself
 * stop mid-sentence, so it is sent again — but only this often, so a model
 * that keeps truncating can never loop forever.
 */
export const MAX_COMPLETION_DIRECTIONS = 2;

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(16);
    c.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

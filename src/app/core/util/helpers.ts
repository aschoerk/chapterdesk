

/**
 * Matches a text ENDING that reads as a finished sentence:
 *
 *   - terminal punctuation (`. ! ? …`), or an emoji / flag pictograph — a
 *     chapter may legitimately close on an emoji ("She just smiled 😊");
 *   - optionally followed by trailing closers: quotes, brackets, markdown
 *     emphasis and the invisible parts of an emoji (variation selectors,
 *     zero-width joiners, skin-tone modifiers), so `"…"`, `**…**` and
 *     joined / modifier emoji all count.
 *
 * A trailing closer alone never makes a text complete — some terminal
 * punctuation or emoji before it must exist.
 */
const SENTENCE_END_RE = new RegExp(
  '(?:[.!?…]|\\p{Extended_Pictographic}|\\p{Regional_Indicator})'
  + '[”"’\'）)\\]}`*_~\\uFE0F\\u200D\\p{Emoji_Modifier}'
  + '\\p{Regional_Indicator}\\p{Extended_Pictographic}]*$',
  'u'
);

/**
 * Whether a piece of text ends like a completed sentence — with terminal
 * punctuation or an emoji, optionally followed by closing quotes / brackets /
 * markdown emphasis. Empty (or whitespace-only) text is NOT complete.
 */
export function isSentenceComplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return SENTENCE_END_RE.test(trimmed);
}

/**
 * How many "complete the preceding …" directions may be sent per gap before
 * the sequence continues anyway. ONE means a truncated answer is completed
 * exactly once; if the completion is truncated as well, the sequence moves on
 * and the truncated text simply stays in the story. Keeping this at 1 avoids
 * the completion repeating itself.
 */
export const MAX_COMPLETION_DIRECTIONS = 1;

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

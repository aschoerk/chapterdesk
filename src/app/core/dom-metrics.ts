/**
 * dom-metrics.ts
 *
 * Shared DOM measurement helpers for the text editor and the conversation
 * page. A textarea's caret/ranges are hard to position reliably because
 * WRAPPED lines are not addressable as DOM rows — `rowsBefore * lineHeight`
 * underestimates the vertical position of any character in a wrapped
 * paragraph. Instead, a hidden DIV that duplicates the textarea's box + font
 * metrics wraps text identically, so a zero-width marker placed at a
 * character offset can be measured vertically with pixel accuracy.
 */

export interface TextareaCharMetrics {
  /**
   * The character's Y inside the textarea CONTENT box — that is, the
   * `scrollTop` value that would place its line at the very top of the
   * textarea's visible area.
   */
  contentTop: number;
  /** Top padding of the textarea (px). */
  paddingTop: number;
  /** Effective line height (px). */
  lineHeight: number;
}

/** Textarea metrics that affect how text wraps / lays out. */
const MIRROR_PROPS = [
  'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textTransform', 'wordSpacing', 'whiteSpace', 'wordWrap', 'wordBreak', 'tabSize',
] as const;

/**
 * A hidden div that duplicates a textarea's box + font metrics so a character
 * offset can be measured as a vertical position.
 */
function textareaMirror(ta: HTMLTextAreaElement): HTMLDivElement {
  const mirror = document.createElement('div');
  const style = getComputedStyle(ta);
  // Copy via camel-CASE property assignment. `style.setProperty` expects
  // kebab-case names (box-sizing, padding-top, …) and silently ignores
  // camelCase — so all copied metrics would be lost.
  for (const p of MIRROR_PROPS) {
    const v = (style as unknown as Record<string, string>)[p];
    if (v) (mirror.style as unknown as Record<string, string>)[p] = v;
  }
  // The textarea is a content-box element, so clientWidth (which already
  // excludes the vertical scrollbar and the border) is the exact width the
  // text wraps at; the mirror has no border, so a border-box width of
  // clientWidth reproduces the same wrap.
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.position = 'fixed';
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.height = 'auto';
  return mirror;
}

/**
 * Measure the vertical position of the character at `offset` inside `ta`,
 * accounting for word-wrapping. Returns null when there is nothing measurable
 * (empty value / no layout, e.g. jsdom).
 */
export function textareaCharMetrics(
  ta: HTMLTextAreaElement,
  offset: number
): TextareaCharMetrics | null {
  const text = ta.value ?? '';
  const clamped = Math.max(0, Math.min(offset, text.length));
  const mirror = textareaMirror(ta);
  mirror.appendChild(document.createTextNode(text.slice(0, clamped)));
  const marker = document.createElement('span');
  marker.textContent = '\u200B'; // zero-width space → marks the offset character's line
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    const paddingTop = parseFloat(mirror.style.paddingTop) || 0;
    const lineHeight = parseFloat(mirror.style.lineHeight) || 16;
    return {
      paddingTop,
      lineHeight,
      // marker.offsetTop is measured from the mirror's padding box (includes
      // the top padding); a textarea's scrollTop is relative to its CONTENT
      // box, so the padding is subtracted.
      contentTop: Math.max(0, marker.offsetTop - paddingTop),
    };
  } finally {
    document.body.removeChild(mirror);
  }
}

/**
 * The nearest ancestor of `el` that scrolls vertically (overflow-y auto/scroll
 * with overflowing content), falling back to the document scroller.
 */
export function nearestScrollParent(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const style = getComputedStyle(cur);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}
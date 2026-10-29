/**
 * editor-scroll.ts
 *
 * DOM helpers for the chat-node editor's scroll continuity (read-only view →
 * editor textarea) and the live-stream follow scroll. Engineered as pure
 * module functions (like the shared `dom-metrics.ts`): the component passes
 * its own element refs and the shared `nearestScrollParent` look-up so the
 * code stays testable and the component stays thin.
 */
import { textareaCharMetrics } from '../../core/util/dom-metrics';
import { markerMapOf, markFragmentInSource, squash } from '../../core/util/mark-fragment';

/**
 * The vertical band that counts as "visible" for `el`: the band of its nearest
 * scrollable ancestor when it has one, otherwise the whole viewport.
 */
export function visibleRoBand(
  el: HTMLElement,
  scrollParentOf: (el: HTMLElement) => HTMLElement | null
): { top: number; bottom: number } {
  const scroller = scrollParentOf(el);
  if (scroller) {
    const r = scroller.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * The text sitting at the top of `root`'s visible band, extended forward so it
 * is long enough to locate uniquely in the markdown source (see
 * `markFragmentInSource`). Returns null when no text node is visible.
 */
export function firstVisibleRoText(
  root: HTMLElement,
  clip: { top: number; bottom: number }
): string | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let anchor: Node | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (!(n.textContent ?? '').trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    // jsdom exposes no layout metrics — getBoundingClientRect may be missing
    // there; a missing/empty rect just means "not measurable → skip".
    const rect = range.getBoundingClientRect?.();
    if (!rect || (!rect.height && !rect.width)) continue;
    if (rect.bottom <= clip.top) continue; // fully above the visible band
    if (rect.top >= clip.bottom) break; // below the band — nothing visible
    anchor = n;
    break;
  }
  if (!anchor) return null;

  // Extend the fragment from the anchor forward (~120 chars) so it maps back
  // to the source unambiguously.
  const parts: string[] = [];
  let len = 0;
  const collect = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let collecting = false;
  let m: Node | null;
  while ((m = collect.nextNode())) {
    if (m === anchor) collecting = true;
    if (!collecting) continue;
    const t = (m.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    parts.push(t);
    len += t.length + 1;
    if (len >= 120) break;
  }
  return parts.join(' ');
}

/**
 * The source offset of the text that is currently the FIRST visible one in the
 * read-only content element (the sentence sitting at the top of the visible
 * area). Returns null when there is nothing to restore (no rendered content,
 * nothing visible) — the editor then simply starts at the top.
 */
export function captureRoSourceOffset(
  contentEl: HTMLElement | null | undefined,
  source: string,
  scrollParentOf: (el: HTMLElement) => HTMLElement | null
): number | null {
  if (!contentEl) return null;
  if (!source.trim()) return null;
  const clip = visibleRoBand(contentEl, scrollParentOf);
  const fragment = firstVisibleRoText(contentEl, clip);
  if (!fragment) return null;
  const loc = markFragmentInSource(source, fragment);
  return loc ? loc.index : null;
}

/**
 * The source offset of the character the user clicked inside the read-only
 * content element (`root`). Uses a caret range at the click point to find the
 * rendered text node + offset, builds a fragment starting there, and maps it
 * back to the markdown source via the marker map (normalized text → source
 * offset). Returns null when the click cannot be mapped (no text at the point
 * — blank area / image — or no layout, e.g. jsdom).
 */
export function sourceOffsetAtPoint(
  root: HTMLElement | null | undefined,
  source: string,
  clientX: number,
  clientY: number
): number | null {
  if (!root || !source.trim()) return null;
  const caret = caretRangeAtPoint(clientX, clientY);
  if (!caret) return null;
  const container = caret.startContainer;
  let textNode: Node | null = null;
  let inText = 0;
  if (container.nodeType === Node.TEXT_NODE) {
    textNode = container;
    inText = caret.startOffset;
  } else if (container.nodeType === Node.ELEMENT_NODE) {
    // Click on block padding / between blocks: the caret lands on the element
    // (offset = child index at the point). Anchor on the text nearest it.
    textNode = textNodeNear(container as Element, caret.startOffset);
  }
  if (!textNode) return null;
  const fragment = fragmentFromTextNode(root, textNode, inText);
  if (!fragment) return null;
  // Map the fragment back to the source via the marker map (normalized text →
  // source offset). Unlike `markFragmentInSource` we do NOT fold emphasis
  // markers into the range: that folding is meant for rewrite replacement
  // (remove both `**` when replacing a selection) and would shift the caret
  // BEFORE the opening marker. For caret placement the raw source offset of
  // the clicked character is what we want — e.g. clicking bold text puts the
  // caret right AFTER the `**`, at the start of the visible text.
  const map = markerMapOf(source);
  const nf = squash(fragment);
  if (!nf) return null;
  const idx = map.text.indexOf(nf);
  if (idx < 0) return null;
  return map.sourceOf[idx];
}

/** A caret range at the given viewport point (Chrome/Safari + Firefox). */
function caretRangeAtPoint(clientX: number, clientY: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) =>
      { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === 'function') {
    return doc.caretRangeFromPoint(clientX, clientY);
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (!pos) return null;
    const range = doc.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    return range;
  }
  return null;
}

/** The first text node at/after the child index `offset` inside `el`. */
function textNodeNear(el: Element, offset: number): Node | null {
  const children = el.childNodes;
  // The caret offset is the child index at the point; the point often sits on
  // the boundary between blocks, so check the child, its predecessor and its
  // successor.
  const candidates = [children[offset], children[offset - 1], children[offset + 1]];
  for (const c of candidates) {
    if (!c) continue;
    if (c.nodeType === Node.TEXT_NODE) return c;
    if (c.nodeType === Node.ELEMENT_NODE) {
      const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      if (first) return first;
    }
  }
  return null;
}

/**
 * The rendered text starting at `offset` inside `textNode`, extended forward
 * (~120 chars) so it maps back to the source unambiguously (mirrors
 * `firstVisibleRoText`, but starts at the caret instead of the top of the
 * visible band). Returns null when nothing readable follows.
 */
function fragmentFromTextNode(
  root: HTMLElement,
  textNode: Node,
  offset: number
): string | null {
  const parts: string[] = [];
  let len = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let collecting = false;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n === textNode) {
      collecting = true;
      const t = (n.textContent ?? '').slice(offset).replace(/\s+/g, ' ').trim();
      if (t) {
        parts.push(t);
        len += t.length + 1;
      }
      continue;
    }
    if (!collecting) continue;
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    parts.push(t);
    len += t.length + 1;
    if (len >= 120) break;
  }
  const fragment = parts.join(' ');
  return fragment.trim() ? fragment : null;
}

/**
 * The scrollTop that would place the character at `offset` (of `draft`) at
 * the FIRST visible line of the editor, or null when not measurable (empty
 * draft / no layout). A hidden mirror div that duplicates the textarea's box
 * + font metrics measures the vertical position of that character; the
 * textarea's scrollTop is relative to its CONTENT box, so the top padding is
 * subtracted to land the line at the very top.
 */
export function scrollTopForOffset(
  textarea: HTMLTextAreaElement,
  offset: number,
  draft: string
): number | null {
  if (!draft) return null;
  const clamped = Math.max(0, Math.min(offset, draft.length));
  if (clamped === 0) return 0;
  const metrics = textareaCharMetrics(textarea, clamped);
  return metrics ? Math.max(0, metrics.contentTop) : null;
}

/**
 * Scroll the editor textarea so the character at `offset` in the draft is its
 * first visible line (mirroring the ro view's top sentence). A hidden mirror
 * div reproduces the textarea's box + font metrics to measure the vertical
 * position of that character; the browser clamps the scrollTop.
 */
export function scrollTextareaToOffset(
  textarea: HTMLTextAreaElement,
  offset: number,
  draft: string
): void {
  const st = scrollTopForOffset(textarea, offset, draft);
  if (st != null) textarea.scrollTop = st;
}

/**
 * Make sure the TOP of the editor textarea is visible in the outer scroll
 * container — at least the upper part must be on screen, even when the node
 * sits deep in the conversation or the textarea is taller than the visible
 * band. Only scrolls the OUTER container (the textarea's own scrollTop is the
 * scroll-continuity restore and is left untouched). A tiny top margin keeps
 * the first line from being flush with the very edge. Never scrolls when the
 * top is already visible and on screen.
 */
export function ensureEditorTopOnScreen(
  textarea: HTMLTextAreaElement,
  scrollParentOf: (el: HTMLElement) => HTMLElement | null
): void {
  const scroller = scrollParentOf(textarea);
  if (!scroller) return;
  const sRect = scroller.getBoundingClientRect();
  // No real layout (jsdom/tests): nothing measurable, leave the container alone.
  if (!sRect.width && !sRect.height) return;
  const tRect = textarea.getBoundingClientRect();
  if (!tRect.width && !tRect.height) return;
  const TOP_MARGIN = 8;
  const topTarget = sRect.top + TOP_MARGIN;
  // Bring the top into view when it is above the visible band (scrolled past)
  // OR the whole textarea is below it. Both collapse to one delta: a textarea
  // at viewport Y `tRect.top` lands at `topTarget` after changing the scrollTop
  // by `tRect.top - topTarget` (increasing scrollTop moves content UP, so a
  // textarea hidden ABOVE the fold needs a NEGATIVE delta to pull it back down
  // into view; one scrolled below the fold needs a positive delta). The browser
  // clamps to the container's scroll range.
  if (tRect.top < topTarget || tRect.top >= sRect.bottom) {
    scroller.scrollTop += tRect.top - topTarget;
  }
}

/**
 * Live-stream follow scroll: keep the streamed answer's anchor (its bottom
 * edge) visible inside its nearest scroll container, so the page never jumps
 * while text streams in.
 */
export function followLiveScroll(
  anchor: HTMLElement,
  scrollParentOf: (el: HTMLElement) => HTMLElement | null
): void {
  const scroller = scrollParentOf(anchor);
  if (!scroller) {
    anchor.scrollIntoView({ block: 'end', inline: 'nearest' });
    return;
  }
  const a = anchor.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  if (a.bottom > s.bottom - 12 || a.top < s.top + 12) {
    const nextTop = scroller.scrollTop + (a.bottom - s.bottom) + 16;
    scroller.scrollTop = Math.max(0, nextTop);
  }
}
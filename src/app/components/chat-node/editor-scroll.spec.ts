import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findTextRange, selectRangeAndScroll, sourceOffsetAtPoint } from './editor-scroll';

describe('sourceOffsetAtPoint (click-to-edit caret)', () => {
  let root: HTMLElement;
  let original: unknown;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    original = (document as any).caretRangeFromPoint;
  });

  afterEach(() => {
    root.remove();
    if (original === undefined) {
      delete (document as any).caretRangeFromPoint;
    } else {
      (document as any).caretRangeFromPoint = original;
    }
  });

  /** Point the (stubbed) caret-range look-up at a text node + offset. */
  function caretAt(textNode: Node, offset: number): void {
    (document as any).caretRangeFromPoint = vi.fn(() => {
      const range = document.createRange();
      range.setStart(textNode, offset);
      return range;
    });
  }

  it('maps a click on a plain paragraph to the source offset', () => {
    root.innerHTML = '<p>The hero enters the old tower.</p>';
    const textNode = root.querySelector('p')!.firstChild!;
    caretAt(textNode, 4); // "hero"
    const source = 'The hero enters the old tower.';
    expect(sourceOffsetAtPoint(root, source, 10, 10)).toBe(4);
  });

  it('maps a click mid-word to the exact source offset', () => {
    root.innerHTML = '<p>Hello world, this is a test.</p>';
    const textNode = root.querySelector('p')!.firstChild!;
    caretAt(textNode, 6); // "world"
    const source = 'Hello world, this is a test.';
    expect(sourceOffsetAtPoint(root, source, 10, 10)).toBe(6);
  });

  it('maps through markdown emphasis (caret lands on the visible text)', () => {
    root.innerHTML =
      '<p>The hero enters <strong>the old tower</strong> and climbs.</p>';
    const strong = root.querySelector('strong')!;
    const textNode = strong.firstChild!;
    caretAt(textNode, 0); // "the old tower"
    const source = 'The hero enters **the old tower** and climbs.';
    // The visible "the old tower" starts at source offset 18 (after the **).
    expect(sourceOffsetAtPoint(root, source, 10, 10)).toBe(
      source.indexOf('the old tower'),
    );
  });

  it('returns null when the click lands on no text (empty root)', () => {
    caretAt(document.body, 0);
    expect(sourceOffsetAtPoint(root, 'Some source', 10, 10)).toBeNull();
  });

  it('returns null when the caret look-up is unavailable (jsdom default)', () => {
    // No caretRangeFromPoint stub → the look-up is missing → null.
    expect(sourceOffsetAtPoint(root, 'Some source', 10, 10)).toBeNull();
  });
});

describe('findTextRange — locate a stored mark in the RENDERED text', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => root.remove());

  /** The plain text of a range (looked up through the DOM, not the source). */
  function textOf(range: Range | null): string {
    return range ? range.toString() : '';
  }

  it('finds a plain quote', () => {
    root.innerHTML = '<p>The hero enters the old tower.</p>';
    const range = findTextRange(root, 'old tower');
    expect(textOf(range)).toBe('old tower');
  });

  it('finds text inside inline markdown elements', () => {
    root.innerHTML = '<p>The hero enters <strong>the old tower</strong> and climbs.</p>';
    expect(textOf(findTextRange(root, 'the old tower'))).toBe('the old tower');
  });

  it('ignores whitespace differences (collapsed rendering vs source newlines)', () => {
    root.innerHTML = '<p>Rain ticked\n   the glass<br>softly.</p>';
    const range = findTextRange(root, 'ticked the glass');
    expect(range).not.toBeNull();
    // `toString()` returns the RAW DOM text (newlines kept) — compare normalized.
    expect(textOf(range).replace(/\s+/g, ' ').trim()).toBe('ticked the glass');
  });

  it('spans two blocks when the quote covers both', () => {
    root.innerHTML = '<p>first line</p><p>second line</p>';
    const range = findTextRange(root, 'line second');
    expect(range).not.toBeNull();
    // The range starts at the end of the first paragraph and ends inside the
    // second (the paragraph break itself is not a text character).
    expect(range!.startContainer.textContent).toBe('first line');
    expect(range!.startOffset).toBe(6);
    expect(range!.endContainer.textContent).toBe('second line');
    expect(range!.endOffset).toBe(6);
  });

  it('returns null when the text is gone (section was edited)', () => {
    root.innerHTML = '<p>Something completely different.</p>';
    expect(findTextRange(root, 'old tower')).toBeNull();
  });

  it('returns null for an empty needle or missing root', () => {
    root.innerHTML = '<p>text</p>';
    expect(findTextRange(root, '   ')).toBeNull();
    expect(findTextRange(null, 'text')).toBeNull();
  });
});

describe('selectRangeAndScroll', () => {
  it('selects the range in the document', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>The old tower stood.</p>';
    document.body.appendChild(root);
    const range = findTextRange(root, 'old tower')!;

    selectRangeAndScroll(range, () => null);

    expect(window.getSelection()?.toString()).toBe('old tower');
    root.remove();
  });
});
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sourceOffsetAtPoint } from './editor-scroll';

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
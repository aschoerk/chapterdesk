import { describe, it, expect, beforeEach } from 'vitest';
import { ChatNavSelectionService } from './chat-nav-selection.service';
import { makeNode } from '../../../../test-helpers/factories';

describe('ChatNavSelectionService', () => {
  let service: ChatNavSelectionService;

  beforeEach(() => {
    service = new ChatNavSelectionService();
  });

  /** A chain of nodes from plain ids. */
  const pathOf = (ids: string[]) => ids.map(id => makeNode({ id }));
  /** The empty terminal "direction" node can never be selected. */
  const isTerminal = (id: string) => id === 'draft';

  it('starts empty', () => {
    expect(service.hasSelection()).toBe(false);
    expect(service.selectedIds()).toEqual([]);
    expect(service.isSelected('x')).toBe(false);
  });

  it('toggles nodes in and out, normalised to a contiguous chain of the path', () => {
    const path = pathOf(['q1', 'a1', 'q2']);
    service.toggle('q1', path, isTerminal);
    expect(service.selectedIds()).toEqual(['q1']);

    // Toggling a second, non-adjacent node spans the gap in between.
    service.toggle('q2', path, isTerminal);
    expect(service.selectedIds()).toEqual(['q1', 'a1', 'q2']);

    // The chain is always the minimal unbroken run covering the selected
    // nodes: toggling one INSIDE the chain has no effect (it stays covered).
    service.toggle('a1', path, isTerminal);
    expect(service.selectedIds()).toEqual(['q1', 'a1', 'q2']);

    // Toggling an EDGE of the chain shrinks it to the remaining nodes.
    service.toggle('q1', path, isTerminal);
    expect(service.selectedIds()).toEqual(['a1', 'q2']);

    // Unselecting the rest one by one empties the selection.
    service.toggle('q2', path, isTerminal);
    expect(service.selectedIds()).toEqual(['a1']);
    service.toggle('a1', path, isTerminal);
    expect(service.selectedIds()).toEqual([]);
  });

  it('never selects the empty terminal direction node', () => {
    const path = pathOf(['q1', 'a1', 'draft']);
    service.toggle('draft', path, isTerminal);
    expect(service.selectedIds()).toEqual([]);

    // A Ctrl+drag range spanning the draft excludes it from the selection.
    service.beginDrag();
    service.setDragAnchor(0);
    service.enterNode(makeNode({ id: 'draft' }), 2, path, isTerminal);
    expect(service.selectedIds()).toEqual(['q1', 'a1']);
    service.endDrag(path, isTerminal);
    expect(service.selectedIds()).toEqual(['q1', 'a1']);
  });

  it('keeps the selection only while the visible chain is unchanged', () => {
    // In the component a reactive effect establishes the path key first —
    // mirror that before selecting.
    service.syncWithPath('chat-1', ['q1', 'a1']);
    service.toggle('q1', pathOf(['q1', 'a1']), isTerminal);
    expect(service.selectedIds()).toEqual(['q1']);

    // Same path → selection is kept.
    service.syncWithPath('chat-1', ['q1', 'a1']);
    expect(service.selectedIds()).toEqual(['q1']);

    // Path changed (chat switch or a child switched) → cleared.
    service.syncWithPath('chat-1', ['a1']);
    expect(service.selectedIds()).toEqual([]);

    service.syncWithPath('chat-2', ['q1']);
    service.toggle('q1', pathOf(['q1']), isTerminal);
    service.syncWithPath('chat-2', ['q1']);
    expect(service.selectedIds()).toEqual(['q1']);
    service.syncWithPath('chat-3', ['q1']); // chat switch clears
    expect(service.selectedIds()).toEqual([]);
  });

  it('normalises a Ctrl+drag range to the minimal chain and keeps it on pointer-up', () => {
    const path = pathOf(['q1', 'a1', 'q2', 'a2', 'draft']);
    service.beginDrag();
    service.setDragAnchor(1); // anchor = a1
    service.enterNode(makeNode({ id: 'q2' }), 2, path, isTerminal);
    expect(service.selectedIds()).toEqual(['a1', 'q2']);

    // The drag moved → pointer-up keeps the range.
    service.endDrag(path, isTerminal);
    expect(service.selectedIds()).toEqual(['a1', 'q2']);
  });

  it('a plain Ctrl+click (no drag) toggles the anchor on pointer-up', () => {
    const path = pathOf(['q1', 'a1']);
    service.beginDrag();
    service.setDragAnchor(1);
    service.endDrag(path, isTerminal);
    expect(service.selectedIds()).toEqual(['a1']);
  });

  it('returns the selected nodes in active-path (top-first) order', () => {
    const path = pathOf(['q1', 'a1', 'q2']);
    service.toggle('q2', path, isTerminal);
    service.toggle('q1', path, isTerminal); // normalises to the whole chain
    const nodes = service.selectedNodes(path, isTerminal);
    expect(nodes.map(x => x.id)).toEqual(['q1', 'a1', 'q2']);
  });

  it('tracks the hovered clipboard target for Ctrl+V paste', () => {
    expect(service.clipboardTargetId()).toBeNull();
    const path = pathOf(['q1', 'a1']);
    service.setDragAnchor(-1);
    service.beginDrag();
    service.enterNode(makeNode({ id: 'a1' }), 1, path, isTerminal);
    expect(service.clipboardTargetId()).toBe('a1');
    service.leaveNode();
    expect(service.clipboardTargetId()).toBeNull();
  });
});
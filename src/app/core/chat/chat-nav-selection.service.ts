import { Injectable, computed, signal } from '@angular/core';
import type { ChatNode } from '../../models/chat';

/**
 * Owns the navbar multi-selection state of the chat page (Ctrl+click /
 * Ctrl+drag over the active path plus the copy / cut / delete / paste of the
 * selected chain). Mirrors the small injectable state services
 * (AttachmentClipboardService / LightboxService): the pure selection state and
 * the drag flow live here; the component feeds in the ACTIVE PATH (via
 * ChatService) and keeps the tree-modifying actions (copy / cut / delete /
 * paste) that operate on that state.
 *
 * The selection is kept as a CONTIGUOUS CHAIN of visible nodes on the active
 * path — whatever toggling / dragging produces is normalised to the minimal
 * unbroken chain covering the involved nodes, so copy / cut / delete always
 * act on one continuous run, kept in top-first (path) order.
 */
@Injectable({ providedIn: 'root' })
export class ChatNavSelectionService {
  /** Ordered ids of the nodes selected in the navbar (subset of the active path). */
  readonly selectedIds = signal<string[]>([]);
  readonly hasSelection = computed(() => this.selectedIds().length > 0);
  /** Navbar node currently under the pointer — target for Ctrl+V paste. */
  readonly clipboardTargetId = signal<string | null>(null);

  private dragActive = false;
  private dragMoved = false;
  private dragAnchor = -1;
  private dragBase = new Set<string>();
  /** Marker for the chat + active-path the current selection refers to.
   *  Any change (chat switch or a switched child) clears the selection. */
  private pathKey = '';

  isSelected(id: string): boolean {
    return this.selectedIds().includes(id);
  }

  /**
   * Keep the selection only while it refers to the given visible chain: any
   * change (chat switch or a switched child) clears the selection plus the
   * hovered clipboard target. Called from a reactive effect so the path is
   * re-read on every tree change.
   */
  syncWithPath(chatId: string | null, pathIds: string[]): void {
    const key = `${chatId ?? ''}::${pathIds.join('\u0000')}`;
    if (key !== this.pathKey) {
      this.pathKey = key;
      if (this.selectedIds().length > 0) {
        this.selectedIds.set([]);
        this.clipboardTargetId.set(null);
      }
    }
  }

  /** Toggle `id` in the selection, normalised to a contiguous chain. */
  toggle(id: string, path: ChatNode[], isTerminal: (id: string) => boolean): void {
    if (isTerminal(id)) return;
    const cur = this.selectedIds();
    this.apply(
      cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id],
      path,
      isTerminal
    );
  }

  clear(): void {
    this.selectedIds.set([]);
  }

  /**
   * Normalise the given ids to the minimal unbroken chain of `path`: whatever
   * toggling / dragging produces is collapsed to the span [lo..hi] covering
   * the involved nodes, with terminal (empty direction) nodes always excluded.
   */
  apply(
    ids: string[],
    path: ChatNode[],
    isTerminal: (id: string) => boolean
  ): void {
    if (!ids.length) {
      this.selectedIds.set([]);
      return;
    }
    const index = new Map(path.map((n, i) => [n.id, i]));
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      const i = index.get(id);
      if (i === undefined) continue;
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
    if (hi < lo) {
      this.selectedIds.set([]);
      return;
    }
    this.selectedIds.set(
      path
        .slice(lo, hi + 1)
        .filter(n => !isTerminal(n.id))
        .map(n => n.id)
    );
  }

  /** The selected nodes in active-path (top-first) order. */
  selectedNodes(path: ChatNode[], isTerminal: (id: string) => boolean): ChatNode[] {
    const selected = new Set(this.selectedIds());
    return path.filter(n => selected.has(n.id));
  }

  /** Ctrl+pointerdown over a nav node — start the drag flow (anchor set after). */
  beginDrag(): void {
    this.dragActive = true;
    this.dragMoved = false;
    this.dragBase = new Set(this.selectedIds());
    this.dragAnchor = -1;
  }

  setDragAnchor(nodeIndex: number): void {
    this.dragAnchor = nodeIndex;
  }

  /**
   * Pointer entered a nav node — tracks hover and extends a ctrl+drag range:
   * the span [anchor..entered] is merged into the selection base, normalised
   * to a contiguous chain of the path.
   */
  enterNode(
    node: ChatNode,
    index: number,
    path: ChatNode[],
    isTerminal: (id: string) => boolean
  ): void {
    this.clipboardTargetId.set(node.id);
    if (!this.dragActive) return;
    if (index < 0) return;
    this.dragMoved = true;
    const lo = Math.min(this.dragAnchor, index);
    const hi = Math.max(this.dragAnchor, index);
    const range = new Set(path.slice(lo, hi + 1).map(n => n.id));
    const merged = new Set(this.dragBase);
    for (const id of range) merged.add(id);
    this.apply(
      path.filter(n => merged.has(n.id)).map(n => n.id),
      path,
      isTerminal
    );
  }

  leaveNode(): void {
    this.clipboardTargetId.set(null);
  }

  /**
   * Document pointerup: end the drag. A plain Ctrl+click (no drag) toggles the
   * anchor node; a real drag keeps the merged range.
   */
  endDrag(path: ChatNode[], isTerminal: (id: string) => boolean): void {
    if (!this.dragActive) return;
    this.dragActive = false;
    if (this.dragMoved) return;
    const anchor = path[this.dragAnchor];
    if (anchor) this.toggle(anchor.id, path, isTerminal);
  }
}
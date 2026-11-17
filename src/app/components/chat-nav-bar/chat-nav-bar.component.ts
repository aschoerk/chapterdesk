import {
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
  inject,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatNode } from '../../models/chat';
import { ChatService } from '../../core/chat/chat.service';
import { isChatLoreNode, loreTextOf } from '../../core/chat/chat-lore.service';
import { ChatNavSelectionService } from '../../core/chat/chat-nav-selection.service';
import { ChatLayoutPrefsService } from '../../core/chat/chat-layout-prefs.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodeClipboardService } from '../../core/clipboard/node-clipboard.service';
import { ChatNavMenuService, type ChatNavMenuHost, type NavMenuEntry } from '../../core/chat/chat-nav-menu.service';

/**
 * The chat page's node-nav-bar: active path + multi-select tools.
 *
 * Extracted from `ChatComponent` so the page stays a thin delegate. The
 * component owns:
 *   - the `.node-nav-bar` row rendering (active path, badges, branch counts),
 *   - multi-selection (ctrl+click / ctrl+drag) over the active path,
 *   - the vertical resizer between the bar and the tree,
 *   - the two right-click context menus (paste-after / node actions).
 *
 * The PAGE keeps ownership of the tree mutation actions (cut/delete/extract/
 * paste) because they touch the chat service, clipboard and dialogs — the
 * component emits them upward instead of performing them.
 */
@Component({
  selector: 'app-chat-nav-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './chat-nav-bar.component.html',
  styleUrl: './chat-nav-bar.component.css',
})
export class ChatNavBarComponent implements ChatNavMenuHost {
  private readonly chatService = inject(ChatService);
  private readonly navSelection = inject(ChatNavSelectionService);
  private readonly layoutPrefs = inject(ChatLayoutPrefsService);
  private readonly clipboardRef = inject(NodeClipboardService);
  private readonly navMenu = inject(ChatNavMenuService);
  readonly i18n = inject(I18nService);
  /** Node clipboard — the template asks whether pasting is possible. */
  readonly clipboard = this.clipboardRef;

  // ------------------------------------------------------------------
  // Inputs — the active path as the page computed it, plus the mark state
  // ------------------------------------------------------------------

  /** The FULL active path (page's `getActivePath()`). The bar renders only the
   *  visible nodes, but the hidden ones are kept here so marks (the "being
   *  edited" point, the "current" frame) can fall back to the next visible
   *  node exactly like the old inline bar did. */
  readonly activePath = input.required<ChatNode[]>();
  /** The path as RENDERED: nodes excluded from the model context are hidden
   *  UNLESS they sit in a branch (have siblings) — same filter as the page's
   *  `navPath()`. */
  readonly visibleNavPath = computed(() => this.activePath().filter(n => this.isNavVisible(n)));

  /**
   * The nav-bar's render list. Lore milestones are always visible (see
   * `isNavVisible`), but IDENTICAL lore repeats are hidden: only the FIRST
   * appearance of each distinct lore text is shown, and repeats stay hidden
   * until the lore content changes. The bar therefore reads as the canon's
   * evolution — one ⟡ pill per change — instead of a lore pill per send.
   */
  readonly navPathEntries = computed<ChatNode[]>(() => {
    const out: ChatNode[] = [];
    let lastLoreText: string | null = null;
    for (const n of this.visibleNavPath()) {
      if (isChatLoreNode(n)) {
        const text = loreTextOf(n);
        if (text === lastLoreText) continue;
        lastLoreText = text;
      }
      out.push(n);
    }
    return out;
  });

  /** Nodes whose blocks are currently visible in the tree viewport (page's
   *  `visibleNodeIds`). Each of them carries the "current" frame — a long
   *  chapter sharing the viewport with the next node keeps BOTH marked. */
  readonly visibleNodeIds = input<string[]>([]);
  /** Node currently open in the editor (page's edit session). */
  readonly editingNodeId = input<string | null>(null);

  // ------------------------------------------------------------------
  // Outputs — actions the page owns (tree mutation + navigation)
  // ------------------------------------------------------------------

  /** Plain click on a nav node → scroll the tree to it. */
  readonly scrollToNode = output<string>();
  /** Copy the selected chain to the node clipboard. */
  readonly copySelection = output<void>();
  /** Cut the selected chain (page confirms + mutates). */
  readonly cutSelection = output<void>();
  /** Extract the selected chain into a new story. */
  readonly extractSelection = output<boolean>();
  /** Delete the selected chain. */
  readonly deleteSelection = output<void>();
  /** Paste the clipboard at the very top of the story. */
  readonly pasteAtTop = output<void>();
  /** Paste the clipboard chain after `nodeId` in the active path. */
  readonly pasteAfter = output<string>();
  /** Paste the clipboard chain before `nodeId` in the active path. */
  readonly pasteBefore = output<string>();
  /** Splice (`insert`) or branch (`append`) the clipboard chain between the two
   *  visible nodes around a paste button (paste-menu action). */
  readonly pasteChain = output<{ mode: 'insert' | 'append'; leftId: string; rightId: string | null }>();
  /** Start a parallel branch at `node`. */
  readonly startBranch = output<ChatNode>();
  /** Switch the active continuation of `node.parentId` by `dir`. */
  readonly switchSibling = output<{ node: ChatNode; dir: -1 | 1 }>();
  /** Copy a single node (context menu action). */
  readonly copyNode = output<ChatNode>();
  /** Cut a single node (context menu action). */
  readonly cutNode = output<ChatNode>();
  /** Delete a single node (context menu action). */
  readonly deleteNode = output<ChatNode>();

  // ------------------------------------------------------------------
  // Re-exported selection state (the template reads these directly)
  // ------------------------------------------------------------------

  readonly navSelectedIds = this.navSelection.selectedIds;
  readonly navHasSelection = this.navSelection.hasSelection;
  readonly navClipboardTargetId = this.navSelection.clipboardTargetId;

  readonly navBarHeight = this.layoutPrefs.navBarHeight;
  readonly isNavResizing = this.layoutPrefs.isNavResizing;

  /** The node-nav-bar element — measured at drag start for the baseline height. */
  private readonly nodeNavBar = viewChild<ElementRef<HTMLElement>>('nodeNavBar');

  // ------------------------------------------------------------------
  // Context menus
  // ------------------------------------------------------------------

  readonly navPasteMenu = this.navMenu.navPasteMenu;
  readonly navNodeMenu = this.navMenu.navNodeMenu;

  constructor() {
    // This bar is the menu's HOST: the selection ops run here, the tree
    // mutations are emitted to the page (see `ChatNavMenuHost` below).
    this.navMenu.bind(this);
  }

  // ------------------------------------------------------------------
  // Selection helpers
  // ------------------------------------------------------------------

  isNavNodeSelected(id: string): boolean {
    return this.navSelection.isSelected(id);
  }

  isNavNodeBeingEdited(id: string): boolean {
    const editingId = this.editingNodeId();
    if (editingId === null) return false;
    return this.navMarkFallback(editingId) === id;
  }

  /**
   * Map a target node id to the VISIBLE navbar node that should carry its
   * mark. Hidden nodes (excluded from context AND not part of a branch) are
   * absent from the navbar, so their mark falls to the next visible node.
   */
  private navMarkFallback(id: string | null): string | null {
    if (!id) return null;
    const path = this.activePath();
    const i = path.findIndex(n => n.id === id);
    if (i < 0) return null;
    for (let k = i; k < path.length; k++) {
      if (this.isNavVisible(path[k])) return path[k].id;
    }
    return null;
  }

  /** A node appears in the navbar when it is included in the model context,
   *  or when it is excluded but has siblings. Lore milestones are the path's
   *  anatomy, not the model context: they stay in the bar even after they were
   *  sent (excluded) — that transparency is the point of the lore pill. */
  private isNavVisible(n: ChatNode): boolean {
    if (isChatLoreNode(n)) return true;
    return !n.excludeFromContext || this.getChildren(n.parentId ?? null).length > 1;
  }

  /** True for a materialized chat-lore node. */
  isLoreNode(node: ChatNode): boolean {
    return isChatLoreNode(node);
  }

  /** Lore node still armed: it ships with the next direction. */
  isLoreArmed(node: ChatNode): boolean {
    return isChatLoreNode(node) && !node.excludeFromContext;
  }

  /** Lore node already sent / deactivated: documented, no longer shipped. */
  isLoreDocumented(node: ChatNode): boolean {
    return isChatLoreNode(node) && !!node.excludeFromContext;
  }

  /** The nav badge of a node (⟡ for lore, else D/C/S). */
  navBadge(node: ChatNode): string {
    if (isChatLoreNode(node)) return '⟡';
    return node.role === 'user' ? 'D' : node.role === 'assistant' ? 'C' : 'S';
  }

  /** Hover title: lore states in words, other nodes their text. */
  navNodeTitle(node: ChatNode): string {
    if (isChatLoreNode(node)) {
      return node.excludeFromContext
        ? this.i18n.t('node.loreDocumentedTitle')
        : this.i18n.t('node.loreArmedTitle');
    }
    return node.content ?? '';
  }

  /** The nav nodes that currently carry the "current" frame: the fallback of
   *  every node visible in the tree viewport (plus the edited node while one
   *  is open). Hidden nodes fall to the next visible nav node, so several
   *  visible nodes can share one frame. */
  readonly markedNavIds = computed<string[]>(() => {
    const out: string[] = [];
    const add = (id: string | null) => {
      const fb = this.navMarkFallback(id);
      if (fb && !out.includes(fb)) out.push(fb);
    };
    const editingId = this.editingNodeId();
    if (editingId !== null) {
      add(editingId);
    } else {
      for (const vid of this.visibleNodeIds()) add(vid);
    }
    return out;
  });

  /** True when the node's block is currently visible in the tree viewport. */
  isNearViewport(id: string): boolean {
    return this.markedNavIds().includes(id);
  }

  // ------------------------------------------------------------------
  // Pointer / click handling
  // ------------------------------------------------------------------

  /** Plain click → scroll to the node; Ctrl+click is handled by pointer down/up. */
  onNavNodeClick(event: MouseEvent, node: ChatNode): void {
    if (event.ctrlKey || event.metaKey) return;
    this.scrollToNode.emit(node.id);
  }

  onNavPointerDown(event: PointerEvent, node: ChatNode): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (this.isLastEmptyDirection(node.id)) return;
    event.preventDefault();
    this.navSelection.beginDrag();
    this.navSelection.setDragAnchor(this.navNodeIndex(node.id));
  }

  /** Fires on pointer-entering a nav node — extends a ctrl+drag and tracks hover. */
  onNavPointerEnter(node: ChatNode): void {
    this.navSelection.enterNode(
      node,
      this.navNodeIndex(node.id),
      this.activePath(),
      (id) => this.isLastEmptyDirection(id),
    );
  }

  onNavPointerLeave(): void {
    this.navSelection.leaveNode();
  }

  @HostListener('document:pointerup', ['$event'])
  onNavDocumentPointerUp(_event: PointerEvent): void {
    this.navSelection.endDrag(
      this.activePath(),
      (id) => this.isLastEmptyDirection(id),
    );
  }

  toggleNavSelection(id: string): void {
    this.navSelection.toggle(id, this.activePath(), (x) => this.isLastEmptyDirection(x));
  }

  clearNavSelection(): void {
    this.navSelection.clear();
  }

  // ------------------------------------------------------------------
  // Selection actions → emitted to the page
  // ------------------------------------------------------------------

  copyNavSelection(): void {
    if (!this.navHasSelection()) return;
    this.copySelection.emit();
  }

  cutNavSelection(): void {
    if (!this.navHasSelection()) return;
    this.cutSelection.emit();
  }

  extractNavSelection(withVisibleSubtree = false): void {
    if (!this.navHasSelection()) return;
    this.extractSelection.emit(withVisibleSubtree);
  }

  deleteNavSelection(): void {
    if (!this.navHasSelection()) return;
    this.deleteSelection.emit();
  }

  pasteAtTopClick(): void {
    this.pasteAtTop.emit();
  }

  // ------------------------------------------------------------------
  // Paste buttons
  // ------------------------------------------------------------------

  /** The navbar paste button appears after this node only when pasting there
   *  is allowed (never left of the empty terminal direction node). */
  canPasteAfter(node: ChatNode): boolean {
    return this.navMenu.pasteTargets(node.id) !== null;
  }

  pasteNavSelectionAfter(nodeId: string): void {
    this.pasteAfter.emit(nodeId);
  }

  /** Also a `ChatNavMenuHost` action (node-menu "paste in front"). */
  pasteNavSelectionBefore(node: ChatNode): void {
    this.pasteBefore.emit(node.id);
  }

  // ------------------------------------------------------------------
  // `ChatNavMenuHost` — the remaining menu actions. Selection ops
  // (toggle/clear) run locally; every tree mutation is emitted upward,
  // the PAGE performs it (chat service / clipboard / dialogs).
  // ------------------------------------------------------------------

  /** The menu only ever sees the VISIBLE navbar nodes. */
  navPath(): ChatNode[] {
    return this.visibleNavPath();
  }

  startBranchAt(node: ChatNode): void {
    this.startBranch.emit(node);
  }

  switchNavSibling(node: ChatNode, dir: -1 | 1): void {
    this.switchSibling.emit({ node, dir });
  }

  copyNavNodes(node: ChatNode): void {
    this.copyNode.emit(node);
  }

  cutNavNodes(node: ChatNode): void {
    this.cutNode.emit(node);
  }

  deleteNavNodes(node: ChatNode): void {
    this.deleteNode.emit(node);
  }

  pasteChainInto(mode: 'insert' | 'append', leftId: string, rightId: string | null): void {
    this.pasteChain.emit({ mode, leftId, rightId });
  }

  // ------------------------------------------------------------------
  // Context menus — open/close + geometry delegates
  // ------------------------------------------------------------------

  openNavPasteMenu(event: MouseEvent, node: ChatNode): void {
    this.navMenu.openPasteMenu(event, node);
  }

  closeNavPasteMenu(): void {
    this.navMenu.closePasteMenu();
  }

  navPasteMenuLeftPx(): number {
    return this.navMenu.pasteMenuLeftPx();
  }

  navPasteMenuTopPx(): number {
    return this.navMenu.pasteMenuTopPx();
  }

  navPasteMenuItems(menu: { leftId: string; rightId: string | null }): NavMenuEntry[] {
    return this.navMenu.pasteMenuItems(menu);
  }

  openNavNodeMenu(event: MouseEvent, node: ChatNode): void {
    this.navMenu.openNodeMenu(event, node);
  }

  closeNavNodeMenu(): void {
    this.navMenu.closeNodeMenu();
  }

  navNodeMenuLeftPx(): number {
    return this.navMenu.nodeMenuLeftPx();
  }

  navNodeMenuTopPx(): number {
    return this.navMenu.nodeMenuTopPx();
  }

  navNodeMenuItems(): NavMenuEntry[] {
    return this.navMenu.nodeMenuItems();
  }

  /** Close the menu, then run the chosen action (if it is enabled). */
  runNavNodeAction(item: NavMenuEntry): void | Promise<void> {
    return this.navMenu.runNodeAction(item);
  }

  runNavPasteAction(item: NavMenuEntry): void {
    this.navMenu.runPasteAction(item);
  }

  @HostListener('window:resize')
  onNavNodeMenuResize(): void {
    this.closeNavNodeMenu();
  }

  @HostListener('document:scroll')
  onNavNodeMenuScroll(): void {
    this.closeNavNodeMenu();
  }

  @HostListener('window:resize')
  onNavPasteResize(): void {
    this.closeNavPasteMenu();
  }

  @HostListener('document:scroll')
  onNavPasteScroll(): void {
    this.closeNavPasteMenu();
  }

  // ------------------------------------------------------------------
  // Nav-bar height (vertical resizer)
  // ------------------------------------------------------------------

  private readonly onNavResizePointerMove =
    (e: { clientY: number; preventDefault: () => void }) =>
      this.layoutPrefs.onNavResizePointerMove(e);

  private readonly onNavResizePointerUp = () => this.layoutPrefs.endNavResize();

  startNavResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const el = this.nodeNavBar()?.nativeElement;
    const base = el?.offsetHeight ?? this.navBarHeight() ?? 140;
    this.layoutPrefs.startNavResize(event, base);
  }

  endNavResize(): void {
    this.layoutPrefs.endNavResize();
  }

  /** Double-click on the separator → restore the DEFAULT handling. */
  resetNavBarHeight(): void {
    this.layoutPrefs.resetNavBarHeight();
  }

  /**
   * Default handling — keep every marked node's line visible inside the nav
   * bar's OWN scroll area (the 4-line cap): scroll up when the topmost mark
   * is cut off above, down when the bottommost mark is cut off below.
   */
  scrollNavBarToMarked(): void {
    const bar = this.nodeNavBar()?.nativeElement as HTMLElement | null;
    if (!bar) return;
    const els: HTMLElement[] = [];
    for (const navId of this.markedNavIds()) {
      let el: HTMLElement | null = null;
      try {
        el = bar.querySelector(`[data-nav-id="${CSS.escape(navId)}"]`);
      } catch {
        el = bar.querySelector(`[data-nav-id="${navId}"]`);
      }
      if (el) els.push(el);
    }
    if (els.length === 0) return;
    const barRect = bar.getBoundingClientRect();
    const first = els[0].getBoundingClientRect();
    const last = els[els.length - 1].getBoundingClientRect();
    if (first.top < barRect.top) {
      bar.scrollTop += first.top - barRect.top - 1;
    } else if (last.bottom > barRect.bottom) {
      bar.scrollTop += last.bottom - barRect.bottom + 1;
    }
  }

  // ------------------------------------------------------------------
  // Tree helpers needed by the template
  // ------------------------------------------------------------------

  private getChildren(pid: string | null): ChatNode[] {
    return this.chatService.getChildren(pid);
  }

  getSiblingIndex(node: ChatNode): number {
    const siblings = this.getChildren(node.parentId);
    const idx = siblings.findIndex(s => s.id === node.id);
    return idx >= 0 ? idx + 1 : 1;
  }

  childCount(node: ChatNode): number {
    return this.getChildren(node.parentId).length;
  }

  private navNodeIndex(nodeId: string): number {
    return this.activePath().findIndex(n => n.id === nodeId);
  }

  // ------------------------------------------------------------------
  // Selection word counts (single node vs. whole selected chain)
  // ------------------------------------------------------------------

  /** Count words in a node's own content IF it is an assistant (chapter) node;
   *  directions, structure and lore nodes do not count toward the story word
   *  count. */
  private wordsOfAssistant(node: ChatNode): number {
    if (node.role !== 'assistant') return 0;
    const t = (node.content ?? '').trim();
    if (!t) return 0;
    return t.split(/\s+/).filter(Boolean).length;
  }

  /** All current nodes in the subtree rooted at `rootId` (including root). */
  private subtreeOf(rootId: string): ChatNode[] {
    const all = this.chatService.nodes();
    const out: ChatNode[] = [];
    const walk = (id: string) => {
      const n = all.find(x => x.id === id);
      if (!n) return;
      out.push(n);
      all.filter(x => x.parentId === id).forEach(child => walk(child.id));
    };
    walk(rootId);
    return out;
  }

  /** The selected nodes in active-path (top-first) order. */
  private selectedOrderedNodes(): ChatNode[] {
    const selected = new Set(this.navSelectedIds());
    return this.activePath().filter(n => selected.has(n.id));
  }

  /**
   * Word-count summary for the current selection, shown in the nav tools row.
   * Counts ONLY assistant (chapter) nodes — directions, structure and lore do
   * not contribute words.
   *   - single node → its own words (0 unless it is a chapter) AND its whole
   *     subtree's chapter words.
   *   - a chain (multi-select) → ONLY the chapter words of the assistant nodes
   *     WITHIN the selected chain itself (the selected nodes), NOT the words
   *     of their deeper subtrees.
   * Reactive: re-reads the selection ids and the active path.
   */
  readonly selectionWords = computed<{ node: number; subtree: number }>(() => {
    this.navSelectedIds();
    this.activePath();
    const path = this.selectedOrderedNodes();
    if (path.length === 0) return { node: 0, subtree: 0 };
    if (path.length === 1) {
      const root = path[0];
      const subtree = this.subtreeOf(root.id);
      const words = subtree.reduce((sum, n) => sum + this.wordsOfAssistant(n), 0);
      return { node: this.wordsOfAssistant(root), subtree: words };
    }
    // Chain: words of the assistant nodes within the SELECTED chain only.
    const words = path.reduce((sum, n) => sum + this.wordsOfAssistant(n), 0);
    return { node: 0, subtree: words };
  });

  /** True when exactly one nav node is selected (single-node display). */
  readonly isSingleSelection = computed(() => this.selectedOrderedNodes().length === 1);

  /** Number of assistant (chapter) nodes among the selected nodes. */
  readonly selectedAssistantCount = computed(() =>
    this.selectedOrderedNodes().filter(n => n.role === 'assistant').length,
  );

  /** The empty "direction" node at the very end of the active path. */
  private isLastEmptyDirection(nodeId: string): boolean {
    return this.navMenu.isLastEmptyDirection(nodeId);
  }
}

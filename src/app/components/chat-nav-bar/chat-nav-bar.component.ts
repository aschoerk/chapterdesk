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
import { ChatNavSelectionService } from '../../core/chat/chat-nav-selection.service';
import { ChatLayoutPrefsService } from '../../core/chat/chat-layout-prefs.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodeClipboardService } from '../../core/clipboard/node-clipboard.service';
import { ChatNavMenuService, type NavMenuEntry } from '../../core/chat/chat-nav-menu.service';

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
export class ChatNavBarComponent {
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
  /** Node whose block sits nearest the top of the tree (page's `visibleNodeId`). */
  readonly visibleNodeId = input<string | null>(null);
  /** Node currently open in the editor (page's edit session). */
  readonly editingNodeId = input<string | null>(null);
  /** Whether the page has a current chat (enables the Book view button). */
  readonly hasChat = input(false);

  // ------------------------------------------------------------------
  // Outputs — actions the page owns (tree mutation + navigation)
  // ------------------------------------------------------------------

  /** Plain click on a nav node → scroll the tree to it. */
  readonly scrollToNode = output<string>();
  /** "Open Book view" button. */
  readonly openReader = output<void>();
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
   *  or when it is excluded but has siblings. */
  private isNavVisible(n: ChatNode): boolean {
    return !n.excludeFromContext || this.getChildren(n.parentId ?? null).length > 1;
  }

  /** True when the node's block sits nearest the top of the tree. */
  isNearViewport(id: string): boolean {
    const editingId = this.editingNodeId();
    if (editingId !== null) return this.navMarkFallback(editingId) === id;
    return this.navMarkFallback(this.visibleNodeId()) === id;
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

  pasteNavSelectionBefore(node: ChatNode): void {
    this.pasteBefore.emit(node.id);
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
   * Default handling — keep the marked node's line visible inside the nav
   * bar's OWN scroll area (the 4-line cap).
   */
  scrollNavBarToMarked(markedId: string | null): void {
    const bar = this.nodeNavBar()?.nativeElement as HTMLElement | null;
    if (!bar || !markedId) return;
    let el: HTMLElement | null = null;
    try {
      el = bar.querySelector(`[data-nav-id="${CSS.escape(markedId)}"]`);
    } catch {
      el = bar.querySelector(`[data-nav-id="${markedId}"]`);
    }
    if (!el) return;
    const barRect = bar.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.top < barRect.top) {
      bar.scrollTop += elRect.top - barRect.top - 1;
    } else if (elRect.bottom > barRect.bottom) {
      bar.scrollTop += elRect.bottom - barRect.bottom + 1;
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

  /** The empty "direction" node at the very end of the active path. */
  private isLastEmptyDirection(nodeId: string): boolean {
    return this.navMenu.isLastEmptyDirection(nodeId);
  }
}

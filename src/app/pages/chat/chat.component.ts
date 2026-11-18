import {Component, computed, effect, ElementRef, viewChild, viewChildren, inject, OnInit, signal, HostListener} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat/chat.service';
import { LastModelService } from '../../core/settings/last-model.service';
import { Chat, ChatNode, NodeAttachment, ReadingMark } from '../../models/chat';
import { SettingsService } from '../../core/settings/settings.service';
import { ChatParametersService } from '../../core/chat/chat-parameters.service';
import { ChatParametersEditorComponent } from '../../components/chat-parameters-editor/chat-parameters-editor.component';
import { ChatParametersDraft, ResolvedChatParameters, draftFromParameters, emptyParametersDraft, formatParametersSummary } from '../../models/chat-parameters';
import { ChatTitleEditorComponent } from '../../components/chat-title-editor/chat-title-editor.component';
import { ChatNodeComponent } from '../../components/chat-node/chat-node.component';
import {SideBarComponent} from '../../components/side-bar/side-bar.component';
import {Router} from '@angular/router';
import {ProjectService} from '../../core/settings/project.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { GenerationTaskKind } from '../../models/generation-task';
import { ModelEntry, ProviderConfig } from '../../models/chat-config';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { NodeClipboardService } from '../../core/clipboard/node-clipboard.service';
import { NodeEditSession } from '../../core/chat/node-edit-session';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { PacedReadService } from '../../core/llm/paced-read.service';
import { readingTimeLabel } from '../../core/llm/reading-time';
import { ReadingMarksService } from '../../core/chat/reading-marks.service';
import { SearchReplaceComponent } from '../../components/search-replace/search-replace.component';
import { textareaCharMetrics, TextareaCharMetrics } from '../../core/util/dom-metrics';
import { ChatNavSelectionService } from '../../core/chat/chat-nav-selection.service';
import { ChatLayoutPrefsService } from '../../core/chat/chat-layout-prefs.service';
import { ChatElaborateDialogService } from '../../core/dialogs/chat-elaborate-dialog.service';
import { ChatElaborateService, type ChatElaborateActions } from '../../core/dialogs/chat-elaborate.service';
import { ToastService } from '../../core/toast/toast.service';
import {
  ChatNavMenuService,
  type ChatNavMenuActions,
  type NavMenuEntry,
} from '../../core/chat/chat-nav-menu.service';
import { ChatSearchService, type ChatSearchActions } from '../../core/chat/chat-search.service';
import { ChatPacedReadService } from '../../core/chat/chat-paced-read.service';
import { ChatNavActionsService, type ChatNavActions } from '../../core/chat/chat-nav-actions.service';
import { ChatMarksService, type ChatMarksActions } from '../../core/chat/chat-marks.service';
import { ChatNavBarComponent } from '../../components/chat-nav-bar/chat-nav-bar.component';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatTitleEditorComponent, ChatNodeComponent, SideBarComponent, ChatParametersEditorComponent, SearchReplaceComponent, ChatNavBarComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
  // The navbar context menus + the search/name glue + the navbar operations
  // + the marks handling belong to THIS page (their actions touch its
  // selection, tree and dialogs) — one instance per chat page, not app-wide.
  providers: [ChatNavMenuService, ChatSearchService, ChatPacedReadService, ChatNavActionsService, ChatMarksService]
})
export class ChatComponent implements
  OnInit,
  // The shared public surface the page exposes to its template/specs and the
  // services implement internally — both sides are compile-time checked to
  // stay in lockstep.
  ChatNavActions,
  ChatNavMenuActions,
  ChatSearchActions,
  ChatMarksActions,
  ChatElaborateActions
{
  readonly chatService = inject(ChatService);
  readonly i18n = inject(I18nService);
  /** Paced reading of already-written text (started from a chapter's Read button). */
  readonly pacedRead = inject(PacedReadService);
  /** Persistent reading marks (positions / selections + notices) of the chat. */
  readonly readingMarks = inject(ReadingMarksService);
  /** Marks panel open state. */
  readonly showMarks = signal(false);
  readonly projectService = inject(ProjectService);
  /** Client-side node clipboard; used here to paste a copied branch at the top. */
  readonly clipboard = inject(NodeClipboardService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly parameters = inject(ChatParametersService);
  private readonly llmRunner = inject(LlmUseCaseRunner);
  private readonly generation = inject(GenerationSettingsService);
  private readonly confirm = inject(ConfirmService);
  private readonly editSession = inject(NodeEditSession);
  private readonly navSelection = inject(ChatNavSelectionService);
  private readonly layoutPrefs = inject(ChatLayoutPrefsService);
  private readonly elaborateDialog = inject(ChatElaborateDialogService);
  private readonly elaborateService = inject(ChatElaborateService);
  private readonly toast = inject(ToastService);
  /** Navbar clipboard/branch operations — the page delegates to it below. */
  private readonly navActions = inject(ChatNavActionsService);
  /** Persistent reading marks handling — the page delegates to it below. */
  private readonly chatMarks = inject(ChatMarksService);
  /** Search/replace + name dialogs glue — the page delegates to it below. */
  private readonly chatSearch = inject(ChatSearchService);
  /** Paced-reading glue (resume host, start-from-view, read-from-mark). */
  private readonly chatPacedRead = inject(ChatPacedReadService);

  readonly chats = this.chatService.chats;
  readonly currentChatId = this.chatService.currentChatId;
  readonly nodes = this.chatService.currentNodes;

  /**
   * Estimated paced-read duration of the whole story (all chapters on the
   * active path) at the current reveal speed — the same pace Ctrl+R / Read
   * would use.
   */
  readonly bookReadTimeLabel = computed(() => {
    const chapters = this.getActivePath().filter(n => n.role === 'assistant');
    const text = chapters.map(n => n.content ?? '').join('\n');
    if (!text.trim()) return null;
    return readingTimeLabel(text, this.chatService.streamSpeed(), this.chatService.streamSpeedUnit());
  });

  /**
   * The active path as RENDERED in the conversation tree. While a paced read
   * runs in this (Normal) view, direction (user) nodes are hidden so the story
   * reads as continuous prose — the same effect as Ctrl+D in the Book view.
   * The terminal composer (a user leaf without children) stays mounted so a
   * half-typed direction is never lost; stopping the read restores the rest.
   */
  readonly treePath = computed(() => {
    const path = this.getActivePath();
    if (!this.pacedRead.active()) return path;
    return path.filter(n =>
      n.role !== 'user' || this.chatService.getChildren(n.id).length === 0
    );
  });

  /** parentId → active child nodeId  (shared tree navigation state) */
  readonly activeChild = signal<Record<string, string>>({});

  readonly newQuestion = signal('');
  readonly isLoading = signal(false);

  readonly enabledModels = this.settings.enabledModels;

  private readonly tree = viewChild<ElementRef<HTMLElement>>('tree');

  /** The horizontal scroller of the toolbar (params-bar buttons). */
  private readonly paramsTools = viewChild<ElementRef<HTMLElement>>('paramsTools');

  /** Toolbar scroll arrows follow the viewport — the template can toggle
   *  Stop/Finish buttons, which changes the scroll width without a resize. */
  private toolbarResizeObserver?: ResizeObserver;

  /** Rendered chat-node components, used to push search replacements into an open editor. */
  private readonly nodeComps = viewChildren<ChatNodeComponent>(ChatNodeComponent);

  /** Node whose block sits nearest the top of .tree */
  readonly visibleNodeId = signal<string | null>(null);
  /** All nodes whose blocks are currently visible in the tree viewport — the
   *  nav-bar shows a frame on each of them, so a long chapter sharing the
   *  viewport with the next node keeps BOTH marked. */
  readonly visibleNodeIds = signal<string[]>([]);

  // ------------------------------------------------------------------
  // Toolbar (params-bar) horizontal paging — the buttons stay on ONE line
  // and scroll in place when the window is too narrow; the ◀/▶ arrows only
  // show up while there is anything hidden in that direction.
  // ------------------------------------------------------------------

  readonly toolbarCanScrollBack = signal(false);
  readonly toolbarCanScrollForward = signal(false);

  /** Page the hidden toolbar buttons into view (dir = -1 ‹ / +1 ›). */
  scrollToolbarBy(dir: -1 | 1): void {
    const el = this.paramsTools()?.nativeElement;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  }

  /** Recompute the arrow states (scroll, resize, content change). */
  updateToolbarScroll(): void {
    this.updateToolbarScrollState();
  }

  /** The arrows enable only while something is hidden in that direction. */
  updateToolbarScrollState(): void {
    const el = this.paramsTools()?.nativeElement;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    this.toolbarCanScrollBack.set(el.scrollLeft > 1);
    this.toolbarCanScrollForward.set(el.scrollLeft < max - 1);
  }

  /** Window-size changes (plus the ResizeObserver above) re-measure the bar. */
  @HostListener('window:resize')
  onWindowResize(): void {
    this.updateToolbarScroll();
  }

  /** Node currently open in the editor — re-exported for `app-chat-nav-bar`. */
  readonly editingNodeId = this.editSession.editingNodeId;

  // ------------------------------------------------------------------
  // Navbar multi-selection (Ctrl+click / Ctrl+drag on the active path)
  // ------------------------------------------------------------------

  /** Ordered ids of the nodes selected in the navbar (subset of the active
   *  path). Owned by ChatNavSelectionService — re-exported so the template /
   *  tests keep reading `component.navSelectedIds()`. */
  readonly navSelectedIds = this.navSelection.selectedIds;
  /** Navbar node currently under the pointer — target for Ctrl+V paste. */
  readonly navClipboardTargetId = this.navSelection.clipboardTargetId;

  isNavNodeSelected(id: string): boolean {
    return this.navSelection.isSelected(id);
  }

  /** The empty "direction" node at the very end of the active path — the
   *  terminal draft question the user types into. It can never be selected in
   *  the navbar and nothing may be pasted to its left. A delegate over
   *  `ChatNavMenuService` (which needs the same predicate for the menus). */
  private isLastEmptyDirection(nodeId: string): boolean {
    return this.navMenu.isLastEmptyDirection(nodeId);
  }

  toggleNavSelection(id: string): void {
    this.navSelection.toggle(id, this.getActivePath(), (x) => this.isLastEmptyDirection(x));
  }

  clearNavSelection(): void {
    this.navSelection.clear();
  }

  copyNavSelection(): void {
    this.navActions.copyNavSelection();
  }

  async cutNavSelection(): Promise<void> {
    await this.navActions.cutNavSelection();
  }

  /**
   * Extract the selected chain into a NEW story: the selected nodes are
   * copied there (as the story's starting chain), the source story's lore is
   * copied along with them. The new story is opened afterwards.
   *
   * With `withVisibleSubtree` the visible continuation below the selection (the
   * rest of the active path) travels along as well, so the new story does not
   * end at the cut.
   *
   * Only nodes whose whole subtree moved are removed from this story. A node
   * that transitively is a parent of a node which is NOT extracted stays here
   * (removing it would orphan that branch) — it is COPIED instead. Example:
   * visible A → B → C → D with an invisible C → E; extracting B with its
   * subtree yields B → C → D in the new story and keeps A → B → C → E here.
   */
  async extractNavSelection(withVisibleSubtree = false): Promise<void> {
    await this.navActions.extractNavSelection(withVisibleSubtree);
  }

  /** Remove the selected chain (top-first) — left-over children are
   *  reparented to the chain's topmost surviving ancestor. */
  async deleteNavSelection(): Promise<void> {
    await this.navActions.deleteNavSelection();
  }

  /** Paste the clipboard chain into the active path right between the node
   *  after which the navbar paste button sits and its successor — the two
   *  visible nodes left and right of the button (a simple left click, and
   *  Ctrl+V on the hovered node). If the button belongs to the last visible
   *  node, the chain is appended behind it. */
  async pasteNavSelectionAfter(nodeId: string): Promise<void> {
    await this.navActions.pasteNavSelectionAfter(nodeId);
  }

  /** The navbar paste button appears after this node only when pasting there
   *  is allowed (never left of the empty terminal direction node). */
  canPasteAfter(node: ChatNode): boolean {
    return this.navActions.canPasteAfter(node);
  }

  /** Append the clipboard chain as a PARALLEL BRANCH under the left visible
   *  node (sibling of the right visible node) instead of splicing it into the
   *  visible chain. Only made visible when pasted at the very end. */
  async appendNavSelectionAfter(nodeId: string): Promise<void> {
    await this.navActions.appendNavSelectionAfter(nodeId);
  }

  // ------------------------------------------------------------------
  // Nodebar context menus — DELEGATES to `ChatNavMenuService`
  // (popover state, row building, viewport clamping). The service is hosted
  // by `ChatNavBarComponent`; its actions land on the handlers below (they
  // mutate the selection / the tree, which this page owns).
  // ------------------------------------------------------------------

  private readonly navMenu = inject(ChatNavMenuService);

  /** Open context menu of a paste button: { pointer position, left/right node }. */
  readonly navPasteMenu = this.navMenu.navPasteMenu;
  /** Right-clicked nav node for the inline context menu. */
  readonly navNodeMenu = this.navMenu.navNodeMenu;

  openNavPasteMenu(event: MouseEvent, node: ChatNode): void {
    this.navMenu.openNavPasteMenu(event, node);
  }

  closeNavPasteMenu(): void {
    this.navMenu.closeNavPasteMenu();
  }

  navPasteMenuLeftPx(): number {
    return this.navMenu.navPasteMenuLeftPx();
  }

  navPasteMenuTopPx(): number {
    return this.navMenu.navPasteMenuTopPx();
  }

  navPasteMenuItems(menu: { leftId: string; rightId: string | null }): NavMenuEntry[] {
    return this.navMenu.navPasteMenuItems(menu);
  }

  openNavNodeMenu(event: MouseEvent, node: ChatNode): void {
    this.navMenu.openNavNodeMenu(event, node);
  }

  closeNavNodeMenu(): void {
    this.navMenu.closeNavNodeMenu();
  }

  navNodeMenuItems(): NavMenuEntry[] {
    return this.navMenu.navNodeMenuItems();
  }

  /** Close the menu, then run the chosen action (if it is enabled). */
  runNavNodeAction(item: NavMenuEntry): void | Promise<void> {
    return this.navMenu.runNavNodeAction(item);
  }

  /** The `pasteChain` output handler: the shared insert-vs-append splice used
   *  by the paste menu (via the nav bar's `ChatNavMenuHost`). */
  pasteChainInto(
    mode: 'insert' | 'append',
    leftId: string,
    rightId: string | null,
  ): Promise<void> {
    return this.navActions.pasteChainInto(mode, leftId, rightId);
  }

  /** Switch the active continuation at `node.parentId` to the previous/next
   *  sibling — the navbar equivalent of the node's branch switcher. */
  switchNavSibling(node: ChatNode, dir: -1 | 1): void {
    this.navActions.switchNavSibling(node, dir);
  }

  /** Start a branch next to `node`: materialize an empty direction leaf with
   *  the SAME parent, so it sits in parallel with `node`. The active path
   *  then picks up the new leaf as its next node — the navbar equivalent of
   *  typing a fresh continuation beside the current one. */
  async startBranchAt(node: ChatNode): Promise<void> {
    await this.navActions.startBranchAt(node);
  }

  copyNavNodes(node: ChatNode): void {
    this.navActions.copyNavNodes(node);
  }

  async cutNavNodes(node: ChatNode): Promise<void> {
    await this.navActions.cutNavNodes(node);
  }

  async deleteNavNodes(node: ChatNode): Promise<void> {
    await this.navActions.deleteNavNodes(node);
  }

  /** Paste the clipboard chain immediately BEFORE `node` in the active path. */
  async pasteNavSelectionBefore(node: ChatNode): Promise<void> {
    await this.navActions.pasteNavSelectionBefore(node);
  }

  /** `app-chat-nav-bar` emits the node ID — resolve it to the path node. */
  async pasteNavSelectionBeforeId(nodeId: string): Promise<void> {
    await this.navActions.pasteNavSelectionBeforeId(nodeId);
  }

  private readonly router = inject(Router);

  /** Sidebar width + per-chat nav-bar height (drag persistence) live in
   *  ChatLayoutPrefsService — re-exported so the template / tests keep
   *  reading `component.sidebarWidth()`, `component.navBarHeight()`, … */
  readonly sidebarWidth = this.layoutPrefs.sidebarWidth;
  readonly isResizing = this.layoutPrefs.isResizing;
  readonly sidebarCollapsed = this.layoutPrefs.sidebarCollapsed;
  readonly navBarHeight = this.layoutPrefs.navBarHeight;
  readonly showChatParams = signal(false);
  readonly chatParamsOverride = signal(false);
  readonly chatParamsDraft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly chatParamsInherited = signal<ResolvedChatParameters | null>(null);
  readonly chatParamsSummary = signal('defaults');

  /** Per-story lore dialog (chat.lore + auto-exclude-directions toggle). */
  readonly showLoreDialog = signal(false);
  readonly loreDraft = signal('');
  readonly loreAutoExclude = signal(false);
  readonly isGeneratingStructure = signal(false);
  readonly pendingStructure = signal<string | null>(null);

  /** Trash panel for soft-deleted branches of the current chat. */
  readonly showTrash = signal(false);
  readonly trashLoading = signal(false);

  /** Elaborate-dialog state (first/last chapter + names + prefix + hints +
   *  stick-to-last + model + live preview) delegated to
   *  ChatElaborateDialogService — re-exported so the template / tests keep
   *  reading `component.elaborate*`. The orchestration (open/confirm) lives in
   *  ChatElaborateService. */
  readonly showElaborateDialog = this.elaborateDialog.show;
  readonly isElaborating = this.elaborateService.isElaborating;
  readonly elaborateFirst = this.elaborateDialog.first;
  readonly elaborateLast = this.elaborateDialog.last;
  readonly elaborateNames = this.elaborateDialog.names;
  readonly elaboratePrefix = this.elaborateDialog.prefix;
  readonly elaborateHints = this.elaborateDialog.hints;
  readonly elaborateStickLast = this.elaborateDialog.stickLast;
  readonly elaborateModelId = this.elaborateDialog.modelId;
  readonly elaboratePreview = this.elaborateDialog.preview;
  /** Chapter-plan options: "add the descriptions to the lore" + how many
   *  chapter descriptions (IN TOTAL, starting at the elaborated chapter) travel
   *  with each elaboration. */
  readonly elaborateUsePlan = this.elaborateDialog.usePlan;
  readonly elaboratePlanChapters = this.elaborateDialog.planChapters;
  readonly elaboratePlanNodeId = this.elaborateDialog.planNodeId;
  readonly elaboratePlanCandidates = this.elaborateDialog.planCandidates;
  readonly elaborateActivePlan = this.elaborateDialog.activePlan;
  readonly elaborateActivePlanLabel = this.elaborateDialog.activePlanLabel;
  readonly elaboratePlanCoversRange = this.elaborateDialog.planCoversRange;

  /** Sidebar drag — state + persistence live in ChatLayoutPrefsService. */
  startSidebarResize(event: PointerEvent) {
    this.layoutPrefs.startSidebarResize(event);
  }

  endSidebarResize() {
    this.layoutPrefs.endSidebarResize();
  }

  resetSidebarWidth() {
    this.layoutPrefs.resetSidebarWidth();
  }

  toggleSidebarCollapsed() {
    this.layoutPrefs.toggleSidebarCollapsed();
  }

  // ------------------------------------------------------------------
  // Node-nav-bar height (vertical separator between the nav bar and the tree)
  // ------------------------------------------------------------------

  /** The extracted nav bar — it owns the bar element now; the page forwards
   *  the resizer drag and the auto-scroll to it (stage 1 of the extraction). */
  private readonly navBar = viewChild(ChatNavBarComponent);

  // ------------------------------------------- paced reading: position host

  /**
   * The paced-read / search / marks services receive the page's live view
   * signals (tree scroller, node components, visible nodes, marks panel) as
   * a bind-time contract — see the constructor. The signals stay private
   * here; the services read them and write the writable ones directly.
   */

  ngOnDestroy() {
    this.toolbarResizeObserver?.disconnect();
    this.layoutPrefs.endSidebarResize();
    // Leaving the chat page must not leave a stale edit session behind —
    // otherwise re-entering a node editor later would start out "dirty" even
    // though nothing was changed.
    this.editSession.abandon();
    // Stop the shared search dialog from using this page's nodes.
    this.chatSearch.unregister();
    // Unregister the paced-read resume host (auto-pauses a running reveal).
    this.chatPacedRead.unregisterHost();
  }

  // ------------------------------------------------------------------
  // Search / replace + name dialogs — DELEGATES to `ChatSearchService`
  // (the SearchReplaceSession adapter, occurrence navigation/highlighting and
  // the two name dialogs). The service calls back through `ChatSearchHost`
  // for the DOM-bound bits; the page keeps these thin members so the template
  // and the specs stay unchanged.
  // ------------------------------------------------------------------

  /** The searchable text units of a scope (node = editing/visible/leaf node,
   *  chat = the active path). */
  private searchUnits(
    scope: 'node' | 'chat' | 'reader',
  ): { key: string; text: string; role?: ChatNode['role'] }[] {
    return this.chatSearch.searchUnits(scope);
  }

  /**
   * The caret's vertical position inside the editor textarea (accounts for
   * word-wrapping). Delegates over the shared mirror helper so specs can stub
   * the measurement (module functions aren't spyable). ChatSearchService calls
   * back through the host, so the spec spy on this method keeps working.
   */
  private measureSearchCaret(
    ta: HTMLTextAreaElement,
    offset: number
  ): TextareaCharMetrics | null {
    return textareaCharMetrics(ta, offset);
  }

  /** Reveal a found search/name match inside the editor textarea AND in the
   *  conversation scroller. */
  private revealSearchMatchInEditor(ta: HTMLTextAreaElement, caretOffset: number): void {
    this.chatSearch.revealSearchMatchInEditor(ta, caretOffset);
  }

  openSearch(): void {
    this.chatSearch.openSearch();
  }

  /** Open the "Replace names" dialog over the VISIBLE chat. */
  async openNameReplace(): Promise<void> {
    await this.chatSearch.openNameReplace();
  }

  /** Open the "Name lists" settings dialog. */
  async openNameList(): Promise<void> {
    await this.chatSearch.openNameList();
  }


  openReader() {
    const activeNodeId = this.visibleNodeId() ?? this.getCurrentLeaf()?.id ?? null;
    void this.router.navigate(['/read'], { state: { activeNodeId } });
  }

  async ngOnInit() {
    this.chatSearch.register();
    await this.chatService.loadChats();
    await this.projectService.loadTopics();
    await this.projectService.loadProjects();
    await this.settings.loadAll();
    await this.refreshChatParams();
  }

  constructor() {
    // The navbar context menus live in ChatNavMenuService, hosted by
    // `ChatNavBarComponent`; their actions are emitted onto this page's
    // handlers (selection + tree mutation) below.
    // The paced-read / search / marks services receive the page's live view
    // signals as a bind-time contract — the DOM stays private on the page and
    // the services read/write the signals directly (no host casts).
    this.chatPacedRead.bind({
      tree: this.tree,
      getActivePath: () => this.getActivePath(),
      visibleNodeId: this.visibleNodeId,
      visibleNodeIds: this.visibleNodeIds,
    });
    this.chatPacedRead.registerHost();
    // The search/name glue lives in ChatSearchService; it calls back into the
    // page for the DOM-bound bits (tree scroller, node components, caret
    // measurement) and registers its session on init.
    this.chatSearch.bind({
      tree: this.tree,
      nodeComps: this.nodeComps,
      getActivePath: () => this.getActivePath(),
      getCurrentLeaf: () => this.getCurrentLeaf(),
      visibleNodeId: this.visibleNodeId,
      chats: this.chats,
      measureSearchCaret: (ta, offset) => this.measureSearchCaret(ta, offset),
    });
    // The persistent-marks handling lives in ChatMarksService; it calls back
    // into the page for the rendered node components, the visible node and the
    // tree scroller.
    this.chatMarks.bind({
      nodeComps: this.nodeComps,
      visibleNodeId: this.visibleNodeId,
      getActivePath: () => this.getActivePath(),
      getCurrentLeaf: () => this.getCurrentLeaf(),
      showMarks: this.showMarks,
    });
    // Toolbar: .params-tools only exists while a story is open, so a one-shot
    // afterNextRender at construction would run too early and never attach.
    // This effect re-runs whenever the element appears/disappears (story
    // opened/closed, sidebar redrawn) and (re)attaches the ResizeObserver —
    // which covers window resizes AND content changes (Stop buttons
    // appearing, summaries growing) without polling.
    effect(() => {
      this.toolbarResizeObserver?.disconnect();
      this.toolbarResizeObserver = undefined;
      const el = this.paramsTools()?.nativeElement;
      if (!el || typeof ResizeObserver === 'undefined') return;
      this.toolbarResizeObserver = new ResizeObserver(() => this.updateToolbarScroll());
      this.toolbarResizeObserver.observe(el);
      this.updateToolbarScroll();
    });
    console.log('ChatComponent constructed', Date.now());
    effect(() => {
      const chatId = this.currentChatId();
      const generating = this.chatService.generatingNodeId();
      // While Elaborate chains nodes sequentially (and an illustration
      // storyboard versions the chapter as pictures arrive), draft
      // housekeeping is deferred so it cannot re-point the active path
      // between the work's steps.
      const busy = this.isElaborating() || this.chatService.isIllustrating();
      this.chatService.currentNodes();
      this.chatService.getActivePath();
      if (!chatId || generating || busy) return;
      queueMicrotask(async () => {
        await this.chatService.ensureDraftAtLeaf(chatId);
        this.restoreOpenedChatPosition(chatId);
        this.syncVisibleNode();
      });
    });
    effect(() => {
      // Navbar selection only ever refers to the currently visible chain: it
      // is cleared as soon as the chat changes OR a child is switched (the
      // active path no longer matches what was selected).
      this.navSelection.syncWithPath(
        this.chatService.currentChatId(),
        this.chatService.getActivePath().map(n => n.id)
      );
    });
    // Nav-bar height is a PER-CHAT preference. On any chat switch, apply the
    // saved height for the new chat (or null = default when it was never
    // manually resized), so a previous chat's tall manual height never leaves
    // empty lines in the bar of a short path.
    effect(() => {
      this.layoutPrefs.applyChat(this.chatService.currentChatId());
    });
    // Default handling — keep every marked node's line visible inside the
    // nav bar while it is capped at 4 lines with a scrollbar. Dependencies:
    // the visible nodes, the edited node, the active path and the (manual)
    // bar height.
    effect(() => {
      this.visibleNodeIds();
      this.editingNodeId();
      this.getActivePath();
      this.navBarHeight();
      this.navBar()?.scrollNavBarToMarked();
    });
  }

  onTreeScroll(): void {
    this.syncVisibleNode();
    const tree = this.tree()?.nativeElement;
    const chatId = this.currentChatId();
    if (tree && chatId && this.chatPacedRead.isPositionedFor(chatId)) {
      this.chatService.saveScroll(chatId, tree.scrollTop);
    }
  }

  private restoreOpenedChatPosition(chatId: string | null): void {
    if (!chatId) {
      this.chatPacedRead.setPositionedChatId(null);
      return;
    }
    if (this.chatPacedRead.isPositionedFor(chatId)) return;

    const tree = this.tree()?.nativeElement;
    const path = this.getActivePath();
    if (!tree || path.length === 0) return;

    this.chatPacedRead.setPositionedChatId(chatId);

    if (this.chatService.alwaysOpenAtLeaf()) {
      const leaf = this.getCurrentLeaf();
      if (leaf) {
        const el = tree.querySelector(`[data-node-id="${leaf.id}"]`) as HTMLElement | null;
        el?.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      return;
    }

    const saved = this.chatService.getSavedScroll(chatId);
    tree.scrollTop = saved ?? 0;
  }

  private syncVisibleNode(): void {
    const root = this.tree()?.nativeElement;
    if (!root) {
      this.visibleNodeId.set(null);
      this.visibleNodeIds.set([]);
      return;
    }

    const top = root.getBoundingClientRect().top;
    const bottom = top + root.clientHeight;
    const visible: string[] = [];
    let bestId: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const node of this.getActivePath()) {
      const el = root.querySelector(`[data-node-id="${node.id}"]`) as HTMLElement | null;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      // A node is "visible" when any part of it lies inside the tree viewport
      // — the nav-bar frames every such node, so a long chapter sharing the
      // viewport with the next node keeps BOTH marked.
      if (rect.bottom > top && rect.top < bottom) {
        visible.push(node.id);
      }
      const dist = Math.abs(rect.top - top);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = node.id;
      }
    }

    this.visibleNodeId.set(bestId);
    this.visibleNodeIds.set(visible);
  }

  // ------------------------------------------------------------------
  // Active path / branch navigation (only remaining shared state)
  // ------------------------------------------------------------------


  getActiveChild(parentId: string | null): ChatNode | null {
    const siblings = this.getChildren(parentId);
    if (siblings.length === 0) return null;

    const activeId = this.getActiveChildId(parentId);
    const found = siblings.find(s => s.id === activeId);
    return found || siblings[0];
  }


  /** Deepest node in the currently active branch */
  getCurrentLeaf(): ChatNode | null {
    let current: ChatNode | null = this.getActiveChild(null);
    if (!current) return null;

    while (true) {
      const next = this.getActiveChild(current.id);
      if (!next) break;
      current = next;
    }
    return current;
  }

  /** Scroll the tree to a node — the nav-bar's scroll output and the marks
   *  fallback. The DOM query lives in ChatMarksService. */
  scrollToNode(nodeId: string): void {
    this.chatMarks.scrollToNode(nodeId);
  }

  // ------------------------------------------- persistent reading marks

  /** One-line description of a mark for the panel (quote or position excerpt). */
  markPreview(mark: ReadingMark): string {
    return this.chatMarks.markPreview(mark);
  }

  /** "chapter 3"-ish reference of the node a mark belongs to. */
  markNodeLabel(mark: ReadingMark): string {
    return this.chatMarks.markNodeLabel(mark);
  }

  /**
   * Go to a mark: scroll to its EXACT spot inside the section and re-select
   * the marked text (it looks selected again and can be copied). Falls back to
   * scrolling the section into view when the text is no longer there (the
   * section was edited after the mark was set).
   */
  jumpToMark(mark: ReadingMark): void {
    this.chatMarks.jumpToMark(mark);
  }

  /**
   * Read from a mark. When a read is already running/paused it RELOCATES to
   * the mark (keeping the paused state) instead of stopping the session — the
   * panel is how you pick the next spot while the reading is paused. Delegate
   * to `ChatPacedReadService` (via `ChatMarksService`).
   */
  readFromMark(mark: ReadingMark): void {
    this.chatMarks.readFromMark(mark);
  }

  async deleteMark(mark: ReadingMark): Promise<void> {
    await this.chatMarks.deleteMark(mark);
  }

  /** Edit a mark's notice in the modal (Cancel keeps the old notice). */
  async editMarkNote(mark: ReadingMark): Promise<void> {
    await this.chatMarks.editMarkNote(mark);
  }

  /**
   * Ctrl+M — mark the current position (or the marked text) with a notice.
   * Works on the section that owns the text selection, else on the section at
   * the top of the view.
   */
  markAtCursor(): void {
    this.chatMarks.markAtCursor();
  }

  async clearMarks(): Promise<void> {
    await this.chatMarks.clearMarks();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    // Escape closes the elaborate dialog (same as its Cancel button).
    if (event.key === 'Escape') {
      if (this.showElaborateDialog()) {
        event.preventDefault();
        this.cancelElaborate();
        return;
      }
      if (this.navPasteMenu()) {
        event.preventDefault();
        this.closeNavPasteMenu();
        return;
      }
      if (this.navNodeMenu()) {
        event.preventDefault();
        this.closeNavNodeMenu();
        return;
      }
    }

    if (this.isTyping(event)) return;
    const ctrl = event.ctrlKey || event.metaKey;

    // Paced reading owns Ctrl+R (start/stop — Ctrl+R is also the
    // browser/Electron RELOAD shortcut, so it must be prevented) and, while a
    // read runs, the arrow keys + Space/P (interrupt/resume) + Escape (stop).
    // Delegated to ChatPacedReadService — it returns true when it consumed
    // the event, and the page must not process it further.
    if (this.chatPacedRead.onKey(event)) return;

    // Ctrl+M — mark the current position (or the marked text) with a notice.
    if (ctrl && (event.key === 'm' || event.key === 'M')) {
      event.preventDefault();
      this.markAtCursor();
      return;
    }

    // Navbar clipboard shortcuts (copy/cut/delete the selection or the
    // hovered node, Ctrl+V paste behind the hovered node) — delegated to
    // ChatNavActionsService. It returns true when it consumed the event, and
    // the page must not process it further.
    if (this.navActions.onKey(event)) return;

    if (event.key === 'b' || event.key === 'B') {
      if (!this.currentChatId()) return;
      event.preventDefault();
      this.openReader();
    }
  }

  private isTyping(event: KeyboardEvent): boolean {
    const t = event.target as HTMLElement | null;
    return !!t && (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable
    );
  }


  // remove local activeChildMap / getActivePath / setActiveChild …

// just delegate
  getActivePath()          { return this.chatService.getActivePath(); }

  getActiveChildId(pid: string | null)    { return this.chatService.getActiveChildId(pid); }
  setActiveChild(pid: string | null, cid: string) { this.chatService.setActiveChild(pid, cid); }
  getChildren(pid: string | null)         { return this.chatService.getChildren(pid); }

  protected selectedModelId() {
    return this.lastModelService.selectedModelId;
  }

  protected setSelectedModelId($event: any) {
    this.lastModelService.setSelectedModel($event);
  }


  currentChat(): Chat | undefined {
    const id = this.currentChatId();
    return this.chats().find(c => c.id === id);
  }

  async toggleChatParams() {
    const open = !this.showChatParams();
    this.showChatParams.set(open);
    if (open) await this.refreshChatParams();
  }

  async toggleTrash() {
    const open = !this.showTrash();
    this.showTrash.set(open);
    if (open) {
      const chatId = this.currentChatId();
      if (!chatId) return;
      this.trashLoading.set(true);
      try {
        await this.chatService.loadDeletedNodes(chatId);
      } finally {
        this.trashLoading.set(false);
      }
    }
  }

  /** Paste the internal node clipboard as a new top-level branch (parent null). */
  async pasteAtTop(): Promise<void> {
    try {
      await this.clipboard.paste(null);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.pasteFailed', { error: err?.message || err }));
    }
  }

  trashCount(): number {
    return this.chatService.deletedNodes().length;
  }

  trashPreview(node: ChatNode): string {
    return node.content?.trim() || this.i18n.t('chat.trashEmptyContent');
  }

  trashDate(node: ChatNode): string {
    const t = node.deletedAt || node.updatedAt || node.createdAt;
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
  }

  async restoreBranch(nodeId: string): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId) return;
    try {
      await this.chatService.restoreBranch(chatId, nodeId);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('chat.trashRestoreFailed', { error: err?.message || err }));
    }
  }

  async purgeBranch(nodeId: string): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('chat.trashPurgeAsk'),
      message: this.i18n.t('chat.trashPurgeMsg'),
      confirmLabel: this.i18n.t('chat.trashPurge'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    try {
      await this.chatService.purgeBranch(chatId, nodeId);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('chat.trashPurgeFailed', { error: err?.message || err }));
    }
  }

  async refreshChatParams() {
    const chat = this.currentChat();
    const project = chat?.projectId ? this.projectService.getProject(chat.projectId) : null;
    const topic = this.projectService.topicForProject(project?.id, this.projectService.topics()) ?? null;
    const model = this.settings.models().find(m => m.id === this.lastModelService.selectedModelId())
      || this.generation.modelFor('default')
      || this.settings.enabledModels()[0]
      || null;
    await this.parameters.loadMany([
      chat?.chatParametersId,
      project?.chatParametersId,
      topic?.chatParametersId,
      model?.chatParametersId
    ]);
    const inherited = this.parameters.resolveForChat({ model, topic, project, chat: null });
    this.chatParamsInherited.set(inherited);
    const own = chat?.chatParametersId ? await this.parameters.get(chat.chatParametersId) : null;
    this.chatParamsOverride.set(!!own);
    this.chatParamsDraft.set(draftFromParameters(own));
    const effective = this.parameters.resolveForChat({ model, topic, project, chat: chat ?? null });
    const src = effective.source === 'default' ? 'defaults' : effective.source;
    this.chatParamsSummary.set(`${formatParametersSummary(effective)} (${src})`);
  }

  onChatParamsChanged(event: { override: boolean; draft: ChatParametersDraft }) {
    this.chatParamsOverride.set(event.override);
    this.chatParamsDraft.set(event.draft);
  }

  /** Open the lore dialog pre-filled from the current chat. */
  openLoreDialog(): void {
    const chat = this.currentChat();
    this.loreDraft.set(chat?.lore ?? '');
    this.loreAutoExclude.set(!!chat?.autoExcludeDirections);
    this.showLoreDialog.set(true);
  }

  closeLoreDialog(): void {
    this.showLoreDialog.set(false);
  }

  /**
   * Save lore text + the auto-exclude mode. The lore text is stored on the
   * chat; a lore node is materialized lazily IN FRONT OF each direction when
   * it is sent (see `ChatService.ensureLoreNodeBefore`), sent once with that
   * direction, then deactivated — the next direction gets a fresh one.
   */
  async saveLoreDialog(): Promise<void> {
    const chat = this.currentChat();
    if (!chat) return;
    const lore = this.loreDraft().trim();
    await this.chatService.patchChatMeta(chat.id, {
      lore: lore || null,
      autoExcludeDirections: this.loreAutoExclude()
    });
    this.showLoreDialog.set(false);
  }

  /** Abort the current generation AND any running multi-call operation
   *  (headings / elaborate / title / summary) of THIS chat. */
  stopGeneration(): void {
    this.chatService.stopGeneration(this.currentChatId() ?? undefined);
  }

  /** Finish the current stream / step, then stop anything that would follow
   *  it — the answer currently being created is preserved and saved. */
  gracefulStop(): void {
    this.chatService.requestGracefulStop();
  }

  /** Generate a title for the whole story (context = all assistant nodes). */
  async generateTitle(): Promise<void> {
    await this.runStructureGeneration('title');
  }

  /** Generate an introduction for the whole story (context = all assistant nodes).
   *  The resulting structure node wraps the story and sits right after an
   *  existing structure node (e.g. a generated title), or becomes the very
   *  first node of the story when none exists yet. */
  async generateIntroduction(): Promise<void> {
    await this.runStructureGeneration('overview');
  }

  /** Shared generation for the chat-level Title / Introduction buttons. */
  private async runStructureGeneration(task: GenerationTaskKind): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId || this.isGeneratingStructure()) return;

    const resolvedModel = this.resolveStructureModel(task);
    if (!resolvedModel) {
      alert(this.i18n.t('node.structureModelMissing'));
      return;
    }
    const { model, provider } = resolvedModel;

    // The whole process (LLM call + node wiring) is cancelled by one Stop press.
    const opSignal = this.chatService.beginChatOperation(chatId, task);
    if (!opSignal) {
      this.toast.error(this.i18n.t('node.busy'));
      return;
    }
    this.isGeneratingStructure.set(true);
    this.pendingStructure.set(task);
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      // Any anchor node works — the `structure-title` / `structure-overview`
      // use case reads the whole chat state to build its own context.
      const node = this.chatService.getActiveChild(null);
      const usecase = task === 'title' ? 'structure-title' : 'structure-overview';
      const slots = await this.llmRunner.run({
        chat,
        node,
        usecase,
        vars: { modelId: model.modelId, providerId: model.providerId }
      }, { signal: opSignal });
      if (this.chatService.isOperationCancelled()) return;
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.structureEmpty'));
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isGeneratingStructure.set(false);
      this.pendingStructure.set(null);
      this.chatService.endChatOperation(chatId);
    }
  }

  /** Generate a heading for EVERY assistant node on the active path. */
  async generateHeadings(): Promise<void> {
    const chatId = this.currentChatId();
    if (!chatId || this.isGeneratingStructure()) return;

    const resolvedModel = this.resolveStructureModel('headings');
    if (!resolvedModel) {
      alert(this.i18n.t('node.structureModelMissing'));
      return;
    }
    const { model, provider } = resolvedModel;

    // The whole multi-call process is cancelled by one Stop press.
    const opSignal = this.chatService.beginChatOperation(chatId, 'headings');
    if (!opSignal) {
      this.toast.error(this.i18n.t('node.busy'));
      return;
    }
    this.isGeneratingStructure.set(true);
    this.pendingStructure.set('headings');
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      // Any anchor node works — the `structure-headings` use case walks the
      // active path itself and stops between chapters when aborted.
      const node = this.getCurrentLeaf() ?? this.chatService.getActiveChild(null);
      const slots = await this.llmRunner.run({
        chat,
        node,
        usecase: 'structure-headings',
        vars: { modelId: model.modelId, providerId: model.providerId }
      }, { signal: opSignal });
      if (this.chatService.isOperationCancelled()) return;
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.structureEmpty'));
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      alert(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isGeneratingStructure.set(false);
      this.pendingStructure.set(null);
      this.chatService.endChatOperation(chatId);
    }
  }

  // ------------------------------------------------------------------
  // Elaborate — extend the chat with per-chapter elaborations
  // ------------------------------------------------------------------
  // The dialog STATE lives in ChatElaborateDialogService and the ORCHESTRATION
  // (open/confirm chain) in ChatElaborateService — this page only delegates,
  // adding the structure-generation guard on open.

  /** Open the elaborate dialog (blocked while structure generation runs). */
  openElaborateDialog(): void {
    if (this.isGeneratingStructure()) return;
    this.elaborateService.openElaborateDialog();
  }

  cancelElaborate(): void {
    this.elaborateService.cancelElaborate();
  }

  /** Clamp the "plan chapters" input (1..50) — templates cannot use Math. */
  setPlanChapters(value: number | string): void {
    this.elaborateService.setPlanChapters(value);
  }

  /** Toggle "stick to last chapter". */
  onStickLastToggle(checked: boolean): void {
    this.elaborateService.onStickLastToggle(checked);
  }

  /** Confirm the dialog and run the sequential elaborations. */
  confirmElaborate(): Promise<void> {
    return this.elaborateService.confirmElaborate();
  }

  /** Resolve the model+provider for an authoring task, or null if unset/unknown. */
  private resolveStructureModel(task: GenerationTaskKind): { model: ModelEntry; provider: ProviderConfig } | null {
    const configuredModel = this.generation.modelFor(task);
    const model = configuredModel
      ?? this.enabledModels().find(m =>
        m.modelId === this.lastModelService.selectedModelId() ||
        m.id === this.lastModelService.selectedModelId())
      ?? this.generation.modelFor('default')
      ?? this.enabledModels()[0];
    if (!model) return null;
    const provider = this.settings.providers().find(p => p.id === model.providerId);
    return provider ? { model, provider } : null;
  }

  async saveChatParams() {
    const chat = this.currentChat();
    if (!chat) return;
    const chatParametersId = await this.parameters.persistDraft(
      chat.chatParametersId,
      this.chatParamsOverride(),
      this.chatParamsDraft()
    );
    await this.chatService.reassignChatParams(chat.id, chatParametersId);
    this.showChatParams.set(false);
    await this.refreshChatParams();
  }
}

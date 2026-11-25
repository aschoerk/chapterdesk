import {
  Component, HostListener, OnDestroy, inject, input, output, signal, effect, afterRenderEffect,
  viewChild, ElementRef, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat/chat.service';
import { isChatLoreNode } from '../../core/chat/chat-lore.service';
import { SettingsService } from '../../core/settings/settings.service';
import { ModelRecencyService } from '../../core/settings/model-recency.service';
import { orderChoiceGroups } from '../../core/settings/model-choices';
import { ModelSelectComponent } from '../model-select/model-select.component';
import { ChatNode, NodeAttachment, Chat } from '../../models/chat';
import type { ModelEntry } from '../../models/chat-config';
import { MarkdownService } from '../../core/chat/markdown.service';
import { markFragmentInSource } from '../../core/util/mark-fragment';
import { NodeEditSession} from '../../core/chat/node-edit-session';
import {ConfirmService, type ConfirmModelOption} from '../../core/dialogs/confirm.service';
import { ChatParametersService } from '../../core/chat/chat-parameters.service';
import {
  isImageMime,
  isTextualMime,
  resolvedMime,
  nodeToMessageContent,
  decodeDataUrlToText,
  estimateContentTokens,
  PREPEND_MAX_TOKENS
} from '../../core/llm/llm-message';
import { formatParametersSummary } from '../../models/chat-parameters';
import {ProjectService} from '../../core/settings/project.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { newId, isSentenceComplete, MAX_COMPLETION_DIRECTIONS } from '../../core/util/helpers';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';
import { IllustrateDialogService } from '../../core/dialogs/illustrate-dialog.service';
import { PrependDialogService } from '../../core/dialogs/prepend-dialog.service';
import { NodeVersionDiffDialogService } from '../../core/dialogs/node-version-diff-dialog.service';
import { ChapterDescriptionsDialogService } from '../../core/dialogs/chapter-descriptions-dialog.service';
import { ChatElaborateService } from '../../core/dialogs/chat-elaborate.service';
import { IllustrateOptions } from '../../models/illustrate-options';
import { LightboxService } from '../../core/dialogs/lightbox.service';
import { LlmFlowRunner } from '../../core/llm/orchestration';
import { type ImageScene } from '../../core/llm/orchestration';
import { type LlmImagePart } from '../../core/llm/llm-message';
import { StreamReveal } from '../../core/llm/stream-reveal';
import { PacedReadService } from '../../core/llm/paced-read.service';
import { readingTimeLabel } from '../../core/llm/reading-time';
import { ReadingMarksService } from '../../core/chat/reading-marks.service';
import { MarkNoteDialogService } from '../../core/dialogs/mark-note-dialog.service';
import { LlmLogService } from '../../core/llm/llm-log.service';
import {
  startHeldAnswerStream,
  type HeldAnswerStream,
  type HeldAnswerStreamDeps
} from '../../core/llm/held-answer-stream';
import { RevealQueue } from '../../core/llm/reveal-queue';
import { ChatUsageService } from '../../core/chat/chat-usage.service';
import { AttachmentClipboardService } from '../../core/clipboard/attachment-clipboard.service';
import { nearestScrollParent } from '../../core/util/dom-metrics';
import { downloadUrl, filenameFromUrl } from '../../core/util/download';
import { buildCtxMenuItems, type CtxMenuItem } from './context-menu';
import { filesToAttachments as convertFilesToAttachments } from './attachments';
import { NodeActionState } from './node-action-state';
import { IllustrationController, type IllustrationCallContext } from './illustration-controller';
import { EditorController } from './editor-controller';
import { SendController } from './send-controller';
import { DialogActionsController } from './dialog-actions';
import { TextActionsController, type TextActionsHost, type EditorSelection } from './text-actions';
import {
  captureRoSourceOffset,
  ensureEditorTopOnScreen,
  findTextRange,
  followLiveScroll,
  scrollTextareaToOffset,
  scrollTopForOffset as draftScrollTopForOffset,
  selectRangeAndScroll,
  sourceOffsetAtPoint
} from './editor-scroll';

/** Fallback for the editable `structure.completeMessage` prompt template —
 *  sent when a generated message did not end like a proper sentence, so the
 *  model finishes that message before the batch continues. */
const COMPLETE_PRECEDING_MESSAGE_FALLBACK = 'complete the preceding message';

/**
 * localStorage key remembering the model the user last chose in the
 * "Rewrite in place" confirmation. When set (and the model is still enabled)
 * it takes precedence over the answer's own model.
 */
export const REWRITE_IN_PLACE_MODEL_KEY = 'chat.rewriteInPlace.model.v1';

/** One `<optgroup>` of the direction editor's model listbox. */
export interface ModelChoiceGroup {
  readonly title: string;
  readonly models: ModelEntry[];
}

@Component({
  selector: 'app-chat-node',
  standalone: true,
  imports: [CommonModule, FormsModule, ModelSelectComponent],
  templateUrl: './chat-node.component.html',
  styleUrl: './chat-node.component.css',
  // Per-CARD instances: the busy state, the editor draft, the send
  // pipeline and the illustration/prompt-record signals belong to exactly
  // one node card, never shared between cards.
  providers: [
    NodeActionState,
    IllustrationController,
    EditorController,
    SendController,
    DialogActionsController,
    TextActionsController,
  ]
})
export class ChatNodeComponent implements OnDestroy {
  private readonly settings = inject(SettingsService);
  public readonly markdownService = inject(MarkdownService);
  readonly chatService = inject(ChatService);
  readonly projectService = inject(ProjectService);
  private readonly flowRunner = inject(LlmFlowRunner);
  private readonly llmLog = inject(LlmLogService);
  private readonly usage = inject(ChatUsageService);
  private readonly parameters = inject(ChatParametersService);
  /** Paced reading of ALREADY-WRITTEN text (the "Read" button on a chapter). */
  private readonly pacedRead = inject(PacedReadService);
  /** Persistent positions / selections + notices for the open chat. */
  readonly readingMarks = inject(ReadingMarksService);
  /** Modal that collects the notice of a mark. */
  private readonly markNoteDialog = inject(MarkNoteDialogService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly illustrateDialog = inject(IllustrateDialogService);
  private readonly lightbox = inject(LightboxService);
  private readonly chapterDescriptionsDialog = inject(ChapterDescriptionsDialogService);

  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  /** Recently used writing models — offered first in every model picker. */
  private readonly modelRecency = inject(ModelRecencyService);

  readonly node = input.required<ChatNode>();
  readonly activeChildId = input<string | null>(null);
  readonly activate = output<string>();  readonly isEditorDragOver = signal(false);

  /** Client-side clipboard for moving/duplicating attachments between nodes. */
  readonly attachmentClipboard = inject(AttachmentClipboardService);
  /** Ids of the attachments selected in THIS node (click toggles, multi-select). */
  readonly selectedAttachmentIds = signal<Set<string>>(new Set());
  readonly selectedCount = computed(() => this.selectedAttachmentIds().size);
  readonly hasAttachmentSelection = computed(() => this.selectedCount() > 0);
  /** Toolbar is visible when there is a selection and/or clipboard content. */
  readonly showAttachmentToolbar = computed(
    () => this.hasAttachmentSelection() || this.attachmentClipboard.hasContent()
  );
  /** Tracks only the node id so the selection resets when a different node is shown. */
  private readonly nodeIdForSelection = computed(() => this.node().id);

  /** "One action at a time" for THIS card (drives every busy label). */
  private readonly actions = inject(NodeActionState);
  /** The illustrate / re-render / prompt-record action sequence. */
  readonly illustration = inject(IllustrationController);
  /** The inline editor: draft text/attachments/model + edit lifecycle. */
  private readonly editor = inject(EditorController);
  /** The send pipeline: composer send, Branch, Insert, Continue batches. */
  private readonly sender = inject(SendController);
  /** The dialog actions: prepend, compare versions/siblings, descriptions. */
  private readonly dialogActions = inject(DialogActionsController);
  /** The read-mode text actions: heading, English check, rewrite, image. */
  private readonly textActions = inject(TextActionsController);
  /** The elaborate dialog — anchored at THIS chapter when opened from its menu. */
  private readonly chatElaborate = inject(ChatElaborateService);

  /** True while any action of this card runs (see `NodeActionState`). */
  readonly isLoading = this.actions.loading;
  /** Which action runs (null when idle) — drives the busy button labels. */
  readonly pendingAction = this.actions.pending;

  // Editor draft state — DELEGATES: the same signal objects, so the template
  // and the specs read `component.contentDraft` etc. unchanged.
  readonly contentDraft = this.editor.contentDraft;
  readonly editAttachments = this.editor.editAttachments;
  readonly branchModelId = this.editor.branchModelId;
  readonly showPreview = this.editor.showPreview;
  readonly editDismissed = this.editor.editDismissed;
  readonly repeatCount = this.editor.repeatCount;

  /** Progress of a storyboard run (done/total) while `pending === 'image'`. */
  readonly imageProgress = this.illustration.imageProgress;
  /** Which recorded prompt attachment is expanded inline. */
  readonly expandedPromptId = this.illustration.expandedPromptId;
  /** Which prompt attachment is being edited for re-render. */
  readonly editingPromptId = this.illustration.editingPromptId;
  /** Live draft of the adapted prompt while editing a prompt record. */
  readonly promptEditDraft = this.illustration.promptEditDraft;

  imageProgressLabel(): string {
    return this.illustration.imageProgressLabel();
  }

  isPromptAttachment(a: NodeAttachment): boolean {
    return this.illustration.isPromptAttachment(a);
  }

  isRefusedPromptAttachment(a: NodeAttachment): boolean {
    return this.illustration.isRefusedPromptAttachment(a);
  }

  attachmentText(a: NodeAttachment): string {
    return this.illustration.attachmentText(a);
  }

  promptAttachmentPrompt(a: NodeAttachment): string {
    return this.illustration.promptAttachmentPrompt(a);
  }

  togglePrompt(a: NodeAttachment): void {
    this.illustration.togglePrompt(a);
  }

  startPromptEdit(a: NodeAttachment): void {
    this.illustration.startPromptEdit(a);
  }

  cancelPromptEdit(): void {
    this.illustration.cancelPromptEdit();
  }

  /** Check-my-English panel state — owned by `TextActionsController`. */
  readonly checkingEnglish = this.textActions.checkingEnglish;
  readonly englishSuggestions = this.textActions.englishSuggestions;
  readonly enabledModels = this.settings.enabledModels;

  private readonly editSession = inject(NodeEditSession);
  readonly showPriorVersions = signal(false);
  /** Closed by default — thinking is hidden unless the user opens it. */
  readonly thinkingClosed = signal(true);
  private static readonly LS_PREPEND = 'chat.prependByNodeId';
  readonly prependEnabled = signal(false);
  /** The stored director text for the current node (custom prefix). */
  readonly prependText = signal('');
  private readonly prependDialog = inject(PrependDialogService);
  private readonly versionDiffDialog = inject(NodeVersionDiffDialogService);

  private readonly editArea = viewChild<ElementRef<HTMLTextAreaElement>>('editArea');
  private readonly streamEnd = viewChild<ElementRef<HTMLElement>>('streamEnd');
  private readonly readContent = viewChild<ElementRef<HTMLElement>>('readContent');
  private readonly ctxMenuEl = viewChild<ElementRef<HTMLElement>>('ctxMenu');
  private readonly thinkingBody = viewChild<ElementRef<HTMLElement>>('thinkingBody');

  /**
   * Source offset captured from the read-only view just before entering the
   * editor: the character whose line must become the FIRST visible line of the
   * textarea (scroll continuity ro → editor). null = no restore needed.
   */
  private pendingScrollOffset: number | null = null;

  /** Viewport coordinates of the open right-click menu, or null when closed. */
  readonly ctxMenu = signal<{ x: number; y: number } | null>(null);
  /** Measured size of the open menu, used to clamp it into the viewport. */
  private readonly ctxSize = signal<{ w: number; h: number } | null>(null);
  /**
   * The chat-node whose context menu is currently open. Only one menu is open
   * at a time — opening a new one closes the previous (keeps the DOM clean).
   */
  private static openMenu: ChatNodeComponent | null = null;

  readonly isEditing = computed(() =>
    this.editSession.editingNodeId() === this.node().id
  );

  /**
   * One-line token/cost label shown beside the char count of an assistant
   * node, e.g. `in 128 · out 342 · cached 10 · cost $0.0004`. Data comes
   * reactively from the LLM log entries attributed to this node (see
   * ChatUsageService); null when the node has no usage recorded.
   */
  readonly nodeUsageLabel = computed(() => {
    const n = this.node();
    if (n.role !== 'assistant') return null;
    // Persisted per-node usage (server-shared, survives reloads / browsers)
    // wins; the browser LLM log is only a fallback for legacy nodes without
    // persisted values.
    const u = this.usage.usageFromNode(n) ?? this.usage.nodeUsage(n.id);
    if (!u) return null;
    const parts: string[] = [];
    if (u.input) parts.push(`${this.i18n.t('logs.usageIn')} ${u.input}`);
    if (u.output) parts.push(`${this.i18n.t('logs.usageOut')} ${u.output}`);
    if (u.cached) parts.push(`${this.i18n.t('logs.usageCached')} ${u.cached}`);
    if (u.cost) parts.push(`${this.i18n.t('logs.usageCost')} ${this.formatCost(u.cost)}`);
    return parts.length ? parts.join(' · ') : null;
  });

  /** USD cost label with adaptive precision (same as the /logs page). */
  formatCost(cost: number): string {
    if (!Number.isFinite(cost)) return '';
    const digits = cost >= 1 ? 2 : cost >= 0.01 ? 4 : 6;
    return this.i18n.formatNumber(cost, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  hasThinking(): boolean {
    return !!this.node().thinking?.trim();
  }

  isThinkingLive(): boolean {
    const n = this.node();
    // Only the PRESENTED node shows the thinking/waiting spinner — a background
    // buffer (filling invisibly in a queue) must not surface a "waiting for the
    // model" spinner on an empty, not-yet-revealed bubble.
    return n.role === 'assistant' && this.chatService.presentedNodeId() === n.id;
  }

  /**
   * True while an ASSISTANT node has an active LLM stream — including a
   * BACKGROUND buffer of the presenter queue (generating but not yet revealed).
   * Such a node must show a spinner instead of a misleading "Generation
   * stopped" label, and it must not be followed/scrolled into view (follow
   * only targets the PRESENTED node).
   */
  isGeneratingAssistant(): boolean {
    const n = this.node();
    return n.role === 'assistant' && this.chatService.isGenerating(n.id);
  }


  priorVersions(): ChatNode[] {
    return this.chatService.getPriorVersions(this.node());
  }

  priorVersionHtml(n: ChatNode): string {
    return this.markdownService.toHtml(n.content ?? '');
  }

  get siblings(): ChatNode[] {
    return this.chatService.getSiblingsOf(this.node());
  }

  get hasSiblings(): boolean {
    return this.siblings.length > 1;
  }

  /** Siblings (other than this node) that have content worth comparing. */
  comparableSiblings(): ChatNode[] {
    const n = this.node();
    return this.siblings.filter((s) => s.id !== n.id && !!s.content?.trim());
  }

  get siblingIndex(): { current: number; total: number } {
    const list = this.siblings;
    if (list.length === 0) return { current: 0, total: 0 };

    const activeId = this.activeChildId() ?? list[0]?.id;
    const index = list.findIndex(s => s.id === activeId);
    return {
      current: (index >= 0 ? index : 0) + 1,
      total: list.length
    };
  }

  /**
   * The in-thread composer: a direction (user) node with NO children yet.
   * Only the pending terminal leaf is "unsent". A direction that is followed
   * by ANY node — an answer, a following direction, an empty composer leaf
   * created after "Delete Continuation"/"Remove (keep children)", a lore or
   * structural node — is an existing direction, so editing it must offer
   * Save (OK / Branch / Insert), not Send.
   */
  isUnsentQuestion(): boolean {
    const n = this.node();
    if (n.role !== 'user' || isChatLoreNode(n)) return false;
    return this.chatService.getChildren(n.id).length === 0;
  }

  isQuestion(): boolean {
    const n = this.node();
    return n.role === 'user' && !isChatLoreNode(n);
  }

  /** True for a materialized chat-lore node (role `lore` or legacy markers). */
  isLoreNode(): boolean {
    return isChatLoreNode(this.node());
  }

  /** User-facing role label of a node (for confirm messages / badges). */
  roleLabel(node: ChatNode): string {
    if (node.role === 'user') return this.i18n.t('node.roleUser');
    if (node.role === 'assistant') return this.i18n.t('node.roleAssistant');
    if (node.role === 'lore') return this.i18n.t('node.roleLore');
    return this.i18n.t('node.roleSystem');
  }

  /** Last node on the active path (no current children). */
  isLeafNode(): boolean {
    return this.chatService.getChildren(this.node().id).length === 0;
  }

  /** Empty unsent leaf question with the inline editor closed. */
  showClosedContinue(): boolean {
    const n = this.node();
    return this.isUnsentQuestion()
      && this.isLeafNode()
      && !this.isEditing()
      && !n.content?.trim()
      && !(n.attachments?.length);
  }

  resizeTextarea(): void {
    const textarea = this.editArea()?.nativeElement;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = window.innerHeight * 0.55;
    textarea.style.height = `${Math.min(textarea.scrollHeight + 4, maxHeight)}px`;
    // Scroll continuity: once the editor has rendered, restore the ro view's
    // target spot (the clicked caret offset, else the top-visible sentence) as
    // the FIRST visible line of the textarea.
    if (this.pendingScrollOffset != null) {
      this.scrollTextareaToSourceOffset(textarea, this.pendingScrollOffset);
      this.pendingScrollOffset = null;
    }
  }

  /**
   * The source offset of the text that is currently the FIRST visible one in
   * the read-only view (the sentence sitting at the top of the visible area).
   * Returns null when there is nothing to restore (no rendered content, nothing
   * visible) — the editor then simply starts at the top. A delegate over the
   * shared `editor-scroll` module helper (kept as a method so specs can stub
   * the scroll-parent look-up).
   */
  private captureRoScrollOffset(): number | null {
    return captureRoSourceOffset(
      this.readContent()?.nativeElement,
      this.node().content ?? '',
      this.scrollParentOf.bind(this)
    );
  }

  /**
   * The source offset of the character the user clicked in the read-only view
   * (click-to-edit). Returns null when the click can't be mapped to a source
   * offset (no text at the point, no layout). A delegate over the shared
   * `editor-scroll` module helper (kept as a method so specs can stub the
   * caret look-up).
   */
  private captureRoClickOffset(clientX: number, clientY: number): number | null {
    return sourceOffsetAtPoint(
      this.readContent()?.nativeElement,
      this.node().content ?? '',
      clientX,
      clientY
    );
  }

  /**
   * The nearest scrollable ancestor of `el`. A delegate over the shared module
   * helper so specs can stub the lookup (module functions aren't spyable).
   */
  private scrollParentOf(el: HTMLElement): HTMLElement | null {
    return nearestScrollParent(el);
  }

  /**
   * Scroll the editor textarea so the character at `offset` in the draft is
   * its first visible line (mirroring the ro view's top sentence). A hidden
   * mirror div reproduces the textarea's box + font metrics to measure the
   * vertical position of that character; the browser clamps the scrollTop.
   * A delegate over the shared `editor-scroll` module helper (kept as a method
   * so specs can stub the scroll — module functions aren't spyable).
   */
  private scrollTextareaToSourceOffset(textarea: HTMLTextAreaElement, offset: number): void {
    scrollTextareaToOffset(textarea, offset, this.contentDraft());
  }

  /**
   * The scrollTop that would place the character at `offset` (of the current
   * draft) at the FIRST visible line of the editor, or null when not measurable
   * (empty draft / no layout). A hidden mirror div that duplicates the
   * textarea's box + font metrics measures the vertical position of that
   * character; the textarea's scrollTop is relative to its CONTENT box, so the
   * top padding is subtracted to land the line at the very top. A delegate
   * over the shared `editor-scroll` module helper.
   */
  private scrollTopForOffset(textarea: HTMLTextAreaElement, offset: number): number | null {
    return draftScrollTopForOffset(textarea, offset, this.contentDraft());
  }

  private scheduleResize(): void {
    // Capture the scroll-restore target BEFORE the resize consumes it: the
    // ro view's target spot (clicked caret offset, else top-visible sentence)
    // must stay the editor's first visible line AND the caret must sit there.
    const savedOffset = this.pendingScrollOffset;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.resizeTextarea();
        this.applyEditorScrollAndCaret(savedOffset);
      });
    });
  }

  /**
   * After the editor has rendered, focus it and position it where the
   * read-only view was scrolled: the target sentence becomes the first visible
   * line AND the caret sits at its start. Plain focus() would put the caret at
   * the END of the content and auto-scroll the textarea to the bottom
   * (observed in Chromium) — the "editor shows the last part of the node" bug.
   * Order matters: focus first, then re-apply the target scrollTop (overriding
   * the focus auto-scroll), then place the caret — its line is already the
   * first visible one, so no further scrolling happens.
   */
  private applyEditorScrollAndCaret(savedOffset: number | null): void {
    const textarea = this.editArea()?.nativeElement;
    if (!textarea) return;
    const clamped = Math.max(0, Math.min(savedOffset ?? 0, this.contentDraft().length));
    const scrollTop = this.scrollTopForOffset(textarea, clamped);
    textarea.focus();
    textarea.scrollTop = scrollTop ?? 0;
    textarea.setSelectionRange(clamped, clamped);
    // Focus may have auto-scrolled the OUTER container to reveal the textarea
    // (often to its bottom) — make sure the UPPER part of the textarea is on
    // screen, otherwise the restored first line would be hidden above the fold.
    this.ensureEditorTopVisible();
    // The restore is done — a later resize (input/attach) must not re-apply it.
    this.pendingScrollOffset = null;
  }

  /**
   * Make sure the TOP of the editor textarea is visible in the outer scroll
   * container — at least the upper part must be on screen, even when the node
   * sits deep in the conversation or the textarea is taller than the visible
   * band. Only scrolls the OUTER container (the textarea's own scrollTop is
   * the scroll-continuity restore and is left untouched). A tiny top margin
   * keeps the first line from being flush with the very edge. Never scrolls
   * when the top is already visible and on screen. A delegate over the shared
   * `editor-scroll` module helper (kept as a method so specs can stub the
   * scroll-parent look-up).
   */
  private ensureEditorTopVisible(): void {
    const textarea = this.editArea()?.nativeElement;
    if (!textarea) return;
    ensureEditorTopOnScreen(textarea, this.scrollParentOf.bind(this));
  }

  /**
   * Single click on the read-only content: make the node ACTIVE (the active
   * child under its parent, shown in the navbar) without opening the editor.
   * The tree stays scrollable with the keyboard — entering the editor is
   * reserved for a double click (see onContentDblClick).
   */
  onContentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, .chip, .file-link')) {
      return;
    }
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      return;
    }
    if (this.chatService.isGenerating(this.node().id)) {
      return;
    }
    this.activate.emit(this.node().id);
  }

  /**
   * Double click on the read-only content: open the inline editor. A double
   * click normally selects a word, so unlike the single click there is no
   * text-selection guard here — the user's intent is clearly to edit.
   */
  onContentDblClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, .chip, .file-link')) {
      return;
    }
    if (this.chatService.isGenerating(this.node().id)) {
      return;
    }
    // Capture the exact clicked character so the editor opens with the caret
    // there and keeps that spot on screen (scroll continuity ro → editor).
    const caretOffset = this.captureRoClickOffset(event.clientX, event.clientY);
    this.startEdit('user', caretOffset);
  }

  async startEdit(source: 'user' | 'auto' = 'user', caretOffset?: number | null): Promise<void> {
    if (this.isEditing()) return;
    const n = this.node();
    // Remember where the read-only view was scrolled so the editor can open on
    // the SAME first visible sentence. Captured BEFORE the session flips into
    // edit mode — the ro content is replaced by the textarea as soon as it does.
    // A click-to-edit caret offset (the exact clicked character) wins over the
    // top-visible sentence: the editor then opens with the caret at that spot
    // and scrolls so that spot is its first visible line.
    this.pendingScrollOffset = caretOffset ?? this.captureRoScrollOffset();
    const ok = await this.editSession.begin({
      chatId: n.chatId,
      nodeId: n.id,
      text: n.content || '',
      attachments: n.attachments || []
    }, source);

    if (!ok) {
      this.pendingScrollOffset = null;
      return;
    }

    // Editing a node re-includes it into the model stream: the user is
    // touching the content, so it is relevant again. Permanently clear the
    // exclusion flags — the node immediately reappears in the navbar and is no
    // longer treated as "kept for reading only".
    if (n.excludeFromContext || n.excludeAfterSend) {
      await this.chatService.patchNode(n.chatId, n.id, {
        excludeFromContext: false,
        excludeAfterSend: false
      });
    }

    // Draft state (text / attachments / model / dismissed flag) belongs to
    // the EditorController; opening the textarea and restoring the scroll
    // position is DOM work and stays here.
    this.editor.openDraft(n);
    this.scheduleResize();
  }

  /**
   * Model shown in the question listbox:
   * 1. already-queried question → the LLM that produced its answer
   * 2. else project.defaultModelId, if the chat belongs to a project
   * 3. else defaultModelId of a topic that contains that project
   * 4. else the configured "default" generation task model
   * 5. else first enabled model (last-resort fallback)
   */
  resolvePreferredModelId(node: ChatNode): string {
    const models = this.enabledModels();
    const match = (ref?: string | null) =>
      models.find(m => !!ref && (m.id === ref || m.modelId === ref));

    const queried = node.role === 'user' &&
      this.chatService.getChildren(node.id).some(c => c.role === 'assistant');

    if (queried) {
      const fromUser = match(node.modelId);
      if (fromUser) return fromUser.modelId;

      const currentAssistant = this.chatService.getChildren(node.id)
          .find(c => c.role === 'assistant' && c.isCurrent)
        ?? this.chatService.getChildren(node.id).find(c => c.role === 'assistant');
      const fromAnswer = match(currentAssistant?.modelId);
      if (fromAnswer) return fromAnswer.modelId;
    }

    const chatId = node.chatId || this.chatService.currentChatId();
    const chat = this.chatService.chats().find(c => c.id === chatId);
    const project = this.projectService.getProject(chat?.projectId ?? null);

    const fromProject = match(project?.defaultModelId);
    if (fromProject) return fromProject.modelId;

    if (project) {
      const topics = this.projectService.topics().filter(t =>
        Array.isArray(t.projectIds) && t.projectIds.includes(project.id)
      );
      for (const topic of topics) {
        const fromTopic = match(topic.defaultModelId);
        if (fromTopic) return fromTopic.modelId;
      }
    }

    return this.generation.modelFor('default')?.modelId
      || models[0]?.modelId
      || '';
  }  // ------------------------------------------------------------------
  // Illustrate — generate a picture for this beat from the chat so far
  // ------------------------------------------------------------------

  /**
   * Whether the user-facing "Illustrate" action is available for this node.
   * Illustrating is only offered on assistant (chapter) nodes — the beat the
   * picture depicts — and only when it has text to depict.
   */
  canIllustrate(): boolean {
    const n = this.node();
    return n.role === 'assistant' && !!n.content?.trim();
  }

  /**
   * The MARKED part of the current node — the text the user has selected just
   * before pressing Illustrate. Captured from the editor's textarea selection
   * while editing, otherwise from the DOM selection inside the rendered
   * (read-only) content, mirroring the rewrite-selection / create-image
   * flows. Empty when nothing is marked (the whole chapter stays the scene).
   */
  private captureMarkedSceneText(): string {
    if (this.isEditing()) {
      const ta = this.editArea()?.nativeElement;
      if (!ta) return '';
      const s = Math.min(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
      const e = Math.max(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
      return this.contentDraft().slice(s, e).trim();
    }
    const contentEl = this.readContent()?.nativeElement;
    const selection = window.getSelection();
    if (!contentEl || !selection || selection.isCollapsed || selection.rangeCount === 0) return '';
    if (!contentEl.contains(selection.anchorNode) || !contentEl.contains(selection.focusNode)) return '';
    return selection.toString().trim();
  }

  /** Paint streamed text incrementally onto the in-flux assistant node. */
  private paintAnswer(nodeId: string, content: string, thinking: string): void {
    this.chatService.updateNodes(list =>
      list.map(n => (n.id === nodeId ? { ...n, content, thinking } : n))
    );
  }

  /**
   * Run a structural flow through the orchestration `LlmFlowRunner` (branch /
   * insert / regenerate / rewrite / prepend) with loading + pending-action
   * tracking. After the flow, activates the flow's target node and surfaces
   * the outcome. `builder` supplies the flow vars (content, director text,
   * …); `pending` is the UI spinner label.
   */
  private async runFlow(
    usecase: 'send-branch' | 'send-insert' | 'send-regenerate' | 'send-rewrite' | 'send-prepend' | 'send-chapter-descriptions',
    pending: 'branch' | 'insert' | 'send' | 'prepend' | 'chapterDescriptions',
    builder?: (build: { vars: Record<string, unknown> }) => void
  ): Promise<boolean> {
    const node = this.node();
    const chatId = this.chatService.currentChatId();
    if (!chatId) return false;
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    const opSignal = this.chatService.beginChatOperation(chatId, 'stream');
    if (!opSignal) {
      this.toast.error(this.i18n.t('node.busy'));
      return false;
    }
    this.isLoading.set(true);
    this.pendingAction.set(pending);
    try {
      const build: { chat: Chat; node: ChatNode; usecase: typeof usecase; vars: Record<string, unknown> } = {
        chat: chat as Chat,
        node,
        usecase,
        vars: {}
      };
      builder?.(build);
      const slots = await this.flowRunner.run(build as never, { signal: opSignal });
      const flow = slots.flow?.value;
      if (flow?.activateId) this.activate.emit(flow.activateId);
      return true;
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.failed', { error: err?.message || err }));
      return false;
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
      this.chatService.endChatOperation(chatId);
    }
  }

  /** Generate a chapter heading for THIS assistant answer (delegates to `TextActionsController`). */
  async generateHeading(): Promise<void> {
    await this.textActions.generateHeading();
  }

  /** "Check my English" — three improved variants of the direction (delegates to `TextActionsController`). */
  async checkMyEnglish(): Promise<void> {
    await this.textActions.checkMyEnglish();
  }

  /** Apply a chosen variant to the draft (or just the marked range) — delegates to `TextActionsController`. */
  applyEnglishSuggestion(text: string): void {
    this.textActions.applyEnglishSuggestion(text);
  }

  dismissEnglishCheck(): void {
    this.textActions.dismissEnglishCheck();
  }

  /** Rewrite the marked text inside the editor — delegates to `TextActionsController`. */
  async openRewriteDialog(): Promise<void> {
    await this.textActions.openRewriteDialog();
  }

  /** Rewrite a marked passage of the rendered chapter — delegates to `TextActionsController`. */
  async openReadRewriteDialog(): Promise<void> {
    await this.textActions.openReadRewriteDialog();
  }

  /** "Create image" of a marked passage of the rendered chapter — delegates to `TextActionsController`. */
  async openReadCreateImageDialog(): Promise<void> {
    await this.textActions.openReadCreateImageDialog();
  }

  /**
   * Delete this assistant answer and its subtree, then resend the parent
   * user request. Confirms first when the answer already has children.
   */
  async regenerateAnswer(): Promise<void> {
    const node = this.node();
    if (node.role !== 'assistant' || this.isLoading() || this.chatService.isGenerating(node.id)) {
      return;
    }

    const children = this.chatService.getChildren(node.id);
    if (children.length > 0) {
      const extra = this.collectSubtree(node.id).length - 1;
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.regenerateTitleAsk'),
        message: extra > 0
          ? this.i18n.t('node.regenerateMsgExtra', { count: extra })
          : this.i18n.t('node.regenerateMsg'),
        confirmLabel: this.i18n.t('node.regenerate'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true
      });
      if (!ok) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const question = node.parentId
      ? this.chatService.nodes().find(n => n.id === node.parentId)
      : undefined;
    if (!question || question.role !== 'user') {
      this.toast.error(this.i18n.t('node.regenerateNoParent'));
      return;
    }

    await this.runFlow('send-regenerate', 'send', build => {
      // The flow deletes the ANSWER (this.node) and re-streams under its
      // parent question — no extra vars needed.
    });
  }

  /**
   * Re-generate THIS answer in place: same LLM call / context as regenerate,
   * but the following text (this node's subtree) is preserved — only this
   * answer's content is replaced. Works by removing just this node
   * ({@link ChatService.deleteNode keepChildren}) and re-hanging the
   * preserved following text under the freshly generated answer.
   */
  async regenerateInPlace(): Promise<void> {
    const node = this.node();
    if (node.role !== 'assistant' || this.isLoading() || this.chatService.isGenerating(node.id)) {
      return;
    }

    const question = node.parentId
      ? this.chatService.nodes().find(n => n.id === node.parentId)
      : undefined;
    if (!question || question.role !== 'user') {
      this.toast.error(this.i18n.t('node.regenerateNoParent'));
      return;
    }

    // Ask in the confirmation dialog — which also carries an EDITABLE copy of
    // the original prompt (the direction that produced this answer) plus a
    // model picker, so the rewrite can run against an adapted direction with a
    // different model. Cancel resolves null.
    const children = this.chatService.getChildren(node.id);
    const models = this.enabledModels();
    const edited = await this.confirm.askWithPrompt({
      title: this.i18n.t('node.regenerateInPlaceTitleAsk'),
      message: children.length > 0
        ? this.i18n.t('node.regenerateInPlaceMsgExtra', { count: children.length })
        : this.i18n.t('node.regenerateInPlaceMsg'),
      confirmLabel: this.i18n.t('node.regenerateInPlace'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true,
      prompt: {
        label: this.i18n.t('node.rewritePromptLabel'),
        value: question.content ?? '',
        placeholder: this.i18n.t('node.rewritePromptPh'),
        model: models.length
          ? {
              label: this.i18n.t('node.rewriteModelLabel'),
              title: this.i18n.t('node.rewriteModelTitle'),
              value: this.rewriteInPlaceModelId(node, question, models),
              options: models.map(m => ({
                id: m.modelId,
                label: m.displayName,
                providerId: m.providerId
              })),
              // Same ordering as every other writing-model picker:
              // current → recently used → all models.
              groups: this.rewriteModelGroups(
                models,
                this.rewriteInPlaceModelId(node, question, models)
              )
            }
          : undefined
      }
    });
    if (edited == null) return; // cancelled
    const content = edited.text.trim();
    if (!content) return; // the dialog keeps Confirm disabled while blank
    const modelId = edited.modelId;
    if (modelId) this.rememberRewriteInPlaceModel(modelId);

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    // Only an actually EDITED prompt is sent as an override — an unchanged one
    // must not create a pointless new version of the question.
    const changed = content !== (question.content ?? '').trim();
    await this.runFlow('send-rewrite', 'send', build => {
      // The flow deletes only THIS answer (keeping children) and re-streams
      // under its parent question, re-adopting the preserved children.
      build.vars['keepChildren'] = true;
      if (changed) build.vars['content'] = content;
      // A model chosen in the dialog overrides the node's own write model.
      if (modelId) {
        build.vars['modelId'] = modelId;
        if (edited.providerId) build.vars['providerId'] = edited.providerId;
      }
    });
  }

  /**
   * The model pre-selected in the "Rewrite in place" confirmation: the last
   * remembered choice when still enabled, else the model that produced the
   * answer (or the direction that asked for it), else the first enabled model.
   */
  private rewriteInPlaceModelId(
    answer: ChatNode,
    question: ChatNode,
    models: readonly ModelEntry[]
  ): string {
    let remembered = '';
    try {
      remembered = localStorage.getItem(REWRITE_IN_PLACE_MODEL_KEY) ?? '';
    } catch {
      /* best-effort — memory is non-fatal */
    }
    const match = models.find(m => m.modelId === remembered || m.id === remembered)
      ?? models.find(m => m.modelId === answer.modelId || m.id === answer.modelId)
      ?? models.find(m => m.modelId === question.modelId || m.id === question.modelId)
      ?? models[0];
    return match?.modelId ?? '';
  }

  /** Remember the model chosen in the "Rewrite in place" confirmation. */
  private rememberRewriteInPlaceModel(modelId: string): void {
    try {
      localStorage.setItem(REWRITE_IN_PLACE_MODEL_KEY, modelId);
    } catch {
      /* best-effort — memory is non-fatal */
    }
  }

  /**
   * The confirm dialog's model picker, grouped like every other writing-model
   * listbox: current choice, then the recently used models, then the rest.
   */
  private rewriteModelGroups(
    models: readonly ModelEntry[],
    currentId: string,
  ): { label: string; options: ConfirmModelOption[] }[] {
    const toOption = (m: ModelEntry): ConfirmModelOption => ({
      id: m.modelId,
      label: m.displayName,
      providerId: m.providerId,
    });
    return orderChoiceGroups(models, currentId, this.modelRecency.recentIds(), {
      current: this.i18n.t('node.modelGroupCurrent'),
      recent: this.i18n.t('node.modelGroupRecent'),
      all: this.i18n.t('node.modelGroupAll'),
    }).map(g => ({ label: g.title, options: g.items.map(toOption) }));  }

  async deleteNodeOnly(): Promise<void> {
    const node = this.node();
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;
    const hasPayload = !!node.content?.trim() || !!(node.attachments && node.attachments.length);
    if (hasPayload) {
      const childCount = this.chatService.getChildren(node.id).length;
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.removeTitleAsk'),
        message: childCount > 0
          ? this.i18n.t('node.removeMsgChildren', { role: this.roleLabel(node), count: childCount })
          : this.i18n.t('node.removeMsg', { role: this.roleLabel(node) }),
        confirmLabel: this.i18n.t('node.remove'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true
      });
      if (!ok) return;
    }
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    const parentId = node.parentId;
    try {
      await this.chatService.deleteNode(chatId, node.id, { keepChildren: true });
      const remaining = this.chatService.getChildren(parentId);
      if (remaining.length > 0) {
        const newest = remaining.reduce((a, b) =>
          this.nodeTimestamp(a) >= this.nodeTimestamp(b) ? a : b
        );
        this.activate.emit(newest.id);
      }
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.removeFailed', { error: err?.message || err }));
    }
  }

  async deleteNode(): Promise<void> {
    const node = this.node();
    const subtree = this.collectSubtree(node.id);
    const nonTrivial = subtree.filter(n => !this.isTrivialNode(n));

    if (nonTrivial.length > 0) {
      const extra = subtree.length - 1;
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.deleteTitleAsk'),
        message: extra > 0
          ? this.i18n.t('node.deleteMsgExtra', { role: this.roleLabel(node), count: extra, filled: nonTrivial.length })
          : this.i18n.t('node.deleteMsg', { role: this.roleLabel(node) }),
        confirmLabel: this.i18n.t('common.delete'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true
      });
      if (!ok) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const parentId = node.parentId;

    try {
      await this.chatService.deleteNode(chatId, node.id);
      const remaining = parentId ? this.chatService.getChildren(parentId) : [];
      if (remaining.length > 0) {
        const newest = remaining.reduce((a, b) =>
          this.nodeTimestamp(a) >= this.nodeTimestamp(b) ? a : b
        );
        this.activate.emit(newest.id);
      }

      // After a subtree delete the active path may end on the remaining
      // question (user) — ensure a fresh composer leaf under it so the user
      // can continue ("Delete Continuation" must leave a leaf).
      await this.chatService.ensureDraftAtLeaf(chatId);
      await this.chatService.ensureDraftUnderUserLeaf(chatId);
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.deleteFailed', { error: err?.message || err }));
    }
  }

  private isTrivialNode(n: ChatNode): boolean {
    const emptyText = !n.content?.trim();
    const noFiles = !(n.attachments && n.attachments.length);
    return emptyText && noFiles;
  }

  private nodeTimestamp(n: ChatNode): number {
    const raw = n.updatedAt || n.createdAt || '';
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }

  private collectSubtree(rootId: string): ChatNode[] {
    const all = this.chatService.nodes();
    const result: ChatNode[] = [];
    const walk = (id: string) => {
      const n = all.find(x => x.id === id);
      if (n) result.push(n);
      all.filter(x => x.parentId === id).forEach(child => walk(child.id));
    };
    walk(rootId);
    return result;
  }

  prevSibling(): void {
    const list = this.chatService.getSiblingsOf(this.node());
    if (list.length < 2) return;

    const activeId = this.activeChildId() ?? list[0].id;
    const index = list.findIndex(s => s.id === activeId);
    const prev = list[(index - 1 + list.length) % list.length];
    this.activate.emit(prev.id);
  }

  nextSibling(): void {
    const list = this.siblings;
    if (list.length < 2) return;

    const activeId = this.activeChildId() ?? list[0].id;
    const index = list.findIndex(s => s.id === activeId);
    const next = list[(index + 1) % list.length];
    this.activate.emit(next.id);
  }

  // ------------------------------------------------------------------
  // Right-click context menu (browser right-click)
  // ------------------------------------------------------------------

  /**
   * Open the in-app context menu at the pointer position. The browser native
   * menu is suppressed for the node; right-clicking inside the editor
   * (cut/copy/paste) or on rendered links/images keeps the native menu.
   */
  openNodeMenu(event: MouseEvent): void {
    if (this.isNativeContextTarget(event.target as HTMLElement | null)) return;
    event.preventDefault();
    event.stopPropagation();
    // Remember the CHARACTER under the pointer: the menu can then mark it as
    // the start of the next paced read ("set next read position at cursor").
    this.ctxClickOffset = this.captureRoClickOffset(event.clientX, event.clientY);
    // Only one node menu at a time: close the previously open one (if any)
    // before opening this node's menu.
    if (ChatNodeComponent.openMenu && ChatNodeComponent.openMenu !== this) {
      ChatNodeComponent.openMenu.closeCtxMenu();
    }
    ChatNodeComponent.openMenu = this;
    this.ctxMenu.set({ x: event.clientX, y: event.clientY });
    this.ctxSize.set(null); // re-measure once the menu renders
  }

  /** Suppress the native menu on the custom menu itself. */
  preventCtxDefault(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  closeCtxMenu(): void {
    if (ChatNodeComponent.openMenu === this) {
      ChatNodeComponent.openMenu = null;
    }
    this.ctxMenu.set(null);
    this.ctxSize.set(null);
    // NOTE: `ctxClickOffset` is deliberately NOT cleared here — the chosen
    // action runs AFTER the menu closed and still needs the cursor position.
    // It is overwritten by the next `openNodeMenu`.
  }

  /** Character offset in the source that was right-clicked (null if unknown). */
  private ctxClickOffset: number | null = null;

  /**
   * Mark the right-clicked character as where reading continues.
   *
   *  - While a read is ACTIVE (typically paused) it takes effect immediately:
   *    the session relocates to this chapter/offset and stays frozen, so the
   *    next Resume continues from here.
   *  - Otherwise it is remembered for the next Ctrl+R / Read.
   */
  setNextReadPosition(): void {
    const node = this.node();
    const offset = this.ctxClickOffset ?? 0;
    if (this.pacedRead.active()) {
      void this.pacedRead.relocate(this.pacedReadItemsFrom(node), node.id, offset);
    } else {
      this.pacedRead.setNextReadPosition(node.id, offset);
    }
    this.toast.success(this.i18n.t('node.readPositionSet'));
  }

  /** Chapters to reveal when reading starts at `node` (it + the followers). */
  private pacedReadItemsFrom(node: ChatNode): { key: string; text: string }[] {
    const path = this.chatService.getActivePath();
    const idx = path.findIndex(n => n.id === node.id);
    const from = idx >= 0 ? path.slice(idx) : [node];
    return from
      .filter(n => n.role === 'assistant' && (n.content ?? '').trim().length > 0)
      .map(n => ({ key: n.id, text: n.content ?? '' }));
  }

  /** Drop a pending read position for this chapter. */
  clearNextReadPosition(): void {
    this.pacedRead.clearNextReadPosition();
  }

  /**
   * Marked text inside this node's rendered content, mapped back to the
   * source offsets. null when nothing (or something outside this node) is
   * selected.
   */
  private captureSelectionMark(): { start: number; end: number; quote: string } | null {
    const contentEl = this.readContent()?.nativeElement;
    const selection = window.getSelection();
    if (!contentEl || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (!contentEl.contains(selection.anchorNode) || !contentEl.contains(selection.focusNode)) return null;
    const quote = selection.toString().trim();
    if (!quote) return null;
    const loc = markFragmentInSource(this.node().content ?? '', quote);
    if (!loc) return { start: 0, end: 0, quote };
    return { start: loc.index, end: loc.index + loc.length, quote };
  }

  /** True when a part of this node's text is currently selected. */
  hasContentSelection(): boolean {
    return this.captureSelectionMark() !== null;
  }

  /**
   * The textarea selection while the editor is open, else null. A collapsed
   * caret counts as "no selection" — the read/edit actions only act on a
   * marked range.
   */
  private captureEditorSelection(): EditorSelection | null {
    if (!this.isEditing()) return null;
    const ta = this.editArea()?.nativeElement;
    if (!ta) return null;
    const s = Math.min(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    const e = Math.max(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    return e > s ? { start: s, end: e } : null;
  }

  /** The text marked in the rendered (read-only) content, else null. */
  private captureReadSelection(): string | null {
    return this.captureSelectionMark()?.quote ?? null;
  }

  /** Re-focus the editor and select `start .. start+length`. */
  private focusEditorRange(start: number, length: number): void {
    const ta = this.editArea()?.nativeElement;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start, start + length);
    });
  }

  /**
   * Add a PERSISTENT position mark at the right-clicked character (or at the
   * collapsed text caret, e.g. for Ctrl+M) and ask for its notice in the
   * modal. Cancelling the modal does NOT create the mark.
   */
  async markPosition(): Promise<void> {
    const node = this.node();
    const offset = this.ctxClickOffset ?? this.captureCaretOffset() ?? 0;
    const note = await this.markNoteDialog.open({ isPosition: true, note: '' });
    if (note == null) return;
    const mark = await this.readingMarks.add({ nodeId: node.id, start: offset, note });
    if (!mark) return;
    this.toast.success(this.i18n.t('node.markAdded'));
  }

  /**
   * Add a PERSISTENT mark for the selected text (quote + range) and ask for
   * its notice in the modal. Cancelling does NOT create the mark.
   */
  async markSelection(): Promise<void> {
    const node = this.node();
    const range = this.captureSelectionMark();
    if (!range) {
      this.toast.error(this.i18n.t('node.markNoSelection'));
      return;
    }
    const note = await this.markNoteDialog.open({
      isPosition: false,
      quote: range.quote,
      note: ''
    });
    if (note == null) return;
    const mark = await this.readingMarks.add({
      nodeId: node.id,
      start: range.start,
      end: range.end,
      quote: range.quote,
      note
    });
    if (!mark) return;
    this.toast.success(this.i18n.t('node.markAdded'));
  }

  /**
   * Source offset of the collapsed text caret inside this node (clicking into
   * the text leaves one). Used by Ctrl+M when nothing is selected.
   */
  private captureCaretOffset(): number | null {
    const contentEl = this.readContent()?.nativeElement;
    const selection = window.getSelection();
    if (!contentEl || !selection || selection.rangeCount === 0) return null;
    if (!contentEl.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rect = range.getClientRects?.()[0] ?? range.getBoundingClientRect?.();
    if (!rect) return null;
    return this.captureRoClickOffset(rect.left + 1, rect.top + 1);
  }

  private isNativeContextTarget(el: HTMLElement | null): boolean {
    if (!el) return false;
    // Editor internals (cut/copy/paste) and rendered links / images have no
    // equivalent in the custom menu — keep the browser menu for them.
    return !!el.closest('textarea, input, select, a, img, .file-link');
  }

  /** Position the menu at the pointer (left), clamped inside the viewport. */
  ctxMenuLeftPx(): number {
    const menu = this.ctxMenu();
    if (!menu) return 0;
    const w = this.ctxSize()?.w ?? 220;
    return Math.max(8, Math.min(menu.x, window.innerWidth - w - 8));
  }

  /** Position the menu at the pointer (top), clamped inside the viewport. */
  ctxMenuTopPx(): number {
    const menu = this.ctxMenu();
    if (!menu) return 0;
    const h = this.ctxSize()?.h ?? 320;
    return Math.max(8, Math.min(menu.y, window.innerHeight - h - 8));
  }

  /** Build the menu rows for the current node (role- and state-aware). A
   *  pure delegate over the shared `context-menu` module builder — the node
   *  state and action callbacks are supplied so the menu logic lives outside
   *  the component. */
  ctxMenuItems(): CtxMenuItem[] {
    const n = this.node();
    return buildCtxMenuItems({
      node: n,
      busy: this.isLoading() || this.chatService.isGenerating(n.id),
      loading: this.isLoading(),
      canIllustrate: this.canIllustrate(),
      showClosedContinue: this.showClosedContinue(),
      isUnsentQuestion: this.isUnsentQuestion(),
      hasPriorVersions: this.priorVersions().length > 0,
      hasComparableSiblings: this.comparableSiblings().length > 0,
      notEditing: !this.isEditing(),
      hasReadPosition: this.pacedRead.hasNextReadPositionAt(n.id),
      canMarkSelection: this.hasContentSelection(),
      t: (key, params) => this.i18n.t(key, params),
      actions: {
        copy: () => void this.copyContent(),
        edit: () => void this.startEdit(),
        rewrite: () => void this.openReadRewriteDialog(),
        togglePriorVersions: () => this.showPriorVersions.set(!this.showPriorVersions()),
        compareVersions: () => void this.openVersionDiffDialog(),
        compareSiblings: () => void this.openCompareSiblingsDialog(),
        toggleExclude: () => void this.toggleExcludeFromContext(),
        heading: () => void this.generateHeading(),
        regenerate: () => void this.regenerateAnswer(),
        regenerateInPlace: () => void this.regenerateInPlace(),
        illustrate: () => void this.illustrate(),
        createImage: () => void this.openReadCreateImageDialog(),
        continueDraft: () => void this.continueDraft(),
        switchCharacters: () => void this.switchCharactersDraft(),
        chapterDescriptions: () => void this.openChapterDescriptionsDialog(),
        prepend: () => void this.openPrependDialog(),
        setReadPosition: () => this.setNextReadPosition(),
        clearReadPosition: () => this.clearNextReadPosition(),
        markPosition: () => void this.markPosition(),
        markSelection: () => void this.markSelection(),
        remove: () => void this.deleteNodeOnly(),
        delete: () => void this.deleteNode(),
        continueChapter: () => void this.continueFromChapter(),
        switchCharactersChapter: () => void this.switchCharactersFromChapter(),
        elaborate: () => void this.elaborateThisChapter(),
      },
    });
  }

  /** Close the menu, then run the chosen action (if it is enabled). */
  runCtxAction(item: CtxMenuItem): void {
    if (item.divider || item.disabled) return;
    this.closeCtxMenu();
    item.action();
  }

  /**
   * Toggle whether this node is included in the LLM context. Excluded nodes
   * are shown + stored but skipped while they are in HISTORY (the current
   * question is always sent), so a node excluded here was still sent when it
   * was the active question.
   */
  async toggleExcludeFromContext(): Promise<void> {
    const n = this.node();
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    await this.chatService.patchNode(chatId, n.id, {
      excludeFromContext: !n.excludeFromContext,
      excludeAfterSend: false
    });
  }

  @HostListener('document:keydown.escape')
  onCtxEscape(): void {
    this.closeCtxMenu();
  }

  /**
   * Ctrl+S while an inline editor is open saves the node (as a new version)
   * and closes the editor — repurposed from the browser's "Save page" default.
   * Bound on the document so it also works while focus is in the toolbar /
   * model select, but only acts while THIS node owns the open editor.
   */
  @HostListener('document:keydown.control.s', ['$event'])
  onEditorSaveShortcut(event: Event): void {
    if (!this.isEditing() || this.isLoading()) return;
    event.preventDefault();
    void this.saveAsVersion();
  }

  @HostListener('window:resize')
  onCtxResize(): void {
    this.closeCtxMenu();
  }

  // The page scrolled under the open menu (wheel, keyboard, live scroll) — close it.
  @HostListener('document:scroll')
  onCtxScroll(): void {
    this.closeCtxMenu();
  }  readonly renderedHtml = signal('');

  /** True while THIS chapter is the one being revealed by paced reading. */
  readonly pacedReading = computed(() => this.pacedRead.isCurrent(this.node().id));

  /**
   * True while this chapter's paced reveal is INTERRUPTED part-way through:
   * the section is currently cut off mid-text, so it must not look as if it
   * ends at the reveal position.
   */
  readonly pacedTruncated = computed(() => {
    if (!this.pacedReading() || !this.pacedRead.paused()) return false;
    const full = this.node().content ?? '';
    const revealed = this.pacedRead.revealedText();
    // Strip trailing whitespace on both sides — a pause right after the last
    // word must not show a dangling ellipsis behind the (complete) text.
    return revealed.trimEnd().length < full.trimEnd().length;
  });

  /**
   * The HTML painted into the content area: the rendered markdown, plus a
   * “…” marker at the reveal position while the pacing is paused (the node
   * continues past that point).
   */
  readonly contentHtml = computed(() => {
    const html = this.renderedHtml();
    return this.pacedTruncated() ? ChatNodeComponent.withRevealCursor(html) : html;
  });

  /**
   * Insert the paused-reveal ellipsis INSIDE the last rendered block, so it
   * sits right after the last revealed character instead of on a new line
   * below the paragraph (markdown rendering always closes its tags).
   */
  private static withRevealCursor(html: string): string {
    const cursor = '<span class="paced-ellipsis" aria-hidden="true">…</span>';
    // Last block-level closing tag at the very end of the rendered output.
    const m = /<\/(p|h[1-6]|li|blockquote|dd|dt|td|th)>[\s]*$/.exec(html);
    if (m) return html.slice(0, m.index) + cursor + html.slice(m.index);
    return html + cursor;
  }

  /** True when the right-click menu set this chapter as the NEXT read start. */
  readonly readPositionPending = computed(
    () => this.pacedRead.hasNextReadPositionAt(this.node().id)
  );

  /** Persistent marks (positions + selections with notices) of this node. */
  readonly nodeMarks = computed(() => this.readingMarks.marksFor(this.node().id));

  isPositionMark(mark: { start: number; end: number }): boolean {
    return mark.end <= mark.start;
  }

  markLabel(mark: import('../../models/chat').ReadingMark): string {
    return this.readingMarks.label(mark, this.chatService.currentNodes());
  }

  /**
   * Open the NOTICE MODAL for an existing mark and persist the result.
   * Cancelling leaves the mark untouched.
   */
  async editMarkNote(mark: import('../../models/chat').ReadingMark): Promise<void> {
    const note = await this.markNoteDialog.open({
      note: mark.note ?? '',
      quote: mark.quote ?? '',
      isPosition: this.isPositionMark(mark)
    });
    if (note == null) return;
    await this.readingMarks.setNote(mark.id, note);
  }

  async deleteMark(mark: import('../../models/chat').ReadingMark): Promise<void> {
    await this.readingMarks.remove(mark.id);
  }

  /**
   * Jump to the EXACT spot of a mark inside this section and re-select its
   * text (so it looks selected again and can be copied). Returns false when
   * the text is no longer there (the section was edited / the mark is stale),
   * so the caller can fall back to scrolling the section into view.
   */
  revealMark(mark: import('../../models/chat').ReadingMark): boolean {
    const contentEl = this.readContent()?.nativeElement;
    if (!contentEl) return false;
    // A selection mark stores the RENDERED text — search for exactly that. A
    // bare position has no quote, so use a short excerpt of what follows it.
    const needle = mark.quote?.trim() || this.markExcerpt(mark);
    const range = needle ? findTextRange(contentEl, needle) : null;
    if (!range) return false;
    selectRangeAndScroll(range, el => (el ? this.scrollParentOf(el) : null));
    return true;
  }

  /**
   * Text following a position mark, usable as a DOM search needle: taken from
   * the node source, stripped of markdown markers and normalized.
   */
  private markExcerpt(mark: import('../../models/chat').ReadingMark): string {
    const source = this.node().content ?? '';
    if (!source.trim()) return '';
    const from = Math.min(Math.max(0, mark.start), Math.max(0, source.length - 1));
    const raw = source.slice(from, from + 80)
      .replace(/^[\s*>#`\-_+\d.)\]]+/, '')
      .replace(/[*_`~#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A few whole words are enough to be unambiguous and survive wrapping.
    return raw.split(' ').slice(0, 6).join(' ').trim();
  }

  /** Start a paced read exactly at this mark's spot. */
  readFromMark(mark: import('../../models/chat').ReadingMark): void {
    this.pacedRead.setNextReadPosition(mark.nodeId, mark.start);
    this.startPacedRead();
  }

  /**
   * Estimated paced-read duration of this chapter at the current reveal speed
   * (the same pace a paced read uses when the slider sits at 0 = instant).
   */
  readonly readTimeLabel = computed(() => {
    const n = this.node();
    if (n.role !== 'assistant') return null;
    const text = n.content ?? '';
    if (!text.trim()) return null;
    return readingTimeLabel(text, this.chatService.streamSpeed(), this.chatService.streamSpeedUnit());
  });

  constructor() {
    // The extracted controllers act on the draft / the send + illustration
    // pipelines; the card owns the DOM (textarea refs, scroll restoration)
    // and the tree, so it hands those in as host callbacks.
    this.editor.bind({
      node: () => this.node(),
      editSession: this.editSession,
      enabledModels: () => this.enabledModels(),
      resolvePreferredModelId: node => this.resolvePreferredModelId(node),
      clearAttachmentSelection: () => this.clearAttachmentSelection(),
      onEditorTargetCleared: () => { this.pendingScrollOffset = null; },
      onDraftReplaced: () => requestAnimationFrame(() => this.resizeTextarea()),
      isUnsentQuestion: () => this.isUnsentQuestion(),
      sendDraft: () => this.sendDraft(),
      runDirectionBatch: (direction, count) => this.runDirectionBatch(direction, count),
      onActivated: id => this.activate.emit(id)
    });
    this.sender.bind({
      node: () => this.node(),
      actions: this.actions,
      editor: this.editor,
      enabledModels: () => this.enabledModels(),
      providers: () => this.settings.providers(),
      resolvePreferredModelId: node => this.resolvePreferredModelId(node),
      isUnsentQuestion: () => this.isUnsentQuestion(),
      closeEditor: () => this.closeEditor(),
      paintAnswer: (id, content, thinking) => this.paintAnswer(id, content, thinking),
      onActivated: id => this.activate.emit(id),
      runFlow: (usecase, pending, builder) => this.runFlow(usecase, pending, builder)
    });
    this.dialogActions.bind({
      node: () => this.node(),
      actions: this.actions,
      editor: this.editor,
      editSession: this.editSession,
      enabledModels: () => this.enabledModels(),
      providers: () => this.settings.providers(),
      resolvePreferredModelId: node => this.resolvePreferredModelId(node),
      isEditing: () => this.isEditing(),
      resizeTextarea: () => this.scheduleResize(),
      onActivated: id => this.activate.emit(id),
      runFlow: (usecase, pending, builder) => this.runFlow(usecase, pending, builder),
      prependEnabled: this.prependEnabled,
      prependText: this.prependText,
      comparableSiblings: () => this.comparableSiblings(),
      replaceDraft: text => {
        this.contentDraft.set(text);
        this.editSession.patch(this.node().id, text, this.editAttachments());
        this.scheduleResize();
      }
    });
    this.textActions.bind({
      node: () => this.node(),
      isEditing: () => this.isEditing(),
      actions: this.actions,
      editor: this.editor,
      illustration: this.illustration,
      editSession: this.editSession,
      enabledModels: () => this.enabledModels(),
      providers: () => this.settings.providers(),
      resolvePreferredModelId: node => this.resolvePreferredModelId(node),
      onActivated: id => this.activate.emit(id),
      editorSelection: () => this.captureEditorSelection(),
      readSelection: () => this.captureReadSelection(),
      resizeEditor: () => this.scheduleResize(),
      focusEditorAt: (start, length) => this.focusEditorRange(start, length),
      writeDraft: text => {
        this.contentDraft.set(text);
        this.editSession.patch(this.node().id, text, this.editAttachments());
      }
    });
    effect(() => {
      const n = this.node();
      // Paced reading overrides the rendered text with the revealed slice —
      // reading a chapter again at an arbitrary time, word by word.
      const override = this.pacedRead.displayText(n.id, n.content ?? '');
      this.updateRendered(override ?? n.content);
    });
    effect(() => {
      // The selection is bound to a specific node: when the displayed node
      // changes (navigation, versioning) stale ids must not linger.
      this.nodeIdForSelection();
      this.clearAttachmentSelection();
    });
    effect(() => {
      const id = this.node().id;
      // Prepend state is owned by the dialog-actions controller; this effect
      // only mirrors it into the card's signals for the template.
      this.dialogActions.syncPrependState(id);
      // A new node (fresh generation / versioned answer) means auto-follow
      // starts again — any previous user-scroll pause is cleared.
      this.followPausedByUser = false;
      this.removeFollowScrollListener();
    });

    afterRenderEffect(() => {
      const n = this.node();
      this.renderedHtml();
      // Paced reading of existing text: keep the freshly revealed end in view
      // (unless the user scrolled away by hand — a manual skip re-arms it).
      const paced = this.pacedRead.isCurrent(n.id);
      const followTick = this.pacedRead.followTick();
      if (paced) {
        if (followTick !== this.lastPacedFollowTick) {
          this.lastPacedFollowTick = followTick;
          this.followPausedByUser = false;
        }
        this.followLive();
        return;
      }
      // Follow/thinking key off the node being PRESENTED (revealed), not the
      // newest generation — a background buffer filling in the queue must not
      // steal the reveal UI from the node actually painting right now.
      const presented = this.chatService.presentedNodeId();
      const live = presented === n.id
        || (presented === null
            && (this.chatService.isGenerating(n.id)
              || this.chatService.generatingNodeId() === n.id));
      if (!live) return;
      // Annotation in progress (the node's context menu is open, or a notice
      // is being typed): do NOT yank the view to the stream's end. The section
      // the user is marking has to stay where it is until they are done —
      // marking a finished chapter while another one streams is a supported
      // combination. Follow resumes with the next chunk.
      if (ChatNodeComponent.openMenu || this.markNoteDialog.current()) return;
      // Auto-follow (content + thinking) is ONLY active when the "follow
      // streaming" checkbox is checked. When it is off, the user scrolls
      // freely — the thinking body can grow large, so we must never fight
      // the scroll. Follow-thinking additionally requires the thought to be
      // open (thinking is hidden by default; the user opens/closes it).
      if (!this.chatService.followStreaming()) return;
      const hasThinking = !!n.thinking?.trim();
      if (hasThinking && !this.thinkingClosed()) {
        this.followThinking();
      } else {
        this.followLive();
      }
    });

    // Measure the open context menu so it can be clamped into the viewport.
    afterRenderEffect(() => {
      const menu = this.ctxMenu();
      const el = this.ctxMenuEl()?.nativeElement;
      if (menu && el) {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const size = this.ctxSize();
        if (!size || size.w !== w || size.h !== h) {
          this.ctxSize.set({ w, h });
        }
      }
    });
  }

  ngOnDestroy(): void {
    // Release the shared open-menu handle when this node unmounts.
    if (ChatNodeComponent.openMenu === this) {
      ChatNodeComponent.openMenu = null;
    }
    this.removeFollowScrollListener();
  }

  /** Last `followTick` seen — a change means the user pressed an arrow key. */
  private lastPacedFollowTick = 0;

  /**
   * "Read" — reveal this chapter and the following chapters of the active
   * path at the configured reveal pace, without calling the LLM. Pressing it
   * again stops the run.
   */
  startPacedRead(event?: Event): void {
    event?.stopPropagation();
    if (this.pacedReading()) {
      this.pacedRead.stop();
      return;
    }
    const self = this.node();
    // A "next read position" set from the context menu wins over the chapter
    // this button belongs to.
    const anchorId = this.pacedRead.pendingStart()?.nodeId ?? self.id;
    const anchor = this.chatService.getActivePath().find(n => n.id === anchorId) ?? self;
    const items = this.pacedReadItemsFrom(anchor);
    if (!items.length) return;
    this.followPausedByUser = false;
    void this.pacedRead.start(items);
  }

  private followLive(): void {
    if (this.followPausedByUser) return;
    const anchor = this.streamEnd()?.nativeElement;
    if (!anchor) return;
    this.applyFollowScroll(anchor);
  }

  /** Keep the OPEN thinking body in view while the model is thinking. */
  private followThinking(): void {
    if (this.followPausedByUser) return;
    const anchor = this.thinkingBody()?.nativeElement ?? this.streamEnd()?.nativeElement;
    if (!anchor) return;
    this.applyFollowScroll(anchor);
  }

  /** Perform ONE follow scroll and (first time only) arm the user-scroll detector. */
  private applyFollowScroll(anchor: HTMLElement): void {
    this.ensureFollowScrollListener(anchor);
    followLiveScroll(anchor, this.scrollParentOf.bind(this));
  }

  /**
   * User-scroll-stops-follow: once the user scrolls the streaming scroller by
   * hand (mouse wheel / trackpad / touch), auto-follow (content + thinking)
   * pauses so they can reach the thinking toggle / older content without the
   * view re-snapping on every chunk. Gesture events (wheel/touchmove) are used
   * because programmatic `scrollTop` assignment never fires them — so there is
   * no ambiguity with our own follow scrolling. Resets when a new node is
   * shown (a fresh generation mounts a new node).
   */
  private followPausedByUser = false;
  private followScrollCleanup: (() => void) | null = null;

  /** Attach ONE gesture listener to the streaming scroller (or document). */
  private ensureFollowScrollListener(anchor: HTMLElement): void {
    if (this.followScrollCleanup) return;
    const scroller = this.scrollParentOf(anchor);
    const onScroll = () => { this.followPausedByUser = true; };
    if (!scroller || scroller === document.scrollingElement) {
      document.addEventListener('wheel', onScroll, { passive: true, capture: true });
      document.addEventListener('touchmove', onScroll, { passive: true, capture: true });
      this.followScrollCleanup = () => {
        document.removeEventListener('wheel', onScroll, { capture: true } as any);
        document.removeEventListener('touchmove', onScroll, { capture: true } as any);
      };
      return;
    }
    scroller.addEventListener('wheel', onScroll, { passive: true });
    scroller.addEventListener('touchmove', onScroll, { passive: true });
    this.followScrollCleanup = () => {
      scroller.removeEventListener('wheel', onScroll);
      scroller.removeEventListener('touchmove', onScroll);
    };
  }

  private removeFollowScrollListener(): void {
    this.followScrollCleanup?.();
    this.followScrollCleanup = null;
  }

  updateRendered(content: string): void {
    this.renderedHtml.set(this.markdownService.toHtml(content ?? ''));
  }

  readonly copied = signal(false);
  private copyTimeout: any = null;

  async copyContent(): Promise<void> {
    const content = this.node().content ?? '';

    try {
      await navigator.clipboard.writeText(content);
      this.copied.set(true);
      clearTimeout(this.copyTimeout);
      this.copyTimeout = setTimeout(() => this.copied.set(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        this.copied.set(true);
        clearTimeout(this.copyTimeout);
        this.copyTimeout = setTimeout(() => this.copied.set(false), 1500);
      } catch {
        alert(this.i18n.t('node.copyFailed'));
      }
      document.body.removeChild(textarea);
    }
  }

  stopGeneration(): void {
    // Chat-scoped: Stop ends every piece of processing of THIS chat (the live
    // stream, other active streams and the running batch/operation).
    this.chatService.stopGeneration(this.chatService.currentChatId() ?? undefined);
  }

  /** Finish the current answer stream, then stop (results are preserved). */
  gracefulStop(): void {
    this.chatService.requestGracefulStop();
  }

  /** Convert files into attachments via the shared `attachments` module helper,
   *  surfacing per-file size alerts through i18n. */
  private async filesToAttachments(files: FileList | File[]): Promise<NodeAttachment[]> {
    return convertFilesToAttachments(files, {
      onTooLarge: (name) => alert(this.i18n.t('node.fileTooLarge', { name })),
    });
  }

  async onEditorFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const added = await this.filesToAttachments(input.files);
    this.editAttachments.update(list => [...list, ...added]);
    this.syncAttachments();
    input.value = '';
  }

  onEditorDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isEditorDragOver.set(true);
  }

  onEditorDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isEditorDragOver.set(false);
  }

  async onEditorDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isEditorDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) {
      const added = await this.filesToAttachments(files);
      this.editAttachments.update(list => [...list, ...added]);
      this.syncAttachments();
    }
  }

  // ------------------------------------------------------------------
  // Attachment multi-selection + copy / cut / paste
  // ------------------------------------------------------------------

  isAttachmentSelected(id: string): boolean {
    return this.selectedAttachmentIds().has(id);
  }

  /** True when this attachment is staged for a cut (marked, still in place). */
  isAttachmentCut(a: NodeAttachment): boolean {
    return this.attachmentClipboard.isCutAttachment(a.id);
  }

  /** Toggle an attachment in the multi-selection. */
  toggleAttachmentSelection(a: NodeAttachment): void {
    this.selectedAttachmentIds.update(set => {
      const next = new Set(set);
      if (next.has(a.id)) {
        next.delete(a.id);
      } else {
        next.add(a.id);
      }
      return next;
    });
  }

  clearAttachmentSelection(): void {
    this.selectedAttachmentIds.set(new Set());
  }

  /** The attachments currently selected (draft list while editing, node list otherwise). */
  private selectedAttachments(): NodeAttachment[] {
    const list = this.isEditing()
      ? this.editAttachments()
      : (this.node().attachments ?? []);
    const ids = this.selectedAttachmentIds();
    return list.filter(a => ids.has(a.id));
  }

  /**
   * Click on a chip: Ctrl/Cmd+click always toggles multi-selection; a plain
   * click on the chip body toggles it too. Interactive children (image thumb,
   * prompt toggle, file link) stop propagation so their own action still runs
   * (see onAttachment*Click below).
   */
  onAttachmentChipClick(a: NodeAttachment, event: MouseEvent): void {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
    this.toggleAttachmentSelection(a);
    event.stopPropagation();
  }

  onAttachmentImageClick(a: NodeAttachment, event: MouseEvent): void {
    if (event.ctrlKey || event.metaKey) {
      this.toggleAttachmentSelection(a);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.openImage(a.dataUrl);
    event.stopPropagation();
  }

  /** Download an image attachment (data URL) as a file. */
  downloadAttachment(a: NodeAttachment, event: MouseEvent): void {
    event.stopPropagation();
    downloadUrl(a.dataUrl, a.name || filenameFromUrl(a.dataUrl, 'image.png'));
  }

  onAttachmentPromptClick(a: NodeAttachment, event: MouseEvent): void {
    if (event.ctrlKey || event.metaKey) {
      this.toggleAttachmentSelection(a);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.togglePrompt(a);
    event.stopPropagation();
  }

  onAttachmentLinkClick(a: NodeAttachment, event: MouseEvent): void {
    if (event.ctrlKey || event.metaKey) {
      this.toggleAttachmentSelection(a);
      event.preventDefault();
    }
    event.stopPropagation();
  }

  /** Copy the selected attachments into the attachment clipboard. */
  copySelectedAttachments(): void {
    const list = this.selectedAttachments();
    if (!list.length) return;
    try {
      this.attachmentClipboard.copy(this.node().id, this.node().chatId, list);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.attCopyFailed', { error: err?.message || err }));
    }
  }

  /**
   * Cut (stage a move). Nothing is removed from the persisted node here — the
   * attachments stay in place and are only removed when pasted into another
   * node ("cut is only done in reality when paste is done"). While EDITING the
   * staged items are dropped from the UNSAVED draft immediately: the draft is
   * local state, so cancelling the editor restores them — no data loss.
   */
  cutSelectedAttachments(): void {
    const list = this.selectedAttachments();
    if (!list.length) return;
    try {
      this.attachmentClipboard.cut(this.node().id, this.node().chatId, list);
      if (this.isEditing()) {
        const ids = new Set(list.map(a => a.id));
        this.editAttachments.update(cur => cur.filter(a => !ids.has(a.id)));
        this.syncAttachments();
      }
      this.clearAttachmentSelection();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.attCutFailed', { error: err?.message || err }));
    }
  }

  /**
   * Paste the attachment clipboard into THIS node.
   *
   * - copy → clones are appended (a new version is created / the draft grows).
   * - cut  → the staged attachments are MOVED here: removed from their source
   *   node (new version) and appended to this one. Cut + paste into the same
   *   node is a no-op (nothing moves), the staging is just dropped.
   *
   * While editing, pasted attachments land in the unsaved draft instead of a
   * new version; a cut source whose editor is open is skipped (the staged
   * items were already dropped from that draft).
   */
  async pasteAttachments(): Promise<void> {
    const entry = this.attachmentClipboard.clipboard();
    if (!entry || !entry.attachments.length) return;
    const isCut = entry.action === 'cut';
    try {
      // Cut + paste into the SAME node: nothing moves, just drop the staging.
      if (isCut && entry.sourceNodeId === this.node().id) {
        this.attachmentClipboard.clear();
        this.clearAttachmentSelection();
        return;
      }

      // Execute a staged cut: remove the attachments from their SOURCE node
      // (a new version is created). Skipped when the source is the node whose
      // draft is currently open — the staged items were already removed from
      // that draft when Cut was pressed (the removal lands when the draft saves).
      if (isCut && entry.sourceNodeId && entry.sourceNodeId !== this.node().id) {
        const sourceIsBeingEdited =
          this.editSession.editingNodeId() === entry.sourceNodeId;
        if (!sourceIsBeingEdited) {
          const source = this.chatService.nodes().find(
            n => n.id === entry.sourceNodeId
          );
          if (source) {
            const cutIds = new Set(entry.attachments.map(a => a.id));
            const remaining = (source.attachments ?? []).filter(
              a => !cutIds.has(a.id)
            );
            await this.persistAttachments(source, remaining);
          }
        }
      }

      const incoming = isCut
        ? entry.attachments
        : entry.attachments.map(a => ({ ...a, id: newId() }));

      if (this.isEditing()) {
        this.editAttachments.update(list => [...list, ...incoming]);
        this.syncAttachments();
      } else {
        const target = this.node();
        const merged = [...(target.attachments ?? []), ...incoming];
        const saved = await this.persistAttachments(target, merged);
        this.activate.emit(saved.id);
      }
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.attPasteFailed', { error: err?.message || err }));
    } finally {
      this.attachmentClipboard.clear();
      this.clearAttachmentSelection();
    }
  }

  /** Cancel a staged cut/copy: nothing is removed, the staging is dropped. */
  cancelAttachmentClipboard(): void {
    this.attachmentClipboard.clear();
    this.clearAttachmentSelection();
  }

  /**
   * Delete the selected attachments from this node.
   *
   * Read-only: asks for confirmation and persists a NEW version without them.
   * Editing: only the unsaved draft is touched (Cancel restores the persisted
   * node), so no confirmation is needed.
   */
  async deleteSelectedAttachments(): Promise<void> {
    const ids = this.selectedAttachmentIds();
    if (!ids.size) return;

    if (this.isEditing()) {
      this.editAttachments.update(list => list.filter(a => !ids.has(a.id)));
      this.syncAttachments();
      this.clearAttachmentSelection();
      return;
    }

    const n = this.node();
    const remaining = (n.attachments ?? []).filter(a => !ids.has(a.id));
    const ok = await this.confirm.ask({
      title: this.i18n.t('node.attDeleteAsk', { n: ids.size }),
      message: this.i18n.t('node.attDeleteMsg', { n: ids.size }),
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;

    this.isLoading.set(true);
    this.pendingAction.set('version');
    try {
      const saved = await this.persistAttachments(n, remaining);
      this.activate.emit(saved.id);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.attDeleteFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
      this.clearAttachmentSelection();
    }
  }

  /**
   * Persist the given attachments as a NEW version of `node` (role-aware,
   * keeps content + thinking) — used to add/remove/move attachments outside
   * the editor. Returns the newly created version.
   */
  private async persistAttachments(
    node: ChatNode,
    attachments: NodeAttachment[]
  ): Promise<ChatNode> {
    const chatId = node.chatId;
    if (node.role === 'assistant' || node.role === 'system' || node.role === 'structural') {
      return this.chatService.editAssistant(
        chatId,
        node.id,
        node.content ?? '',
        attachments,
        node.thinking ?? undefined
      );
    }
    return this.chatService.editUser(
      chatId,
      node.id,
      node.content ?? '',
      attachments
    );
  }

  removeEditAttachment(id: string) {
    this.editAttachments.update(list => list.filter(a => a.id !== id));
    this.syncAttachments();
  }

  openImage(dataUrl: string) {
    // Open in the in-app lightbox instead of `window.open(dataUrl,'_blank')`:
    // Chromium (Chrome + Electron) blocks top-level navigation to data: URLs,
    // which is why a plain window.open only worked in Firefox.
    const urls = (this.node().attachments || [])
      .filter(a => isImageMime(resolvedMime(a)) && /^(data:|https?:\/\/)/i.test(a.dataUrl || ''))
      .map(a => a.dataUrl);
    const start = urls.indexOf(dataUrl);
    this.lightbox.open(urls, start >= 0 ? start : 0);
  }

  hasUnsavedChanges(): boolean {
    const n = this.node();
    const attachmentsUnchanged =
      JSON.stringify(this.editAttachments()) === JSON.stringify(n.attachments || []);
    return this.contentDraft() !== (n.content || '') || !attachmentsUnchanged;
  }


  parametersFootnote(): string | null {
    if (this.node().role !== 'assistant') return null;
    const id = this.node().chatParametersId;
    const own = this.parameters.peek(id);
    if (own) return formatParametersSummary(own);
    const model = this.enabledModels().find(m => m.modelId === this.node().modelId || m.id === this.node().modelId);
    if (model?.chatParametersId) {
      const fromModel = this.parameters.peek(model.chatParametersId);
      if (fromModel) return formatParametersSummary(fromModel);
    }
    return null;
  }  // ------------------------------------------------------------------
  // Extracted action controllers — thin DELEGATES. Kept as component members
  // so the template and the existing specs keep addressing the card; the
  // logic lives in EditorController / SendController / IllustrationController
  // (see docs/architecture/chat-ui.md).
  // ------------------------------------------------------------------

  /** What the illustration controller needs from this card. */
  private illustrationContext(): IllustrationCallContext {
    return { pressed: this.node(), onActivated: id => this.activate.emit(id) };
  }

  /** Generate pictures for this beat (dialog → use case → placement plan). */
  async illustrate(promptOverride?: string | null): Promise<void> {
    return this.illustration.illustrate({
      ...this.illustrationContext(),
      promptOverride,
      markedSceneText: this.captureMarkedSceneText()
    });
  }

  /** Re-render ONE picture with the adapted prompt. */
  async rerenderPrompt(a: NodeAttachment): Promise<void> {
    return this.illustration.rerenderPrompt(
      this.node(), a, this.promptEditDraft(), this.illustrationContext()
    );
  }

  /** Delete a recorded prompt attachment (keeps the paired picture). */
  async deletePromptAttachment(a: NodeAttachment): Promise<void> {
    return this.illustration.deletePromptAttachment(
      this.node(), a, this.illustrationContext()
    );
  }

  /** Cancel the editor (asks before discarding a dirty draft). */
  async cancelEdit(): Promise<void> {
    await this.editor.cancelEdit();
  }

  /** Commit the draft + close the editor without asking. */
  private closeEditor(): void {
    this.editor.closeEditor();
  }

  /** OK — persist the draft as a new version of this node (no LLM call). */
  async saveAsVersion(): Promise<void> {
    await this.editor.saveAsVersion();
  }

  /** Composer shortcut: fill the "Continue" template and send. */
  async continueDraft(): Promise<void> {
    await this.editor.continueDraft();
  }

  /** Composer shortcut: fill the "switch characters" template and send. */
  async switchCharactersDraft(): Promise<void> {
    await this.editor.switchCharactersDraft();
  }

  /** Chapter-scoped: continue the STORY from this chapter (fills a fresh
   *  direction leaf right under it and streams the answer). */
  async continueFromChapter(): Promise<void> {
    await this.sender.continueFromChapter('continue');
  }

  /** Chapter-scoped: multiple-characters version of the Continue shortcut. */
  async switchCharactersFromChapter(): Promise<void> {
    await this.sender.continueFromChapter('switchCharacters');
  }

  /** Chapter-scoped: open the elaborate dialog anchored at THIS chapter. */
  async elaborateThisChapter(): Promise<void> {
    const n = this.node();
    if (n.role !== 'assistant' || !n.content?.trim()) return;
    this.chatElaborate.openElaborateDialog(n);
  }

  decRepeat(): void {
    this.editor.decRepeat();
  }

  incRepeat(): void {
    this.editor.incRepeat();
  }

  /** A keystroke in the textarea (draft + edit session). */
  onDraftText(text: string): void {
    this.editor.onDraftText(text);
  }

  /** Apply a search/replace result to the LIVE draft of an open editor. */
  setDraftFromSearch(text: string): void {
    this.editor.setDraftFromSearch(text);
  }

  /** Push the current draft into the edit session (attachments changed). */
  private syncAttachments(): void {
    this.editor.syncAttachments();
  }

  isDraftEmpty(): boolean {
    return this.editor.isDraftEmpty();
  }

  /** Send the composer draft and stream the answer. */
  async sendDraft(): Promise<void> {
    await this.sender.sendDraft();
  }

  /** Branch — new sibling question + streamed answer. */
  async saveAsBranchAndSend(): Promise<void> {
    await this.sender.saveAsBranchAndSend();
  }

  /** Insert — new sibling question, adopting the previous siblings. */
  async saveAsInsertAndSend(): Promise<void> {
    await this.sender.saveAsInsertAndSend();
  }

  /** Chain N Continue / Switch-characters sends (one Stop aborts the batch). */
  private async runDirectionBatch(
    direction: 'continue' | 'switchCharacters',
    count: number
  ): Promise<void> {
    await this.sender.runDirectionBatch(direction, count);
  }

  // ------------------------------------------------------------------
  // Dialog actions — DELEGATES to `DialogActionsController`
  // ------------------------------------------------------------------

  /** Open the "Prepend director" dialog and run the prepend flow. */
  async openPrependDialog(): Promise<void> {
    await this.dialogActions.openPrependDialog();
  }

  /** Compare the draft/current text against a prior version. */
  async openVersionDiffDialog(): Promise<void> {
    await this.dialogActions.openVersionDiffDialog();
  }

  /** Compare this node against one of its current siblings. */
  async openCompareSiblingsDialog(): Promise<void> {
    await this.dialogActions.openCompareSiblingsDialog();
  }

  /** Open the "Create chapter descriptions" dialog and run its flow. */
  async openChapterDescriptionsDialog(): Promise<void> {
    await this.dialogActions.openChapterDescriptionsDialog();
  }
}

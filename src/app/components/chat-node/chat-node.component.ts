import {
  Component, HostListener, OnDestroy, inject, input, output, signal, effect, afterRenderEffect,
  viewChild, ElementRef, Provider, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat/chat.service';
import { SettingsService } from '../../core/settings/settings.service';
import { ChatNode, NodeAttachment, ChatMessage, Chat } from '../../models/chat';
import { MarkdownService } from '../../core/chat/markdown.service';
import { markFragmentInSource } from '../../core/util/mark-fragment';
import { NodeEditSession} from '../../core/chat/node-edit-session';
import {ConfirmService} from '../../core/dialogs/confirm.service';
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
import { newId } from '../../core/util/helpers';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { PromptDefaultsService } from '../../core/prompts/prompt-defaults.service';
import { ModelEntry, ProviderConfig, canGenerateImages } from '../../models/chat-config';
import { IllustrateDialogService } from '../../core/dialogs/illustrate-dialog.service';
import { PrependDialogService } from '../../core/dialogs/prepend-dialog.service';
import { RewriteDialogService } from '../../core/dialogs/rewrite-dialog.service';
import { CreateImageDialogService } from '../../core/dialogs/create-image-dialog.service';
import { ChapterDescriptionsDialogService } from '../../core/dialogs/chapter-descriptions-dialog.service';
import { IllustrateOptions } from '../../models/illustrate-options';
import { LightboxService } from '../../core/dialogs/lightbox.service';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { LlmFlowRunner } from '../../core/llm/orchestration';
import { LlmPostprocessorService, pickUsecase, buildIllustrationAttachments, generatedImageAttachments, imageOnlyAnswerContent } from '../../core/llm/orchestration';
import { type ImageScene } from '../../core/llm/orchestration';
import { parseSuggestionVariants } from '../../core/llm/orchestration/evaluators';
import { type LlmImagePart } from '../../core/llm/llm-message';
import { StreamReveal } from '../../core/llm/stream-reveal';
import { LlmLogService } from '../../core/llm/llm-log.service';
import { ChatUsageService } from '../../core/chat/chat-usage.service';
import { AttachmentClipboardService } from '../../core/clipboard/attachment-clipboard.service';
import { nearestScrollParent } from '../../core/util/dom-metrics';
import { buildCtxMenuItems, type CtxMenuItem } from './context-menu';
import { filesToAttachments as convertFilesToAttachments } from './attachments';
import {
  captureRoSourceOffset,
  ensureEditorTopOnScreen,
  followLiveScroll,
  scrollTextareaToOffset,
  scrollTopForOffset as draftScrollTopForOffset,
  sourceOffsetAtPoint
} from './editor-scroll';

/**
 * Fallback when a rewrite's original range cannot be mapped back to the
 * source: keep the rewrite instead of losing it by appending it at the end of
 * the content as a new paragraph.
 */
function appendRewriteFallback(source: string, rewrite: string): string {
  const tail = source.trimEnd();
  return tail.length ? tail + '\n\n' + rewrite : rewrite;
}

@Component({
  selector: 'app-chat-node',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-node.component.html',
  styleUrl: './chat-node.component.css'
})
export class ChatNodeComponent implements OnDestroy {
  private readonly settings = inject(SettingsService);
  public readonly markdownService = inject(MarkdownService);
  readonly chatService = inject(ChatService);
  readonly projectService = inject(ProjectService);
  private readonly runner = inject(LlmUseCaseRunner);
  private readonly flowRunner = inject(LlmFlowRunner);
  private readonly postprocessor = inject(LlmPostprocessorService);
  private readonly llmLog = inject(LlmLogService);
  private readonly usage = inject(ChatUsageService);
  private readonly parameters = inject(ChatParametersService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly illustrateDialog = inject(IllustrateDialogService);
  private readonly lightbox = inject(LightboxService);
  private readonly rewriteDialog = inject(RewriteDialogService);
  private readonly createImageDialog = inject(CreateImageDialogService);
  private readonly chapterDescriptionsDialog = inject(ChapterDescriptionsDialogService);

  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  readonly node = input.required<ChatNode>();
  readonly activeChildId = input<string | null>(null);
  readonly activate = output<string>();

  readonly editAttachments = signal<NodeAttachment[]>([]);
  readonly isEditorDragOver = signal(false);

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

  readonly contentDraft = signal('');
  readonly branchModelId = signal('');
  readonly isLoading = signal(false);
  /** How many Continue / Switch characters sends to chain in one batch. */
  readonly repeatCount = signal(1);
  private static readonly REPEAT_MAX = 20;
  readonly pendingAction = signal<'version' | 'branch' | 'insert' | 'send' | 'continue' | 'switchCharacters' | 'structure' | 'prepend' | 'image' | 'chapterDescriptions' | null>(null);
  /** Check-my-English (direction) feature state. */
  readonly checkingEnglish = signal(false);
  readonly englishSuggestions = signal<string[] | null>(null);
  readonly showPreview = signal(false);
  /** Set by Cancel so auto-open does not immediately re-enter edit. */
  readonly editDismissed = signal(false);
  readonly enabledModels = this.settings.enabledModels;
  private readonly editSession = inject(NodeEditSession);
  readonly showPriorVersions = signal(false);
  readonly thinkingClosed = signal(true);
  private static readonly LS_PREPEND = 'chat.prependByNodeId';
  readonly prependEnabled = signal(false);
  /** The stored director text for the current node (custom prefix). */
  readonly prependText = signal('');
  private readonly prependDialog = inject(PrependDialogService);

  private readonly editArea = viewChild<ElementRef<HTMLTextAreaElement>>('editArea');
  private readonly streamEnd = viewChild<ElementRef<HTMLElement>>('streamEnd');
  private readonly readContent = viewChild<ElementRef<HTMLElement>>('readContent');
  private readonly ctxMenuEl = viewChild<ElementRef<HTMLElement>>('ctxMenu');

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

  isDraftEmpty(): boolean {
    return !this.contentDraft().trim() && this.editAttachments().length === 0;
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
    if (n.role !== 'user') return false;
    return this.chatService.getChildren(n.id).length === 0;
  }

  isQuestion(): boolean {
    return this.node().role === 'user';
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

    this.editDismissed.set(false);
    this.contentDraft.set(n.content || '');
    this.editAttachments.set([...(n.attachments || [])]);
    this.clearAttachmentSelection();
    this.branchModelId.set(n.modelId || this.resolvePreferredModelId(n));
    this.pendingAction.set(null);
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
  }

  async cancelEdit(): Promise<void> {
    if (
      this.editSession.editingNodeId() === this.node().id &&
      this.editSession.isDirty()
    ) {
      const discard = await this.confirm.ask({
        title: this.i18n.t('node.discardTitle'),
        message: this.i18n.t('node.discardMsg'),
        confirmLabel: this.i18n.t('common.discard'),
        cancelLabel: this.i18n.t('common.keepEditing'),
        danger: true
      });
      if (!discard) return;
    }
    this.editDismissed.set(true);
    this.pendingAction.set(null);
    this.showPreview.set(false);
    this.contentDraft.set('');
    this.editAttachments.set([]);
    this.clearAttachmentSelection();
    this.pendingScrollOffset = null;
    this.editSession.abandon(this.node().id);
  }

  private closeEditor(): void {
    const id = this.node().id;
    this.pendingAction.set(null);
    this.showPreview.set(false);
    this.contentDraft.set('');
    this.editAttachments.set([]);
    this.clearAttachmentSelection();
    this.pendingScrollOffset = null;
    this.editSession.commit(id);
  }


  /**
   * OK — persist as a new version of this node. Does not call the LLM.
   * Answers use /edit-assistant. Questions use /edit-question (see patches).
   * For a question the model selected in the editor is ALSO persisted onto the
   * new version, so the model choice sticks to the node (Send / Branch /
   * Insert read it from there the next time).
   */
  async saveAsVersion(): Promise<void> {
    const node = this.node();
    const newContent = this.contentDraft().trim();
    const attachments = this.editAttachments();

    const attachmentsUnchanged =
      JSON.stringify(attachments) === JSON.stringify(node.attachments || []);

    // Nothing was changed (empty draft w/o attachments, or identical text +
    // attachments) → keep the node untouched and just close the editor. Use
    // closeEditor() (NOT cancelEdit()): cancelEdit would ask for a discard
    // confirmation when the edit session is dirty (e.g. the user typed and
    // then reverted), which blocked saving. No new version node is created.
    if ((!newContent && attachments.length === 0) ||
      (newContent === node.content && attachmentsUnchanged)) {
      this.closeEditor();
      return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    this.isLoading.set(true);
    this.pendingAction.set('version');
    try {
      let saved: ChatNode;
      if (node.role === 'assistant' || node.role === 'system' || node.role === 'structural') {
        saved = await this.chatService.editAssistant(
          chatId,
          node.id,
          newContent,
          attachments
        );
      } else {
        saved = await this.chatService.editUser(
          chatId,
          node.id,
          newContent,
          attachments
        );
      }
      // The model selector is only shown while editing a user node. Versioning
      // copies the OLD model, so persist the freshly selected model (when it
      // actually changed) onto the new version.
      if (node.role === 'user' && this.branchModelId()) {
        const selected = this.enabledModels().find(
          m => m.modelId === this.branchModelId() || m.id === this.branchModelId()
        );
        if (selected && selected.modelId !== node.modelId && selected.providerId) {
          saved = await this.chatService.patchNode(chatId, saved.id, {
            modelId: selected.modelId,
            providerId: selected.providerId
          });
        }
      }
      this.activate.emit(saved.id);
      this.closeEditor();
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.saveFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  /**
   * Empty leaf question: fill the draft with the "Continue" template, pin the
   * default LLM, and send. Same path as Send, no extra branch.
   */
  async continueDraft(): Promise<void> {
    if (!this.isUnsentQuestion() || this.isLoading()) return;
    if (this.repeatCount() > 1) {
      await this.runDirectionBatch('continue', this.repeatCount());
      return;
    }
    this.contentDraft.set(
      this.promptDefaults.effective('structure.continue') || 'continue'
    );
    this.editAttachments.set([]);
    this.branchModelId.set(this.node().modelId || this.resolvePreferredModelId(this.node()));
    this.pendingAction.set('continue');
    await this.sendDraft();
    await this.cancelEdit();
  }

  /**
   * Empty leaf question: fill the draft with the "Switch characters"
   * template, pin the default LLM, and send. Same path as Continue.
   */
  async switchCharactersDraft(): Promise<void> {
    if (!this.isUnsentQuestion() || this.isLoading()) return;
    if (this.repeatCount() > 1) {
      await this.runDirectionBatch('switchCharacters', this.repeatCount());
      return;
    }
    this.contentDraft.set(
      this.promptDefaults.effective('structure.switchCharacters') || 'switch characters'
    );
    this.editAttachments.set([]);
    this.branchModelId.set(this.node().modelId || this.resolvePreferredModelId(this.node()));
    this.pendingAction.set('switchCharacters');
    await this.sendDraft();
    await this.cancelEdit();
  }

  decRepeat(): void {
    this.repeatCount.update(n => Math.max(1, n - 1));
  }

  incRepeat(): void {
    this.repeatCount.update(n => Math.min(ChatNodeComponent.REPEAT_MAX, n + 1));
  }

  /**
   * Chain `count` Continue / Switch characters sends across successive empty
   * leaf questions. Each send fills the current draft leaf, streams the
   * answer, and the chat-page draft housekeeping appends the next empty leaf,
   * so the loop simply targets the newest leaf every iteration. One Stop
   * press aborts the WHOLE batch (beginOperation → operationAbort). The
   * current repetition number is published via chatService.batchProgress so
   * the answer node's spinner can render it below the spinner.
   */
  private async runDirectionBatch(
    direction: 'continue' | 'switchCharacters',
    count: number
  ): Promise<void> {
    if (!this.isUnsentQuestion() || this.isLoading()) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const modelId = this.node().modelId || this.resolvePreferredModelId(this.node());
    const model = this.enabledModels().find(
      m => m.modelId === modelId || m.id === modelId
    );
    if (!model) {
      this.toast.error(this.i18n.t('node.modelMissing'));
      return;
    }
    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      this.toast.error(this.i18n.t('node.providerMissing'));
      return;
    }

    const content = direction === 'continue'
      ? (this.promptDefaults.effective('structure.continue') || 'continue')
      : (this.promptDefaults.effective('structure.switchCharacters') || 'switch characters');

    // One Stop press cancels the whole batch.
    this.chatService.beginOperation(direction === 'continue' ? 'continue' : 'switchCharacters');
    this.pendingAction.set(direction);
    this.isLoading.set(true);
    this.chatService.batchProgress.set({ current: 1, total: count });
    try {
      for (let i = 1; i <= count; i++) {
        // Hard Stop aborts the operation; a graceful "Finish & stop"
        // (requestGracefulStop) also ends the batch, but only AFTER the
        // current stream has finished and been saved.
        if (this.chatService.shouldStopAfterCurrentStep()) break;
        this.chatService.batchProgress.set({ current: i, total: count });

        // Make sure the active path ends on an empty draft question to send on.
        await this.chatService.ensureDraftAtLeaf(chatId);
        let leaf = this.chatService.getActivePath().at(-1) ?? null;
        if (!leaf || leaf.role !== 'user' || (leaf.content ?? '').trim()) {
          // Draft housekeeping can still be settling (e.g. right after a lore
          // send flips exclude flags async). Retry once before giving up.
          await this.chatService.ensureDraftAtLeaf(chatId);
          leaf = this.chatService.getActivePath().at(-1) ?? null;
        }
        if (!leaf || leaf.role !== 'user' || (leaf.content ?? '').trim()) break;

        await this.sendDirectionOnce(chatId, leaf, content, model, provider);
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      this.toast.error(this.i18n.t('node.failed', { error: err?.message || err }));
    } finally {
      this.chatService.batchProgress.set(null);
      this.chatService.endOperation();
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  /** Persist + stream ONE direction onto a specific leaf question. */
  private async sendDirectionOnce(
    chatId: string,
    leaf: ChatNode,
    content: string,
    model: ModelEntry,
    provider: { baseUrl: string; apiKey: string }
  ): Promise<void> {
    // Only the FIRST iteration targets this component's own node, where the
    // parent's (activate) binding is valid. Foreign leaves (iterations 2+)
    // are activated directly through ChatService instead.
    const isOwn = leaf.id === this.node().id;
    const saved = await this.chatService.persistQuestion(
      chatId, leaf.id, content, [], model.modelId, model.providerId
    );
    if (isOwn) {
      this.activate.emit(saved.id);
    } else {
      this.chatService.setActiveChild(leaf.parentId ?? null, saved.id);
    }

    // Auto-generated meta directions (Continue, Switch characters) are sent
    // while they are the current question, but excluded from history after.
    await this.chatService.patchNode(chatId, saved.id, { excludeFromContext: true });

    if (!leaf.parentId) {
      const firstLine = content.split('\n')[0].trim().slice(0, 80);
      if (firstLine && this.chatService.chats().find(c => c.id === chatId)?.title === 'New Chat') {
        await this.chatService.updateChatTitle(chatId, firstLine);
      }
    }

    await this.streamAppendOrchestrated(chatId, saved, content, model, provider, {
      emitActivate: isOwn
    });
  }

  onDraftText(text: string): void {
    this.contentDraft.set(text);
    this.editSession.patch(this.node().id, text, this.editAttachments());
  }

  /**
   * Apply text produced by the shared search/replace dialog. The dialog
   * persists replacements through patchNode (committed content), but an open
   * editor renders the live draft — keep the two in sync so the textarea
   * shows what will be found next, and the draft stays the source of truth
   * for the next match offsets.
   */
  setDraftFromSearch(text: string): void {
    if (!this.isEditing()) return;
    this.contentDraft.set(text);
    this.editSession.patch(this.node().id, text, this.editAttachments());
    requestAnimationFrame(() => this.resizeTextarea());
  }

  private syncAttachments(): void {
    this.editSession.patch(this.node().id, this.contentDraft(), this.editAttachments());
  }


  private async resolveSendTarget(): Promise<{
    node: ChatNode;
    content: string;
    attachments: NodeAttachment[];
    chatId: string;
    model: ModelEntry;
    provider: { baseUrl: string; apiKey: string };
  } | null> {
    const node = this.node();
    const content = this.contentDraft().trim();
    const attachments = this.editAttachments();
    if (!content && attachments.length === 0) return null;

    const chatId = this.chatService.currentChatId();
    if (!chatId) return null;

    const modelId = this.branchModelId() || this.resolvePreferredModelId(node);
    const model = this.enabledModels().find(
      m => m.modelId === modelId || m.id === modelId
    );
    if (!model) {
      this.toast.error(this.i18n.t('node.modelMissing'));
      return null;
    }

    const provider = this.settings.providers().find(p => p.id === model.providerId);
    if (!provider) {
      this.toast.error(this.i18n.t('node.providerMissing'));
      return null;
    }

    return { node, content, attachments, chatId, model, provider };
  }

  private async runSend(
    pending: 'send' | 'branch' | 'insert' | 'continue' | 'switchCharacters',
    work: () => Promise<void>
  ): Promise<void> {
    if (pending !== 'continue' || this.pendingAction() !== 'continue') {
      this.pendingAction.set(pending);
    }
    this.isLoading.set(true);
    try {
      await work();
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.failed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  // ------------------------------------------------------------------
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

  /** Progress of a storyboard run (done/total), set while `pendingAction === 'image'`. */
  readonly imageProgress = signal<{ done: number; total: number } | null>(null);

  /** Which recorded prompt attachment is expanded inline (by attachment id). */
  readonly expandedPromptId = signal<string | null>(null);
  /** Which refused prompt attachment is being edited for re-render. */
  readonly editingPromptId = signal<string | null>(null);
  /** Live draft of the adapted prompt while editing a refused prompt. */
  readonly promptEditDraft = signal('');

  /** Button label while generating — "Creating…" or "Creating 3/12…" in storyboard mode. */
  imageProgressLabel(): string {
    const p = this.imageProgress();
    return p && p.total > 1
      ? this.i18n.t('node.generatingImageCount', { done: p.done, total: p.total })
      : this.i18n.t('node.generatingImage');
  }

  // ------------------------------------------------------------------
  // Recorded prompt attachments — show the text inline; adapt + re-render
  // the ones that were refused.
  // ------------------------------------------------------------------

  /** A text attachment recording an image prompt (`prompt-N.txt`, `refused-prompt-N.txt`). */
  isPromptAttachment(a: NodeAttachment): boolean {
    return isTextualMime(resolvedMime(a))
      && /^(?:refused-)?prompt(?:-\d+)?\.txt$/i.test(a.name);
  }

  /** A prompt attachment that records a REFUSED / empty image generation. */
  isRefusedPromptAttachment(a: NodeAttachment): boolean {
    return isTextualMime(resolvedMime(a))
      && /^refused-prompt(?:-\d+)?\.txt$/i.test(a.name);
  }

  /** Decoded text of a (prompt) attachment, or ''. */
  attachmentText(a: NodeAttachment): string {
    return typeof a.dataUrl === 'string' ? (decodeDataUrlToText(a.dataUrl) ?? '') : '';
  }

  /**
   * The actual prompt portion of a recorded prompt attachment. For refused
   * records the body is "Prompt used:\n…\n\nModel reply:\n…" — this returns
   * only the prompt part so an adapted edit starts from the prompt alone.
   */
  promptAttachmentPrompt(a: NodeAttachment): string {
    const text = this.attachmentText(a);
    if (this.isRefusedPromptAttachment(a)) {
      // Body: "Prompt used:\n<prompt>\n\nModel reply:\n<reply>"
      const m = text.match(/^Prompt used\s*:\n([\s\S]*?)\n\s*\n\s*Model reply:/i);
      if (m && (m[1] ?? '').trim()) return m[1].trim();
    }
    return text.trim();
  }

  /** The scene number recorded in a `prompt-N.txt` / `refused-prompt-N.txt` name (or null). */
  private promptRecordScene(a: NodeAttachment): number | null {
    const m = a.name.match(/^(?:refused-)?prompt-(\d+)\.txt$/i);
    return m ? Number(m[1]) : null;
  }

  /** True when `a` is an illustration paired with the given scene number. */
  private isIllustrationForScene(a: NodeAttachment, scene: number): boolean {
    return isImageMime(resolvedMime(a)) &&
      new RegExp(`^illustration-${scene}\.`, 'i').test(a.name);
  }

  togglePrompt(a: NodeAttachment): void {
    const same = this.expandedPromptId() === a.id;
    this.editingPromptId.set(null);
    this.promptEditDraft.set('');
    this.expandedPromptId.set(same ? null : a.id);
  }

  /** Open the inline editor for a refused prompt, pre-filled with the prompt used. */
  startPromptEdit(a: NodeAttachment): void {
    this.expandedPromptId.set(a.id);
    this.editingPromptId.set(a.id);
    this.promptEditDraft.set(this.promptAttachmentPrompt(a));
  }

  cancelPromptEdit(): void {
    this.editingPromptId.set(null);
    this.promptEditDraft.set('');
  }

  /**
   * Delete a recorded prompt attachment from the chapter (with confirmation).
   * Only the prompt trace/record is removed — a paired illustration, if any,
   * is kept. `editAssistant` versions the change, so the record stays
   * recoverable from prior versions.
   */
  async deletePromptAttachment(a: NodeAttachment): Promise<void> {
    const node = this.node();
    if (node.role !== 'assistant') return;
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const ok = await this.confirm.ask({
      title: this.i18n.t('node.promptDeleteTitle'),
      message: this.i18n.t('node.promptDeleteMsg', { name: a.name }),
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;

    try {
      const rest = (node.attachments || []).filter(x => x.id !== a.id);
      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        rest,
        node.thinking ?? undefined
      );
      // Close any open inline editor for this attachment.
      if (this.expandedPromptId() === a.id) this.expandedPromptId.set(null);
      if (this.editingPromptId() === a.id) {
        this.editingPromptId.set(null);
        this.promptEditDraft.set('');
      }
      this.activate.emit(saved.id);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('node.deleteFailed', { error: err?.message || err }));
    }
  }

  /**
   * Re-render ONE refused picture with the adapted prompt. The fresh image
   * (and its prompt file) replace the refused prompt record on the same
   * chapter; every other attachment stays. Runs the orchestration
   * `image-generation` use case: a single picture (no storyboard planning) —
   * the adapted prompt IS the concrete scene.
   */
  async rerenderPrompt(a: NodeAttachment): Promise<void> {
    const prompt = this.promptEditDraft().trim();
    const node = this.node();
    const chatId = this.chatService.currentChatId();
    if (!prompt || !chatId) return;
    if (node.role !== 'assistant') return;
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;

    this.isLoading.set(true);
    this.pendingAction.set('image');
    this.imageProgress.set(null);
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId);
      if (!chat) return;

      // The orchestration `image-generation` use case resolves the image
      // model itself (image-create task → first enabled image-capable model),
      // grounds the picture in the context up to the chapter, forwards prior
      // illustrations as reference when the model can read images, and
      // renders the ADAPTED prompt as a single concrete scene — no storyboard
      // planning.
      const promptText = `${this.i18n.t('node.imageAnchor', {
        role: this.i18n.t('node.roleAssistant')
      })}:\n${prompt}`;
      const result = await this.runner.run({
        chat,
        node,
        usecase: 'image-generation',
        vars: { promptText, count: 1 }
      });

      // A hard failure (e.g. no image model enabled) with no scene to fall
      // back on surfaces as an alert instead of silently doing nothing.
      const scenes = result.storyboard?.value ?? [];
      const images = result.images?.value ?? [];
      if (scenes.length === 0 && images.length > 0) {
        // No per-scene records but images came back (defensive — the
        // image-generation controller always emits a storyboard slot).
        scenes.push({ scene: 1, prompt: promptText, images, refused: false });
      }
      const imageCount = images.length;
      if (result.error?.status === 'error' && scenes.length === 0) {
        const reason = result.error.reason ?? '';
        if (/image model/i.test(reason)) {
          this.toast.error(this.i18n.t('node.imageModelMissing'));
          return;
        }
        throw new Error(reason || this.i18n.t('node.imageEmpty'));
      }

      const generated = buildIllustrationAttachments(scenes, promptText)
        .map(x => ({ ...x, id: x.id || newId() }));

      if (generated.length === 0) {
        const reply = (scenes[0]?.content ?? '').trim()
          || (result.text?.value ?? '').trim();
        throw new Error(
          reply
            ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
            : this.i18n.t('node.imageEmpty')
        );
      }

      // Replace the adapted record with the fresh result, renumbered to the
      // recorded scene number so it slots in next to the other storyboard
      // images instead of colliding with an existing `illustration-N`.
      const recordedScene = this.promptRecordScene(a);
      let rest = (node.attachments || []).filter(x => x.id !== a.id);
      if (recordedScene != null) {
        // For a SUCCESSFUL prompt (paired with an illustration), also drop the
        // old illustration of the same scene so the re-render REPLACES it
        // instead of duplicating the picture. A refused record has no image.
        rest = rest.filter(x => !this.isIllustrationForScene(x, recordedScene));
      }
      const placed = this.placeRerenderResult(generated, rest, recordedScene);
      const merged = [...rest, ...placed];

      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        merged,
        node.thinking ?? undefined
      );

      this.editingPromptId.set(null);
      this.promptEditDraft.set('');
      this.expandedPromptId.set(null);
      this.activate.emit(saved.id);

      if (imageCount === 0) {
        // The model refused again (or returned nothing parseable): the updated
        // refused-prompt record was saved above so the adapted prompt stays
        // findable and pre-fills the next attempt — but there is STILL no
        // picture. Surface the model's reply instead of silently "succeeding"
        // (same as `illustrate`).
        const reply = (scenes[0]?.content ?? '').trim()
          || (result.text?.value ?? '').trim();
        this.toast.error(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      }
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
      this.imageProgress.set(null);
    }
  }

  /**
   * Renumber the result of a refused-prompt re-render: illustration + prompt
   * files get the refused scene number when it is still free, otherwise the
   * next free number — so the re-rendered scene does not collide with other
   * storyboard attachments.
   */
  private placeRerenderResult(
    attachments: NodeAttachment[],
    existing: NodeAttachment[],
    preferredScene: number | null
  ): NodeAttachment[] {
    const used = new Set<number>();
    for (const a of existing) {
      const m = a.name.match(/^(?:illustration|(?:refused-)?prompt)-(\d+)(\.\w+)?$/i);
      if (m) used.add(Number(m[1]));
    }
    let scene = preferredScene && !used.has(preferredScene) ? preferredScene : 0;
    if (!scene) {
      scene = 1;
      while (used.has(scene)) scene++;
      used.add(scene);
    }
    return attachments.map(a => {
      const ill = a.name.match(/^illustration-(\d+)(\.\w+)?$/i);
      if (ill) {
        used.add(scene);
        return { ...a, name: `illustration-${scene}${ill[2] ?? ''}` };
      }
      // Keep a re-refused attempt REFUSED (do not demote it to a success
      // "prompt" file — the model returned no picture for it).
      const re = a.name.match(/^refused-prompt-(\d+)(\.\w+)?$/i);
      if (re) return { ...a, name: `refused-prompt-${scene}${re[2] ?? '.txt'}` };
      const pr = a.name.match(/^prompt-(\d+)(\.\w+)?$/i);
      if (pr) return { ...a, name: `prompt-${scene}${pr[2] ?? '.txt'}` };
      return a;
    });
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

  /**
   * Generate one or more pictures for the current beat with the configured
   * "image-create" generation task model (fallback: any enabled model that
   * can generate images). Opens the Illustrate dialog first to collect how
   * many scenes, the style, and (for word: >1 scenes) a storyboard prompt.
   * When a part of the node content is MARKED (selected), the dialog is
   * seeded with that marked text as the scene to depict — editable there —
   * and ALL illustration use cases (planned / direct / pure) then depict
   * exactly that marked part instead of the whole chapter. The prompt is
   * grounded in the active path up to this point, so earlier chapters stay
   * established context. A direction node delegates to the ASSISTANT chapter
   * that responds to it — the direction is only the instruction, the chapter
   * is the beat to depict (and the picture is attached to that chapter).
   * Prior illustrations are forwarded as visual reference when the chosen
   * model can also read images.
   *
   * @param promptOverride when given (e.g. an edited direction draft),
   *   use it as the scene description instead of the depicted node's content.
   */
  async illustrate(promptOverride?: string | null): Promise<void> {
    const pressed = this.node();
    if (pressed.role !== 'user' && pressed.role !== 'assistant') return;
    if (this.isLoading() || this.chatService.isGenerating(pressed.id)) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    // The node to depict is the CURRENT CHAPTER: when the button was pressed
    // on a direction (user) node, that is the assistant node right AFTER the
    // direction (the beat that responded to it) — `this.node()` alone is the
    // wrong node there. The picture is always attached to that chapter.
    let chapter: ChatNode;
    if (pressed.role === 'assistant') {
      chapter = pressed;
    } else {
      const answers = this.chatService.getChildren(pressed.id)
        .filter(c => c.role === 'assistant' && c.isCurrent);
      const candidate = answers[0] ?? this.chatService.getChildren(pressed.id)
        .find(c => c.role === 'assistant');
      if (!candidate) {
        this.toast.error(this.i18n.t('node.imageNoChapter'));
        return;
      }
      chapter = candidate;
    }
    const anchorText = promptOverride ?? chapter.content ?? '';

    // 1. Prefer the configured image-create task model.
    let defaultModel = this.generation.modelFor('image-create');
    let defaultProvider = this.generation.providerFor('image-create');
    // 2. Fall back to any enabled model that can generate images.
    if (!defaultModel || !defaultProvider) {
      const fallback = this.enabledModels().find(canGenerateImages);
      if (fallback) {
        defaultModel = fallback;
        defaultProvider = this.settings.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!defaultModel || !defaultProvider) {
      this.toast.error(this.i18n.t('node.imageModelMissing'));
      return;
    }

    // Ask the user how many scenes, in which style, the storyboard prompt,
    // and which image model should render the picture(s). The dialog is
    // seeded with the default rendering model, but its own last-used
    // selection (persisted in localStorage) wins when still valid. When a
    // part of the node content is marked, the marked text seeds the dialog's
    // "Scene to depict" field (editable) so the pictures depict exactly that
    // marked part in every use case.
    const markedSceneText = this.captureMarkedSceneText();
    const options = await this.illustrateDialog.open({
      modelId: defaultModel.modelId,
      providerId: defaultModel.providerId,
      ...(markedSceneText ? { sceneText: markedSceneText } : {})
    });
    if (!options) return; // cancelled
    const { count, style, storyboardPrompt, purePictures, historyMode, historyNodes, storyboardHistoryNodes, planDescriptions } = options;
    // The marked text the user confirmed in the dialog (may have edited it).
    // Empty = use the whole chapter content as the scene (classic behavior).
    const sceneText = (options.sceneText ?? '').trim();

    // The dialog's options CHOOSE the orchestration use case:
    //   count > 1 || assistant chapter || pure mode → planning-based
    //   storyboards; single direction → render-node (current) / render-window
    //   (last N beats) / render-full (complete chat). `content` overrides the
    //   node text so an edited draft (promptOverride) is used as the scene.
    // The window width is remembered PER USE CASE: storyboards (count > 1)
    // use `storyboardHistoryNodes`, single pictures use `historyNodes`.
    const activeHistoryNodes = count > 1
      ? (storyboardHistoryNodes ?? historyNodes)
      : historyNodes;
    const vars = {
      count,
      style,
      storyboardPrompt,
      purePictures,
      historyMode,
      historyNodes: activeHistoryNodes,
      planDescriptions,
      // The marked scene text (if any) overrides the whole chapter as the
      // scene — in ALL illustration use cases, planned / direct / pure.
      content: sceneText || anchorText,
      modelId: options.modelId || defaultModel.modelId,
      providerId: (options.modelId && options.providerId)
        ? options.providerId
        : defaultModel.providerId
    };
    const usecase = pickUsecase(vars);

    // Storyboard use cases (count > 1, the user-choice driving the planner)
    // render several pictures in stages: they take long enough to warrant a
    // Stop button, and each picture can be attached to the chapter AS SOON AS
    // it is ready (instead of waiting for the whole use case to finish).
    const isStoryboard =
      usecase === 'planned-enblock' || usecase === 'planned-scenes' || usecase === 'storyboard-direct';

    this.isLoading.set(true);
    this.pendingAction.set('image');
    this.imageProgress.set(null);

    // Where the pictures live DURING a storyboard run. Progressive writes
    // version the chapter node, so every write re-targets the LATEST version
    // and the final write replaces the interim attachments with the
    // authoritative placement plan (base attachments are captured once, at
    // start, and authoritative end state = base + final plan).
    let currentTargetId = chapter.id;
    const baseAttachments = [...(chapter.attachments ?? [])];
    const baseThinking = chapter.thinking ?? undefined;
    let interimChain: Promise<void> = Promise.resolve();
    let applySignal: AbortSignal | null = null;
    const onImages = isStoryboard
      ? (scenes: ImageScene[]): void => {
          const interim = buildIllustrationAttachments(scenes, anchorText)
            .map(a => ({ ...a, id: a.id || newId() }));
          // Serialize the progressive writes so they never race (each one
          // targets the node version returned by the previous write).
          interimChain = interimChain.then(async () => {
            try {
              const cur = this.chatService.nodes().find(n => n.id === currentTargetId) ?? chapter;
              const saved = await this.chatService.editAssistant(
                chatId,
                currentTargetId,
                cur.content || '',
                [...baseAttachments, ...interim],
                cur.thinking ?? baseThinking
              );
              currentTargetId = saved.id;
            } catch (err: any) {
              console.error(err);
            }
          });
        }
      : undefined;

    try {
      const chat = this.chatService.chats().find(c => c.id === chatId)!;
      if (isStoryboard) {
        // One Stop press cancels the whole illustrate use case: the returned
        // signal propagates into the orchestration runner so in-flight LLM
        // calls abort and no further scenes are rendered.
        applySignal = this.chatService.beginOperation('illustrate');
        this.chatService.isIllustrating.set(true);
      }
      const build = { chat, node: chapter, usecase, vars };
      const result = await this.runner.run(build, {
        signal: applySignal ?? undefined,
        ...(onImages ? { onImages } : {})
      });
      await interimChain; // flush any pending progressive writes

      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error

      // Place the pictures on the chapter node (illustration-N + prompt-N /
      // refused-prompt-N attachments), consistent with the app.
      const plan = this.postprocessor.plan(result, build);
      if (!plan) {
        throw new Error(this.i18n.t('node.imageNoChapter'));
      }

      let saved: ChatNode;
      if (isStoryboard) {
        // Replace the interim (progressively attached) pictures with the
        // authoritative final plan — the progressive writes above are
        // supersets of the start state, so this never duplicates.
        const cur = this.chatService.nodes().find(n => n.id === currentTargetId) ?? chapter;
        saved = await this.chatService.editAssistant(
          chatId,
          currentTargetId,
          cur.content || '',
          [...baseAttachments, ...plan.attachments],
          cur.thinking ?? baseThinking
        );
      } else {
        saved = await this.postprocessor.apply(plan, build);
      }
      this.activate.emit(saved.id);

      const imagesTotal = plan.summary.imagesTotal;
      if (imagesTotal === 0) {
        // Everything was refused — the refused-prompt attachments were saved
        // above so the prompts stay findable; still inform the user. Prefer
        // the model's own refusal reply: it lives on the refused scenes'
        // `content` (storyboard-direct does NOT fill `result.text`), falling
        // back to the generic empty message (UX playbook §8: the user sees
        // the reason, not a generic failure).
        const refusedReply = (result.storyboard?.value ?? [])
          .find(s => (s.content ?? '').trim())?.content?.trim() ?? '';
        const reply = result.text?.value?.trim() ?? refusedReply;
        this.toast.error(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      } else if (count > 1 && imagesTotal < count) {
        // Storyboard partially completed — keep what was generated, tell the
        // user how many scenes came back.
        this.toast.info(this.i18n.t('node.imagePartial', {
          got: imagesTotal,
          want: count
        }));
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      this.toast.error(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
      this.imageProgress.set(null);
      if (isStoryboard) {
        this.chatService.isIllustrating.set(false);
        this.chatService.endOperation();
      }
    }
  }

  /**
   * Send an unsent question (the in-thread composer).
   * Writes the draft onto this same node, then streams the answer.
   *
   * Text-only sends go through the LLM-orchestration `append` use case (full
   * chat history + topic system prompt via the request builder). Directions
   * carrying image attachments use `append-with-images`: the images are
   * described first by the image-interpret model and the description is
   * merged into the direction text (no binary images reach the writing
   * model).
   */
  async sendDraft(): Promise<void> {
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, chatId, model, provider } = target;

    const pending = this.pendingAction();
    await this.runSend(pending === 'continue' || pending === 'switchCharacters' ? pending : 'send', async () => {
      const saved = await this.chatService.persistQuestion(
        chatId,
        node.id,
        content,
        attachments,
        model.modelId,
        model.providerId
      );
      this.activate.emit(saved.id);

      // Auto-generated meta directions (Continue, Switch characters) and
      // directions in a chat with the "auto-exclude directions" mode are
      // sent while they are the current question, but excluded from history
      // afterwards (the stream builder skips excluded history nodes and
      // always sends the final one).
      const isMetaDirection =
        this.pendingAction() === 'continue' || this.pendingAction() === 'switchCharacters';
      const chat = this.chatService.chats().find(c => c.id === chatId);
      if (isMetaDirection || chat?.autoExcludeDirections) {
        await this.chatService.patchNode(chatId, saved.id, { excludeFromContext: true });
      }

      if (!node.parentId) {
        const firstLine = content
          ? content.split('\n')[0].trim().slice(0, 80)
          : (attachments[0]?.name ?? '');
        if (firstLine && this.chatService.chats().find(c => c.id === chatId)?.title === 'New Chat') {
          await this.chatService.updateChatTitle(chatId, firstLine);
        }
      }

      const hasImages = attachments.some(
        a => isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:')
      );
      if (hasImages) {
        await this.streamAppendOrchestrated(chatId, saved, content, model, provider, {
          usecase: 'append-with-images',
          attachments
        });
        return;
      }

      await this.streamAppendOrchestrated(chatId, saved, content, model, provider);
    });
  }

  /**
   * Stream one answer through the LLM-orchestration text-send use cases:
   * the request builder sends the FULL chat up to this node (+ topic system
   * prompt), the transport streams, and the evaluator folds the chunks into
   * the text slot — while `onChunk` paints the answer node LIVE during the
   * SSE stream. Placement (versioned editAssistant) goes through ChatService
   * so the chat stays consistent with the rest of the app.
   */
  private async streamAppendOrchestrated(
    chatId: string,
    question: ChatNode,
    content: string,
    model: ModelEntry,
    provider: { baseUrl: string; apiKey: string },
    opts: { usecase?: 'append' | 'append-with-images'; attachments?: NodeAttachment[]; emitActivate?: boolean } = {}
  ): Promise<void> {
    // Close the inline editor NOW (commit the session + clear the draft),
    // mirroring the legacy streamForQuestion timing — the editor does not
    // stay in edit mode after Send.
    this.closeEditor();

    // Placeholder answer bubble so the user sees it (and can Stop) streaming.
    const answerNode = await this.chatService.addNode(chatId, {
      parentId: question.id,
      role: 'assistant',
      content: '',
      thinking: '',
      modelId: model.modelId,
      providerId: model.providerId
    });
    this.chatService.setActiveChild(question.id, answerNode.id);
    const signal = this.chatService.startGeneration(answerNode.id);
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    const usecase = opts.usecase ?? 'append';
    const vars = {
      content,
      ...(usecase === 'append-with-images'
        ? { attachments: opts.attachments }
        : {})
    };

    let accContent = '';
    let accThinking = '';
    let accImages: LlmImagePart[] = [];
    // Reveal pump: pace the streamed answer at the configured chars/s or
    // words/s instead of painting the whole buffer on every chunk (restores
    // the legacy LlmService behaviour lost when streaming moved into the
    // orchestration flows). Painting is a view concern.
    const reveal = new StreamReveal(this.chatService, (content, thinking) => {
      this.paintAnswer(answerNode.id, content, thinking);
    });
    try {
      const slots = await this.runner.run(
        { chat, node: question, usecase, vars },
        {
          signal,
          nodeId: answerNode.id,
          onChunk: chunk => {
            if (chunk.content) accContent += chunk.content;
            if (chunk.thinking) accThinking += chunk.thinking;
            if (chunk.images?.length) accImages.push(...chunk.images);
            reveal.update(accContent, accThinking);
          }
        }
      );

      // The model is done: keep revealing the leftover buffer at the chosen
      // speed (respecting paceAfterComplete) before the answer is finalized.
      await reveal.finish(accContent, accThinking, { signal });

      // append-with-images: persist the merged direction text (direction +
      // image description) ONTO the user node for real, so the description
      // stays available in the history. The interpretation RECORD is stored
      // too — it marks "the description is already part of this node's text",
      // so the same images are NOT interpreted again on a later send.
      // The attachments themselves remain on the node but are never sent to
      // the LLM (history is text-only).
      const interpretation = slots.interpretation?.value;
      const mergedDirection = interpretation?.content?.trim()
        ?? slots.direction?.value?.trim();
      if (mergedDirection && mergedDirection !== question.content?.trim()) {
        const attachments = interpretation
          ? [...(question.attachments ?? []), interpretation.record as NodeAttachment]
          : question.attachments;
        await this.chatService.patchNode(chatId, question.id, {
          content: mergedDirection,
          ...(interpretation ? { attachments } : {})
        });
      } else if (interpretation) {
        // Content already matches — only store the record so re-sends skip.
        const attachments = [...(question.attachments ?? []), interpretation.record as NodeAttachment];
        await this.chatService.patchNode(chatId, question.id, { attachments });
      }

      // Prefer the evaluator's settled slots.
      const finalContent = slots.text?.value ?? accContent;
      const finalThinking = slots.thinking?.value ?? accThinking;
      const finalImages = slots.images?.value ?? accImages;
      // An IMAGE-ONLY answer (the writing model returned only pictures, no
      // text): fill the chapter with the original direction so it is not an
      // empty bubble — the generated image is attached below it.
      const chapterContent = imageOnlyAnswerContent(finalContent, question.content, finalImages);
      this.paintAnswer(answerNode.id, chapterContent, finalThinking);

      // An image-only answer (image-capable model streamed pictures, no text)
      // must STILL be finalized with its attachments — otherwise it stays an
      // empty placeholder that renders as "Generation stopped".
      if (chapterContent.trim() || finalThinking.trim() || finalImages.length > 0) {
        const attachments = finalImages.length
          ? generatedImageAttachments(finalImages)
          : undefined;
        const versioned = await this.chatService.editAssistant(
          chatId, answerNode.id, chapterContent, attachments, finalThinking, slots.usage?.value ?? undefined
        );
        this.chatService.setActiveChild(question.id, versioned.id);
        // For batch iterations on foreign leaves the component's (activate)
        // output is bound to THIS node's parent — activating the answer under
        // the foreign question directly via ChatService is the correct move.
        if (opts.emitActivate !== false) {
          this.activate.emit(versioned.id);
        }
        // The call was logged under the placeholder id — the versioned answer
        // node that is kept must carry the usage/cost instead.
        if (slots.logEntry && versioned.id !== answerNode.id) {
          this.llmLog.retargetNode(slots.logEntry, versioned.id);
        }
      }
    } finally {
      // Show whatever arrived (error/abort) or nothing extra (success already
      // revealed + finalized); stop the pump either way.
      reveal.flush();
      reveal.destroy();
      this.chatService.clearGeneration();
      // One-shot excluded nodes (e.g. the chat-lore node created with
      // `excludeAfterSend`) were just sent as part of this request: flip them
      // to permanently excluded so they document but never re-ship.
      await this.chatService.markSentOnceExcluded(chatId, question.id);
    }
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
      const slots = await this.flowRunner.run(build as never);
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
    }
  }

  /**
   * Branch — create a new sibling question (a new leaf) and stream an answer.
   *
   * - From a question: sibling under the same parent.
   * - From an answer: new question whose parent is this answer
   *   (continues the thread from this point).
   */
  async saveAsBranchAndSend(): Promise<void> {
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, model } = target;

    const ok = await this.runFlow('send-branch', 'branch', build => {
      build.vars['content'] = content;
      build.vars['attachments'] = attachments;
      // The model selected in the editor wins — the flow writer (and the new
      // question node) must use the freshly chosen model, not the node's.
      build.vars['modelId'] = model.modelId;
      build.vars['providerId'] = model.providerId;
    });
    // The draft was consumed to create the branch — close the editor so the
    // edit session is not left dangling (otherwise the next edit on this node
    // reopens a stale, dirty session).
    if (ok) this.closeEditor();
  }

/**
   * Insert — like Branch (new sibling question + LLM answer with the same
   * prior-message context), then hang the previous question and its siblings
   * under that new assistant answer.
   */
  async saveAsInsertAndSend(): Promise<void> {
    const target = await this.resolveSendTarget();
    if (!target) return;
    const { node, content, attachments, model } = target;
    if (node.role !== 'user') return;

    // The draft was consumed to create the insert: close the editor NOW
    // (commit the session) so it does not stay open while the insert flow
    // streams its answer — matching the Send path timing.
    this.closeEditor();

    await this.runFlow('send-insert', 'insert', build => {
      build.vars['content'] = content;
      build.vars['attachments'] = attachments;
      // The model selected in the editor wins — the flow writer (and the new
      // question node) must use the freshly chosen model, not the node's.
      build.vars['modelId'] = model.modelId;
      build.vars['providerId'] = model.providerId;
    });
  }

  /** Generate a chapter heading for THIS assistant answer; only its text is used as context. */
  async generateHeading(): Promise<void> {
    if (this.isLoading()) return;
    const node = this.node();
    if (node.role !== 'assistant') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const configuredModel = this.generation.modelFor('headings');
    const model = configuredModel
      ?? this.enabledModels().find(m => m.modelId === this.resolvePreferredModelId(node));
    const provider = model
      ? this.settings.providers().find(p => p.id === model.providerId)
      : null;
    if (!model || !provider) {
      this.toast.error(this.i18n.t('node.structureModelMissing'));
      return;
    }

    this.isLoading.set(true);
    this.pendingAction.set('structure');
    try {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      // The `structure-heading` use case resolves the task prompt, runs the
      // non-streaming completion and creates/patches the structural heading
      // (activating it via the flow result).
      const slots = await this.runner.run({
        chat,
        node,
        usecase: 'structure-heading',
        vars: { modelId: model.modelId, providerId: model.providerId }
      });
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.structureEmpty'));
      }
      const structureNodeId = slots.flow?.value?.structureNodeId;
      if (structureNodeId) this.activate.emit(structureNodeId);
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.structureFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  /**
   * "Check my English" — asks the LLM to review the current direction and
   * return three improved variants. The main goal is NOT style: directions are
   * not part of the finished story, so the focus is grammar / orthography /
   * unambiguous wording that helps the writing model understand the intent.
   * One variant ("minimal") stays as close to the original as possible.
   *
   * Model/provider come from the "language-check" generation task (Settings →
   * Generation tasks); when the task is unset it falls back to the model
   * selected in the editor (the one that will read the direction).
   */
  async checkMyEnglish(): Promise<void> {
    if (this.node().role !== 'user' || !this.isEditing()) return;
    if (this.checkingEnglish() || this.isLoading()) return;

    const text = this.contentDraft().trim();
    if (!text) {
      this.toast.error(this.i18n.t('node.englishEmpty'));
      return;
    }

    // 1. Prefer the model configured for the language-check task.
    let model = this.generation.modelFor('language-check');
    let provider = this.generation.providerFor('language-check');
    if (!model || !provider) {
      // 2. Fall back to the model selected in the editor / the preferred model.
      const modelId = this.branchModelId() || this.resolvePreferredModelId(this.node());
      const fallback = this.enabledModels().find(
        m => m.modelId === modelId || m.id === modelId
      );
      model = fallback ?? null;
      provider = fallback
        ? this.settings.providers().find(p => p.id === fallback.providerId) ?? null
        : null;
    }
    if (!model || !provider) {
      this.toast.error(this.i18n.t('node.englishModelMissing'));
      return;
    }

    this.checkingEnglish.set(true);
    this.englishSuggestions.set(null);
    try {
      const chatId = this.chatService.currentChatId();
      const chat = chatId
        ? this.chatService.chats().find(c => c.id === chatId) ?? null
        : null;
      // The `language-check` use case resolves the task prompt + model, runs
      // the non-streaming completion and returns the RAW model text — the
      // variants are parsed here for the suggestion panel.
      const slots = await this.runner.run({
        chat,
        node: this.node(),
        usecase: 'language-check',
        vars: { content: text, modelId: model.modelId, providerId: model.providerId }
      });
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('node.englishFailed'));
      }
      const variants = this.parseEnglishVariants(slots.text?.value ?? '');
      if (variants.length === 0) {
        this.toast.error(this.i18n.t('node.englishFailed', {
          error: this.i18n.t('node.englishNoVariants')
        }));
        return;
      }
      this.englishSuggestions.set(variants);
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.englishFailed', { error: err?.message || err }));
    } finally {
      this.checkingEnglish.set(false);
    }
  }

  /** Replace the draft with a chosen variant and close the panel. */
  applyEnglishSuggestion(text: string): void {
    this.contentDraft.set(text);
    this.editSession.patch(this.node().id, text, this.editAttachments());
    this.englishSuggestions.set(null);
    this.scheduleResize();
  }

  dismissEnglishCheck(): void {
    this.englishSuggestions.set(null);
  }

  /**
   * Rewrite the MARKED text of the editor: capture the current textarea
   * selection, open the rewrite dialog (editable fragment + directions +
   * context scope + model), and when the dialog returns a text, replace the
   * marked range in the draft with it. Works for both directions (user) and
   * chapters (assistant) while editing.
   */
  async openRewriteDialog(): Promise<void> {
    if (!this.isEditing() || this.isLoading() || this.checkingEnglish()) return;
    const ta = this.editArea()?.nativeElement;
    if (!ta) return;

    const s = Math.min(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    const e = Math.max(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    const draft = this.contentDraft();
    const fragment = draft.slice(s, e);
    if (!fragment.trim()) {
      this.toast.error(this.i18n.t('node.rewriteNoSelection'));
      return;
    }

    const node = this.node();
    const chatId = this.chatService.currentChatId();
    const chat = chatId
      ? this.chatService.chats().find(c => c.id === chatId) ?? null
      : null;
    const result = await this.rewriteDialog.open({
      fragment,
      // The whole node content is the most useful default context; the user
      // can narrow it (none / up to the marked part / whole thread) in the dialog.
      contextMode: 'node',
      selectionEnd: e,
      node,
      chat,
      modelId: node.modelId || this.resolvePreferredModelId(node),
      providerId: node.providerId ?? ''
    });
    if (result == null) return; // cancelled

    const next = draft.slice(0, s) + result + draft.slice(e);
    this.contentDraft.set(next);
    this.editSession.patch(node.id, next, this.editAttachments());
    this.scheduleResize();
    // Restore focus and place the cursor around the inserted replacement.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s, s + result.length);
    });
  }

  /** Parse the LLM answer into up to 3 suggestion strings. */
  private parseEnglishVariants(content: string): string[] {
    return parseSuggestionVariants(content);
  }

  /**
   * Rewrite a piece of text MARKED in the rendered (non-edit) content.
   * Captures the current DOM selection inside the node, opens the rewrite
   * dialog (editable fragment + directions + context scope + model), and when
   * the dialog returns a text, persists a new version of the node with the
   * marked range replaced. The marked text is located in the markdown source
   * via a marker map (markdown syntax removed, whitespace collapsed), so the
   * rest of the source — including surrounding markdown formatting — is
   * preserved. If the range cannot be mapped back at all, the rewrite is
   * appended at the end of the node instead of being lost.
   */
  async openReadRewriteDialog(): Promise<void> {
    if (this.isEditing() || this.isLoading()) return;
    const contentEl = this.readContent()?.nativeElement;
    const selection = window.getSelection();
    if (!contentEl || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      this.toast.error(this.i18n.t('node.rewriteNoSelection'));
      return;
    }
    if (!contentEl.contains(selection.anchorNode) || !contentEl.contains(selection.focusNode)) {
      this.toast.error(this.i18n.t('node.rewriteNoSelection'));
      return;
    }
    const fragment = selection.toString();
    if (!fragment.trim()) {
      this.toast.error(this.i18n.t('node.rewriteNoSelection'));
      return;
    }

    const node = this.node();
    const source = node.content || '';
    const loc = markFragmentInSource(source, fragment);
    const chatId = this.chatService.currentChatId();
    const chat = chatId
      ? this.chatService.chats().find(c => c.id === chatId) ?? null
      : null;
    const result = await this.rewriteDialog.open({
      fragment,
      // The whole node content is the most useful default context; the user
      // can narrow it (none / up to the marked part / whole thread) in the dialog.
      contextMode: 'node',
      selectionEnd: loc ? loc.index + loc.length : source.length,
      node,
      chat,
      modelId: node.modelId || this.resolvePreferredModelId(node),
      providerId: node.providerId ?? ''
    });
    if (result == null) return; // cancelled

    // Never lose the created rewrite: when the marked range cannot be mapped
    // back to the source (formatting/rendering differences), append the
    // rewrite at the end of the node instead of discarding it.
    const newContent = loc
      ? source.slice(0, loc.index) + result + source.slice(loc.index + loc.length)
      : appendRewriteFallback(source, result);
    if (!loc) this.toast.info(this.i18n.t('node.rewriteAppended'));

    this.isLoading.set(true);
    this.pendingAction.set('version');
    try {
      let saved: ChatNode;
      if (node.role === 'assistant' || node.role === 'system' || node.role === 'structural') {
        saved = await this.chatService.editAssistant(
          chatId!,
          node.id,
          newContent,
          node.attachments || []
        );
      } else {
        saved = await this.chatService.editUser(
          chatId!,
          node.id,
          newContent,
          node.attachments || []
        );
      }
      this.activate.emit(saved.id);
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.saveFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
    }
  }

  /**
   * Create an image of a piece of text MARKED in the rendered chapter content.
   * Captures the current DOM selection inside the ASSISTANT node, opens the
   * "Create image" dialog (chat-specific constant + the marked text, both
   * editable, plus optional reference images + the image model), and when the
   * dialog confirms, sends the combined text AS-IS (with any reference images)
   * to the image model. The created picture is attached to the assistant node
   * via `editAssistant` (versioned), exactly like the illustration flow.
   *
   * Unlike `illustrate` there is NO planning and NO drawing-instruction
   * template — "send it as it is" is the point of this action; reference
   * images only ever appear when the user attached them.
   */
  async openReadCreateImageDialog(): Promise<void> {
    if (this.isEditing() || this.isLoading()) return;
    const node = this.node();
    if (node.role !== 'assistant') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const contentEl = this.readContent()?.nativeElement;
    const selection = window.getSelection();
    if (!contentEl || !selection || selection.isCollapsed || selection.rangeCount === 0 ||
        !contentEl.contains(selection.anchorNode) || !contentEl.contains(selection.focusNode)) {
      this.toast.error(this.i18n.t('node.createImageNoSelection'));
      return;
    }
    const script = selection.toString();
    if (!script.trim()) {
      this.toast.error(this.i18n.t('node.createImageNoSelection'));
      return;
    }

    // Default image-producing model from the settings (image-create task,
    // fallback: the first enabled image-capable model).
    let defaultModel = this.generation.modelFor('image-create');
    let defaultProvider = this.generation.providerFor('image-create');
    if (!defaultModel || !defaultProvider) {
      const fallback = this.enabledModels().find(canGenerateImages);
      if (fallback) {
        defaultModel = fallback;
        defaultProvider = this.settings.providers().find(p => p.id === fallback.providerId) ?? null;
      }
    }
    if (!defaultModel || !defaultProvider) {
      this.toast.error(this.i18n.t('node.imageModelMissing'));
      return;
    }

    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
    const result = await this.createImageDialog.open({
      chatId,
      chat,
      node,
      script,
      modelId: defaultModel.modelId,
      providerId: defaultModel.providerId
    });
    if (!result) return; // cancelled

    // The text is sent AS-IS: the chat constant (always shown) followed by
    // the marked text, with the reference images attached as image parts.
    const prompt = [result.constant.trim(), result.script.trim()]
      .filter(Boolean)
      .join('\n\n');
    if (!prompt.trim() && result.images.length === 0) {
      this.toast.error(this.i18n.t('createImageDialog.empty'));
      return;
    }

    this.isLoading.set(true);
    this.pendingAction.set('image');
    this.imageProgress.set(null);
    try {
      const build = {
        chat,
        node,
        usecase: 'image-send' as const,
        vars: {
          promptText: prompt,
          attachments: result.images,
          count: 1,
          modelId: result.modelId || defaultModel.modelId,
          providerId: (result.modelId && result.providerId)
            ? result.providerId
            : defaultModel.providerId
        }
      };
      const slots = await this.runner.run(build);

      const scenes = slots.storyboard?.value ?? [];
      const images = slots.images?.value ?? [];
      if (scenes.length === 0 && images.length > 0) {
        // No per-scene records but images came back (defensive).
        scenes.push({ scene: 1, prompt, images, refused: false });
      }
      if (slots.error?.status === 'error' && scenes.length === 0) {
        const reason = slots.error.reason ?? '';
        if (/image model/i.test(reason)) {
          this.toast.error(this.i18n.t('node.imageModelMissing'));
          return;
        }
        throw new Error(reason || this.i18n.t('node.imageEmpty'));
      }

      const generated = buildIllustrationAttachments(scenes, prompt)
        .map(x => ({ ...x, id: x.id || newId() }));
      if (generated.length === 0) {
        const reply = (scenes[0]?.content ?? '').trim()
          || (slots.text?.value ?? '').trim();
        throw new Error(
          reply
            ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
            : this.i18n.t('node.imageEmpty')
        );
      }

      // Attach the created picture (+ the prompt record) to the chapter node.
      const merged = [...(node.attachments ?? []), ...generated];
      const saved = await this.chatService.editAssistant(
        chatId,
        node.id,
        node.content || '',
        merged,
        node.thinking ?? undefined
      );
      this.activate.emit(saved.id);

      if (images.length === 0) {
        // Everything refused — the refused-prompt record was saved so the
        // prompt stays findable; still inform the user.
        const reply = (scenes[0]?.content ?? '').trim()
          || (slots.text?.value ?? '').trim();
        this.toast.error(reply
          ? `${this.i18n.t('node.imageEmpty')} — ${reply.slice(0, 300)}`
          : this.i18n.t('node.imageEmpty'));
      }
    } catch (err: any) {
      console.error(err);
      this.toast.error(this.i18n.t('node.imageFailed', { error: err?.message || err }));
    } finally {
      this.isLoading.set(false);
      this.pendingAction.set(null);
      this.imageProgress.set(null);
    }
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

    const children = this.chatService.getChildren(node.id);
    if (children.length > 0) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.regenerateInPlaceTitleAsk'),
        message: this.i18n.t('node.regenerateInPlaceMsgExtra', { count: children.length }),
        confirmLabel: this.i18n.t('node.regenerateInPlace'),
        cancelLabel: this.i18n.t('common.cancel'),
        danger: true
      });
      if (!ok) return;
    }

    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    await this.runFlow('send-rewrite', 'send', build => {
      // The flow deletes only THIS answer (keeping children) and re-streams
      // under its parent question, re-adopting the preserved children.
      build.vars['keepChildren'] = true;
    });
  }

  async deleteNodeOnly(): Promise<void> {
    const node = this.node();
    if (this.isLoading() || this.chatService.isGenerating(node.id)) return;
    const hasPayload = !!node.content?.trim() || !!(node.attachments && node.attachments.length);
    if (hasPayload) {
      const childCount = this.chatService.getChildren(node.id).length;
      const ok = await this.confirm.ask({
        title: this.i18n.t('node.removeTitleAsk'),
        message: childCount > 0
          ? this.i18n.t('node.removeMsgChildren', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem'), count: childCount })
          : this.i18n.t('node.removeMsg', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem') }),
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
          ? this.i18n.t('node.deleteMsgExtra', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem'), count: extra, filled: nonTrivial.length })
          : this.i18n.t('node.deleteMsg', { role: node.role === 'user' ? this.i18n.t('node.roleUser') : node.role === 'assistant' ? this.i18n.t('node.roleAssistant') : this.i18n.t('node.roleSystem') }),
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
      t: (key, params) => this.i18n.t(key, params),
      actions: {
        copy: () => void this.copyContent(),
        edit: () => void this.startEdit(),
        rewrite: () => void this.openReadRewriteDialog(),
        togglePriorVersions: () => this.showPriorVersions.set(!this.showPriorVersions()),
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
        remove: () => void this.deleteNodeOnly(),
        delete: () => void this.deleteNode(),
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
  }


  private buildContextMessagesUpTo(parentId: string | null): ChatMessage[] {
    if (!parentId) return [];

    if (typeof (this.chatService as any).getPathToNode === 'function') {
      const path: ChatNode[] = (this.chatService as any).getPathToNode(parentId);
      const messages: ChatMessage[] = [];

      for (const n of path) {
        if (n.role !== 'structural') {
          // Excluded meta / lore-documentation nodes are skipped (they show in
          // the UI but are not part of the LLM context history).
          if (n.excludeFromContext) continue;
          messages.push({ role: n.role, content: nodeToMessageContent(n) });
        }
      }
      return messages;
    }
    return [];
  }

  readonly renderedHtml = signal('');

  constructor() {
    effect(() => {
      const content = this.node().content;
      this.updateRendered(content);
    });
    effect(() => {
      // The selection is bound to a specific node: when the displayed node
      // changes (navigation, versioning) stale ids must not linger.
      this.nodeIdForSelection();
      this.clearAttachmentSelection();
    });
    effect(() => {
      const id = this.node().id;
      this.prependEnabled.set(this.isPrependStored(id));
      this.prependText.set(this.storedPrependText(id));
    });

    afterRenderEffect(() => {
      const n = this.node();
      this.renderedHtml();
      const generating = this.chatService.isGenerating(n.id)
        || this.chatService.generatingNodeId() === n.id;
      if (!generating) return;
      if (this.chatService.followThinking() && n.thinking?.trim()) {
        this.thinkingClosed.set(false);
      }
      if (this.chatService.followStreaming() || (this.chatService.followThinking() && !n.content?.trim())) {
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
  }

  /**
   * Stored director texts per node id (a `{ [nodeId]: string }` map).
   * The value is the edited director instruction; presence ⇒ prepend enabled.
   */
  private readPrependMap(): Record<string, string> {
    try {
      const raw = localStorage.getItem(ChatNodeComponent.LS_PREPEND);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writePrependMap(map: Record<string, string>): void {
    try {
      localStorage.setItem(ChatNodeComponent.LS_PREPEND, JSON.stringify(map));
    } catch { /* best-effort */ }
  }

  private isPrependStored(nodeId: string): boolean {
    const map = this.readPrependMap();
    return Object.prototype.hasOwnProperty.call(map, nodeId);
  }

  private storedPrependText(nodeId: string): string {
    const map = this.readPrependMap();
    return Object.prototype.hasOwnProperty.call(map, nodeId) ? (map[nodeId] ?? '') : '';
  }

  /**
   * Open the "Prepend director" dialog, prefilled with the existing editor
   * text or a newly-proposed instruction (from `prependInstruction`). On
   * confirm, the edited text is stored AND the LLM is called with the
   * director instruction + the following assistant chapters (≤5000 tokens);
   * the result is inserted as TWO new nodes BEFORE the current
   * direction/user/question node: the prompt-prefix (director) node and the
   * LLM result node. An empty confirmed text clears the director.
   */
  async openPrependDialog(): Promise<void> {
    const node = this.node();
    if (node.role !== 'user') return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;

    const nodeId = node.id;
    const existing = this.storedPrependText(nodeId);
    const proposed = existing.trim() || this.prependInstruction();
    const text = await this.prependDialog.open(proposed, this.isPrependStored(nodeId));
    // Cancel resolves null — keep the current state.
    if (text == null) return;
    const cleaned = text.trim();
    const map = this.readPrependMap();
    if (cleaned) {
      map[nodeId] = cleaned;
    } else {
      delete map[nodeId];
    }
    this.writePrependMap(map);
    this.prependEnabled.set(this.isPrependStored(nodeId));
    this.prependText.set(this.storedPrependText(nodeId));
    if (!cleaned) return; // cleared — no generation

    await this.generatePrependNodes(node, cleaned);
  }

  /**
   * Insert the director (user) node + a streamed result (assistant) BEFORE
   * the current direction, adopting the current node under the result — via
   * the orchestration `send-prepend` flow. On failure the stored flag is
   * rolled back.
   */
  private async generatePrependNodes(
    node: ChatNode,
    directorText: string
  ): Promise<void> {
    const following = this.followingAssistantContent(node.id);
    const hasHistory = this.buildContextMessagesUpTo(node.parentId).length > 0
      || following.trim().length > 0;
    // Nothing to narrate — no assistant chapter anywhere in the thread.
    if (!hasHistory) return;

    const ok = await this.runFlow('send-prepend', 'prepend', build => {
      build.vars['directorText'] = directorText;
      build.vars['followingText'] = following;
    });
    // On failure the flow runner alerted; roll back the stored flag so the UI
    // reflects "not active".
    if (!ok && this.prependEnabled()) {
      const map = this.readPrependMap();
      delete map[node.id];
      this.writePrependMap(map);
      this.prependEnabled.set(false);
      this.prependText.set('');
    }
  }

  /**
   * Open the "Create chapter descriptions" dialog (available on the last
   * node, next to Continue). On confirm, the chapter description list is
   * generated as ANOTHER branch to the first one: a new sibling question
   * carries the request (previous visible chat content + the dialog
   * parameters + goal) and the answer streams under it. The last input
   * parameters are remembered per chat, so the next press of the button
   * provides them again (first chapter continues after the last generated).
   */
  async openChapterDescriptionsDialog(): Promise<void> {
    const node = this.node();
    if (node.role !== 'user' || this.isLoading()) return;
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;

    const defaultModelId = node.modelId || this.resolvePreferredModelId(node);
    const result = await this.chapterDescriptionsDialog.open({
      chatId,
      chat,
      node,
      defaultModelId,
      defaultProviderId: node.providerId ?? ''
    });
    if (result == null) return; // cancelled

    await this.runFlow('send-chapter-descriptions', 'chapterDescriptions', build => {
      build.vars['chapterCount'] = result.chapterCount;
      build.vars['sentencesPerChapter'] = result.sentencesPerChapter;
      build.vars['firstChapter'] = result.firstChapter;
      build.vars['goal'] = result.goal;
      // The model chosen in the dialog wins — the new branch must use the
      // freshly chosen model, not the node's (its draft is left untouched).
      build.vars['modelId'] = result.modelId;
      build.vars['providerId'] = result.providerId;
    });
  }

  private followLive(): void {
    const anchor = this.streamEnd()?.nativeElement;
    if (!anchor) return;
    followLiveScroll(anchor, this.scrollParentOf.bind(this));
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
    this.chatService.stopGeneration();
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
  }
  private elaborateCharacters(): string {
    try {
      const chatId = this.chatService.currentChatId();
      if (!chatId) return '';
      const raw = localStorage.getItem('chat-client.elaborate.byChatId');
      const map = raw ? JSON.parse(raw) : {};
      const entry = map?.[chatId];
      return typeof entry?.characters === 'string' ? entry.characters.trim() : '';
    } catch {
      return '';
    }
  }

  private prependInstruction(): string {
    // The stored (user-edited) director text wins when present.
    const stored = this.prependText().trim();
    if (stored) return stored;
    const characters = this.elaborateCharacters();
    // Topic-scoped prompt versions apply to the current chat's topic.
    const chatId = this.chatService.currentChatId();
    const chat = chatId ? this.chatService.chats().find(c => c.id === chatId) ?? null : null;
    const project = chat?.projectId
      ? this.projectService.getProject(chat.projectId) ?? null
      : null;
    const topicId = this.projectService
      .topicForProject(project?.id, this.projectService.topics())?.id ?? null;
    return characters
      ? this.promptDefaults.render('structure.prepend', { characters }, topicId)
      : this.promptDefaults.render('structure.prepend-basic', {}, topicId);
  }



  /**
   * The concatenated FULL text of the assistant nodes that FOLLOW the current
   * node on the active path (the chapters after the direction being prepended).
   * Whole chapters are kept (never split); walking from the current node
   * forward, chapters are appended until the aggregate token estimate exceeds
   * `PREPEND_MAX_TOKENS` — the remaining (newest) chapters are left out.
   * Returns '' when there is nothing following.
   */
  private followingAssistantContent(nodeId: string): string {
    const path: ChatNode[] = this.chatService.getActivePath();
    const start = path.findIndex(n => n.id === nodeId);
    if (start < 0) return '';

    const parts: string[] = [];
    let tokens = 0;
    // Walk the active path AFTER the node; keep only complete assistant
    // chapters, newest-first append until the cap is exceeded.
    for (let i = start + 1; i < path.length; i++) {
      const n = path[i];
      if (n.role !== 'assistant') continue;
      const text = (n.content || '').trim();
      if (!text) continue;
      const t = estimateContentTokens(text);
      if (parts.length > 0 && tokens + t > PREPEND_MAX_TOKENS) break;
      parts.push(text);
      tokens += t;
    }
    return parts.join('\n\n');
  }
}

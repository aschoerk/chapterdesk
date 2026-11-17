/**
 * chat-marks.service.ts
 *
 * The chat page's persistent reading-marks handling, extracted from
 * ChatComponent: the marks-panel rows (preview / chapter label), jumping to /
 * reading from a mark, editing / deleting / clearing marks, and Ctrl+M
 * (mark the current position or selection). It also owns the DOM helpers that
 * resolve the section a mark/selection belongs to.
 *
 * DOM-bound pieces stay on the page and are reached through a `ChatMarksHost`
 * (the rendered chat-node components, the visible-node signal, the active
 * path, the tree scroller, and the marks-panel open state). The page keeps
 * thin delegates for every public member, so the template and the specs are
 * unchanged.
 */
import { Injectable, inject } from '@angular/core';
import { ChatNode, ReadingMark } from '../../models/chat';
import { ChatService } from './chat.service';
import { ReadingMarksService } from './reading-marks.service';
import { MarkNoteDialogService } from '../dialogs/mark-note-dialog.service';
import { ConfirmService } from '../dialogs/confirm.service';
import { ToastService } from '../toast/toast.service';
import { I18nService } from '../i18n/i18n.service';
import { ChatPacedReadService } from './chat-paced-read.service';
import type { ChatNodeComponent } from '../../components/chat-node/chat-node.component';

/** What the chat-page marks handling needs from the page. */
export interface ChatMarksHost {
  /** Rendered chat-node components — to find the section a mark belongs to. */
  nodeComps(): ChatNodeComponent[];
  /** Node whose block sits nearest the top of the tree. */
  visibleNodeId(): string | null;
  /** Active-path nodes (for the "chapter 3"-ish mark labels). */
  getActivePath(): ChatNode[];
  /** Deepest node on the active branch (fallback marks target). */
  getCurrentLeaf(): ChatNode | null;
  /** Scroll the tree to a node (fallback when a mark's text is gone). */
  scrollToNode(nodeId: string): void;
  /** Open/close the marks panel (clearMarks closes it). */
  setShowMarks(open: boolean): void;
}

/**
 * Component-scoped (one instance per chat page). The page binds itself as the
 * host in its constructor, exactly like the other extracted chat-page services.
 */
@Injectable()
export class ChatMarksService {
  private readonly readingMarks = inject(ReadingMarksService);
  private readonly chatService = inject(ChatService);
  private readonly markNoteDialog = inject(MarkNoteDialogService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly chatPacedRead = inject(ChatPacedReadService);

  private host: ChatMarksHost | null = null;

  /** Wire the page that owns the DOM. Called once from the constructor. */
  bind(host: ChatMarksHost): void {
    this.host = host;
  }

  /** One-line description of a mark for the panel (quote or position excerpt). */
  markPreview(mark: ReadingMark): string {
    return this.readingMarks.label(mark, this.chatService.currentNodes());
  }

  /** "chapter 3"-ish reference of the node a mark belongs to. */
  markNodeLabel(mark: ReadingMark): string {
    const path = this.host?.getActivePath() ?? [];
    const idx = path.findIndex(n => n.id === mark.nodeId);
    if (idx < 0) return this.i18n.t('chat.marksOrphan');
    const n = path[idx];
    const role = n.role === 'user' ? this.i18n.t('node.roleUser') : this.i18n.t('node.roleAssistant');
    return `${role} ${idx + 1}`;
  }

  /**
   * Go to a mark: scroll to its EXACT spot inside the section and re-select
   * the marked text (it looks selected again and can be copied). Falls back to
   * scrolling the section into view when the text is no longer there (the
   * section was edited after the mark was set).
   */
  jumpToMark(mark: ReadingMark): void {
    const comp = this.host?.nodeComps().find(c => c.node().id === mark.nodeId) ?? null;
    // revealMark centres the exact line itself — scrolling the section first
    // would fight its own scroll (both move the same scroller).
    if (comp?.revealMark(mark)) return;
    this.host?.scrollToNode(mark.nodeId);
    if (mark.quote?.trim()) {
      // The mark was a text selection but that text is gone (edited section).
      this.toast.info(this.i18n.t('chat.marksGone'));
    }
  }

  /**
   * Read from a mark. When a read is already running/paused it RELOCATES to
   * the mark (keeping the paused state) instead of stopping the session — the
   * panel is how you pick the next spot while the reading is paused. Delegate
   * to `ChatPacedReadService`.
   */
  readFromMark(mark: ReadingMark): void {
    this.chatPacedRead.readFromMark(mark);
  }

  async deleteMark(mark: ReadingMark): Promise<void> {
    await this.readingMarks.remove(mark.id);
  }

  /** Edit a mark's notice in the modal (Cancel keeps the old notice). */
  async editMarkNote(mark: ReadingMark): Promise<void> {
    const note = await this.markNoteDialog.open({
      note: mark.note ?? '',
      quote: mark.quote ?? '',
      isPosition: this.readingMarks.isPosition(mark)
    });
    if (note == null) return;
    await this.readingMarks.setNote(mark.id, note);
  }

  /**
   * Ctrl+M — mark the current position (or the marked text) with a notice.
   * Works on the section that owns the text selection, else on the section at
   * the top of the view.
   */
  markAtCursor(): void {
    const node = this.nodeComponentAtSelection() ?? this.visibleNodeComponent();
    if (!node) return;
    if (node.hasContentSelection()) void node.markSelection();
    else void node.markPosition();
  }

  /** The rendered node component whose content contains the DOM selection. */
  private nodeComponentAtSelection(): ChatNodeComponent | null {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    // `viewChildren` yields component instances; the owning section is found
    // through the `data-node-id` wrapper of the selected text.
    const id = this.nodeIdOfDomNode(selection.anchorNode)
      ?? this.nodeIdOfDomNode(selection.focusNode);
    if (!id) return null;
    return this.host?.nodeComps().find(c => c.node().id === id) ?? null;
  }

  /** The `data-node-id` of the chat-node element wrapping a DOM node. */
  private nodeIdOfDomNode(domNode: Node | null): string | null {
    if (!domNode) return null;
    const el = domNode.nodeType === Node.ELEMENT_NODE
      ? domNode as Element
      : domNode.parentElement;
    return el?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
  }

  /** The rendered node component of the section at the top of the view. */
  private visibleNodeComponent(): ChatNodeComponent | null {
    const id = this.host?.visibleNodeId() ?? this.host?.getCurrentLeaf()?.id ?? null;
    if (!id) return null;
    return this.host?.nodeComps().find(c => c.node().id === id) ?? this.host?.nodeComps()[0] ?? null;
  }

  async clearMarks(): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('chat.marksClearTitle'),
      message: this.i18n.t('chat.marksClearMsg', { count: this.readingMarks.count() }),
      confirmLabel: this.i18n.t('chat.marksClear'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    await this.readingMarks.clear();
    this.host?.setShowMarks(false);
  }
}
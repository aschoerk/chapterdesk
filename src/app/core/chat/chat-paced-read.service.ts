/**
 * chat-paced-read.service.ts
 *
 * The chat page's paced-reading glue, extracted from ChatComponent:
 *
 *  - the `PacedReadHost` resume adapter (capture / restore of the reading
 *    position — lets Pause/Resume return to the chapter AND scroll offset the
 *    user left);
 *  - starting a read from the current view (Ctrl+R): the pending read
 *    position wins, then the open editor, then the section at the top of the
 *    view, falling back to the first chapter of the active path; pressing it
 *    while a run is active stops it;
 *  - building the chapter queue from a node's position on the active path;
 *  - reading from a mark: relocates a running/paused read, else defers the
 *    start position and starts a fresh read.
 *
 * DOM-bound pieces stay on the page and are reached through a
 * `ChatPacedReadHost` (the conversation tree scroller, the visible-node
 * signals, and the `positionedChatId` bookkeeping). The page keeps thin
 * delegates for every public member, so the template and the specs are
 * unchanged.
 */
import { Injectable, inject, ElementRef, type Signal, type WritableSignal } from '@angular/core';
import { ChatNode, ReadingMark } from '../../models/chat';
import { ChatService } from './chat.service';
import { NodeEditSession } from './node-edit-session';
import {
  PacedReadService,
  type PacedReadHost,
  type PacedReadResumePoint,
} from '../llm/paced-read.service';

/** What the chat-page paced-reading glue needs from the page. The component
 *  hands over its live view signals at bind time (they stay private on the
 *  page); the service reads them AND writes the visible-node signals, and
 *  owns the positioned-chat bookkeeping itself. */
export interface ChatPacedReadHost {
  /** The conversation tree scroller (.tree) — scroll capture/restore. */
  tree: Signal<ElementRef<HTMLElement> | undefined>;
  /** Active-path nodes (the chapter queue source). */
  getActivePath(): ChatNode[];
  /** Node whose block sits nearest the top of the tree (the service writes it). */
  visibleNodeId: WritableSignal<string | null>;
  /** All nodes whose blocks are currently visible in the tree viewport (the service writes it). */
  visibleNodeIds: WritableSignal<string[]>;
}

/**
 * Component-scoped (one instance per chat page). The page binds itself as the
 * host in its constructor and registers/unregisters the resume host exactly
 * like the previous inline wiring, so pause/resume keeps working unchanged.
 */
@Injectable()
export class ChatPacedReadService {
  private readonly pacedRead = inject(PacedReadService);
  private readonly chatService = inject(ChatService);
  private readonly editSession = inject(NodeEditSession);

  private host: ChatPacedReadHost | null = null;

  /** Which chat the tree is currently positioned for (scroll bookkeeping). */
  private positionedChatId: string | null = null;

  /** Wire the page that owns the DOM. Called once from the constructor. */
  bind(host: ChatPacedReadHost): void {
    this.host = host;
  }

  /** Record which chat the tree is currently positioned for. */
  setPositionedChatId(chatId: string | null): void {
    this.positionedChatId = chatId;
  }

  /** True when the tree is currently positioned for `chatId`. */
  isPositionedFor(chatId: string | null): boolean {
    return this.positionedChatId === chatId;
  }

  /** Register the chat page's resume host (constructor). */
  registerHost(): void {
    this.pacedRead.registerHost(this.hostAdapter);
  }

  /** Unregister the resume host (ngOnDestroy). */
  unregisterHost(): void {
    this.pacedRead.unregisterHost(this.hostAdapter);
  }

  /**
   * The resume host PacedReadService knows about: capture the reading place
   * (chat + current chapter + tree scroll offset), restore it by putting the
   * revealed chapter at the top of the scroller (fallback = recorded offset).
   */
  private readonly hostAdapter: PacedReadHost = {
    view: 'chat',
    capture: (): PacedReadResumePoint => {
      const tree = this.host?.tree()?.nativeElement;
      return {
        view: 'chat',
        chatId: this.chatService.currentChatId(),
        nodeId: this.pacedRead.currentKey(),
        scrollTop: tree?.scrollTop ?? 0
      };
    },
    restore: (point: PacedReadResumePoint) => this.restorePacedPosition(point)
  };

  /**
   * Put the message tree back where the pacing was interrupted: the revealed
   * chapter at the top of the view, follow re-armed so the reveal continues
   * visibly. Falls back to the recorded scroll offset when the node is not
   * rendered (e.g. it left the active path).
   */
  private restorePacedPosition(point: PacedReadResumePoint): void {
    const apply = () => {
      const tree = this.host?.tree()?.nativeElement;
      if (!tree) return;
      const el = point.nodeId
        ? tree.querySelector(`[data-node-id="${point.nodeId}"]`) as HTMLElement | null
        : null;
      if (el) {
        const delta = el.getBoundingClientRect().top - tree.getBoundingClientRect().top;
        tree.scrollTop = Math.max(0, tree.scrollTop + delta - 8);
      } else {
        tree.scrollTop = point.scrollTop ?? 0;
      }
      this.setPositionedChatId(point.chatId);
      this.host?.visibleNodeId.set(point.nodeId ?? null);
      this.host?.visibleNodeIds.set(point.nodeId ? [point.nodeId] : []);
    };
    // The tree may still be rendering right after a chat switch.
    apply();
    queueMicrotask(apply);
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  /**
   * Ctrl+R — reveal the chat at reading pace WITHOUT calling the LLM, starting
   * at the section currently at the top of the view (or in the open editor),
   * falling back to the first chapter of the active path. Pressing it while a
   * run is active stops it.
   */
  startPacedReadFromView(): void {
    if (this.pacedRead.active()) {
      this.pacedRead.stop();
      return;
    }
    const path = this.host?.getActivePath() ?? [];
    if (!path.length) return;

    // A "next read position" set from a chapter's context menu wins over the
    // section at the top of the view.
    const anchorId = this.pacedRead.pendingStart()?.nodeId
      ?? this.editSession.editingNodeId()
      ?? this.host?.visibleNodeId() ?? null;
    let startIdx = anchorId ? path.findIndex(n => n.id === anchorId) : -1;
    if (startIdx < 0) {
      startIdx = path.findIndex(n => n.role === 'assistant' && !!n.content?.trim());
    }
    if (startIdx < 0) return;

    const items = this.pacedReadItemsFrom(path[startIdx].id);
    if (!items.length) return;
    void this.pacedRead.start(items);
  }

  /**
   * Read from a mark. When a read is already running/paused it RELOCATES to
   * the mark (keeping the paused state) instead of stopping the session — the
   * panel is how you pick the next spot while the reading is paused.
   */
  readFromMark(mark: ReadingMark): void {
    if (this.pacedRead.active()) {
      void this.pacedRead.relocate(this.pacedReadItemsFrom(mark.nodeId), mark.nodeId, mark.start);
      return;
    }
    this.pacedRead.setNextReadPosition(mark.nodeId, mark.start);
    this.startPacedReadFromView();
  }

  /** Chapters to reveal when reading starts at `nodeId` (it + the followers). */
  private pacedReadItemsFrom(nodeId: string): { key: string; text: string }[] {
    const path = this.host?.getActivePath() ?? [];
    const idx = path.findIndex(n => n.id === nodeId);
    const from = idx >= 0 ? path.slice(idx) : [];
    return from
      .filter(n => n.role === 'assistant' && (n.content ?? '').trim().length > 0)
      .map(n => ({ key: n.id, text: n.content ?? '' }));
  }

  /**
   * Keyboard handling for the pacing features, called from the page's `onKey`
   * AFTER the page's own Escape/menu handling and the `isTyping` guard.
   *
   * Owns:
   *  - Ctrl+R — start/stop the read. Ctrl+R is also the browser/Electron
   *    RELOAD shortcut, so it must be prevented here.
   *  - while a read runs: ←/→ = repeat / skip one second's pensum, ↑/↓ = one
   *    line back/forward, Space or P = interrupt/resume, Escape = stop.
   *
   * Returns true when the event was consumed — the page must not process it
   * further.
   */
  onKey(event: KeyboardEvent): boolean {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && (event.key === 'r' || event.key === 'R')) {
      event.preventDefault();
      this.startPacedReadFromView();
      return true;
    }
    if (!this.pacedRead.active()) return false;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        this.pacedRead.skipSeconds(-1);
        return true;
      case 'ArrowRight':
        event.preventDefault();
        this.pacedRead.skipSeconds(1);
        return true;
      case 'ArrowUp':
        event.preventDefault();
        this.pacedRead.skipLines(-1);
        return true;
      case 'ArrowDown':
        event.preventDefault();
        this.pacedRead.skipLines(1);
        return true;
      case ' ':
      case 'p':
      case 'P':
        // Space or P — interrupt / resume the pacing.
        event.preventDefault();
        this.pacedRead.toggle();
        return true;
      case 'Escape':
        event.preventDefault();
        this.pacedRead.stop();
        return true;
    }
    return false;
  }
}

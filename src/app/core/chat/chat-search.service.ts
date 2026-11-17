/**
 * chat-search.service.ts
 *
 * The chat page's search/replace + "Replace names" + "Name lists" glue,
 * extracted from ChatComponent. It owns the `SearchReplaceSession` adapter
 * that connects the shared search dialog to the chat's node tree (scopes:
 * node / chat), the navigation + highlighting of a search or name occurrence,
 * and the open/apply wiring of the two name dialogs.
 *
 * DOM-bound pieces stay on the page and are reached through a `ChatSearchHost`
 * (the conversation tree scroller, the rendered chat-node components, the chat
 * records, and the spec-spied `measureSearchCaret` mirror measurement). The
 * page keeps thin delegates for every public member, so the template and the
 * specs are unchanged.
 */
import { Injectable, inject, ElementRef } from '@angular/core';
import { Chat, ChatNode } from '../../models/chat';
import { ChatService } from './chat.service';
import { NodeEditSession } from './node-edit-session';
import { SearchReplaceService, SearchReplaceSession } from '../search-replace/search-replace.service';
import { highlightMatchesIn } from '../search-replace/search-utils';
import { TextareaCharMetrics } from '../util/dom-metrics';
import { NameReplaceDialogService } from '../dialogs/name-replace-dialog.service';
import { NameListDialogService } from '../dialogs/name-list-dialog.service';
import { ToastService } from '../toast/toast.service';
import { I18nService } from '../i18n/i18n.service';
import type { NameTextUnit, NameOccurrence } from '../names/name-replace';
import type { ChatNodeComponent } from '../../components/chat-node/chat-node.component';

/** What the chat-page search glue needs from the page. */
export interface ChatSearchHost {
  /** The conversation tree scroller (.tree) — outer scroll reveal. */
  tree(): ElementRef<HTMLElement> | undefined;
  /** Rendered chat-node components — to push a replacement into an open editor. */
  nodeComps(): ChatNodeComponent[];
  /** Active-path nodes (the "chat" search scope). */
  getActivePath(): ChatNode[];
  /** Deepest node on the active branch (fallback "node" scope target). */
  getCurrentLeaf(): ChatNode | null;
  /** Node whose block sits nearest the top of the tree. */
  visibleNodeId(): string | null;
  /** All chat records — to read the already-handled names. */
  chats(): Chat[];
  /** Mirror measurement of the caret in an editor textarea (spec-spied). */
  measureSearchCaret(ta: HTMLTextAreaElement, offset: number): TextareaCharMetrics | null;
}

/**
 * Component-scoped (one instance per chat page). The page binds itself as the
 * host in its constructor and registers/unregisters the search session on
 * init/destroy, exactly like the other extracted chat-page services.
 */
@Injectable()
export class ChatSearchService {
  private readonly chatService = inject(ChatService);
  private readonly editSession = inject(NodeEditSession);
  private readonly search = inject(SearchReplaceService);
  private readonly nameReplace = inject(NameReplaceDialogService);
  private readonly nameList = inject(NameListDialogService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  private host: ChatSearchHost | null = null;

  /** Wire the page that owns the DOM. Called once from the constructor. */
  bind(host: ChatSearchHost): void {
    this.host = host;
  }

  /** Adapter that turns the search dialog into a chat-page search. */
  private readonly searchSession: SearchReplaceSession = {
    scopes: () => [
      { id: 'node', labelKey: 'search.scope.node' },
      { id: 'chat', labelKey: 'search.scope.chat' },
    ],
    unitsFor: (scope) => this.searchUnits(scope),
    startUnitKey: (scope) => scope === 'chat' ? this.activeSearchNode()?.id ?? null : null,
    navigate: (occ) => this.searchNavigate(occ),
    apply: (updates) => this.searchApply(updates),
  };

  /** Register the page's search session (called from ngOnInit). */
  register(): void {
    this.search.setSession(this.searchSession);
  }

  /** Unregister the page's search session (called from ngOnDestroy). */
  unregister(): void {
    this.search.setSession(null);
  }

  /**
   * The searchable text units of a scope: `node` = the editing / visible /
   * leaf node, `chat` = every node on the active path.
   */
  searchUnits(
    scope: 'node' | 'chat' | 'reader',
  ): { key: string; text: string; role?: ChatNode['role'] }[] {
    if (scope === 'node') {
      const node = this.activeSearchNode();
      if (!node) return [];
      return [{ key: node.id, text: this.searchTextFor(node), role: node.role }];
    }
    // chat scope → all nodes on the active path
    return (this.host?.getActivePath() ?? [])
      .map((n) => ({ key: n.id, text: this.searchTextFor(n), role: n.role }))
      .filter((u) => u.text.length > 0);
  }

  /**
   * The text to search for a node. An open editor renders the LIVE draft in
   * its textarea, so use that (the committed `content` may lag behind the
   * draft by a character or a whole edit — searching it would shift every
   * match shown in the editor).
   */
  private searchTextFor(node: ChatNode): string {
    const state = this.editSession.state();
    return state?.nodeId === node.id ? state.draftText : (node.content ?? '');
  }

  /** The node the "node" scope searches against (editing / visible / leaf). */
  private activeSearchNode(): ChatNode | null {
    const editingId = this.editSession.editingNodeId();
    if (editingId) {
      const editing = this.chatService.currentNodes().find((n) => n.id === editingId);
      if (editing) return editing;
    }
    const visibleId = this.host?.visibleNodeId() ?? null;
    if (visibleId) {
      const visible = (this.host?.getActivePath() ?? []).find((n) => n.id === visibleId);
      if (visible) return visible;
    }
    return this.host?.getCurrentLeaf() ?? null;
  }

  private searchNavigate(occ: {
    unit: { key: string };
    match: { start: number; length: number };
    localNth: number;
  }): void {
    const el = document.querySelector(`[data-node-id="${occ.unit.key}"]`);
    if (!el) return;
    // An open editor shows a textarea — select the range there (offsets were
    // computed against the live draft). Otherwise highlight the rendered markdown.
    const ta = el.querySelector<HTMLTextAreaElement>('textarea.editor-textarea');
    if (ta) {
      // Bring the editor into view WITHOUT centering the whole (tall) card.
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Select BEFORE focusing: the browser then anchors the caret at the
      // match instead of dumping it at the end of the content.
      ta.setSelectionRange(occ.match.start, occ.match.start + occ.match.length);
      ta.focus();
      // Reveal the found position BOTH inside the textarea's own scroll region
      // (accurate even when lines wrap) AND in the outer conversation scroller
      // — the match may sit deep in a tall, wrapped node.
      this.revealSearchMatchInEditor(ta, occ.match.start);
      return;
    }
    // Not being edited → highlight the rendered markdown.
    (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    const content = el.querySelector<HTMLElement>('.node-content');
    if (content) {
      highlightMatchesIn(content, this.search.term(), this.search.options(), occ.localNth);
      content.querySelector('mark.sr-current')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /**
   * Reveal the caret (the found search match) so it is actually visible: first
   * inside the textarea's own scroll region — using a mirror measurement that
   * accounts for word-wrapping (`rowsBefore * lineHeight` is wrong for wrapped
   * lines and left matches invisible) — then in the outer conversation
   * scroller, so the match's line is on screen even when the textarea top was
   * already past the fold.
   */
  revealSearchMatchInEditor(ta: HTMLTextAreaElement, caretOffset: number): void {
    const metrics = this.host?.measureSearchCaret(ta, caretOffset) ?? null;
    if (!metrics) return; // nothing measurable (empty / no layout)
    const { contentTop, paddingTop, lineHeight } = metrics;
    // 1) Reveal inside the textarea: place the caret line one line-height from
    //    the top so a little preceding text stays visible.
    ta.scrollTop = Math.max(0, contentTop - lineHeight);
    // 2) Reveal in the conversation scroller: the caret's absolute line must be
    //    on screen (within a comfortable margin), otherwise a tall node hides
    //    the found position below the fold.
    const scroller = this.host?.tree()?.nativeElement;
    if (!scroller) return;
    const sRect = scroller.getBoundingClientRect();
    if (!sRect.width && !sRect.height) return; // no layout (jsdom)
    const tRect = ta.getBoundingClientRect();
    if (!tRect.width && !tRect.height) return;
    const MARGIN = 40;
    const caretY = tRect.top + paddingTop + (contentTop - ta.scrollTop);
    if (caretY < sRect.top + MARGIN) {
      scroller.scrollTop += caretY - (sRect.top + MARGIN);
    } else if (caretY > sRect.bottom - MARGIN) {
      scroller.scrollTop += caretY - (sRect.bottom - MARGIN);
    }
  }

  private async searchApply(updates: { key: string; text: string }[]): Promise<void> {
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    for (const u of updates) {
      await this.chatService.patchNode(chatId, u.key, { content: u.text });
      // An open editor renders the live draft — push the replacement into it
      // so the textarea stays in sync and subsequent matches keep their offsets.
      this.host?.nodeComps().find((c) => c.node().id === u.key)?.setDraftFromSearch(u.text);
    }
  }

  openSearch(): void {
    this.search.openDialog();
  }

  /**
   * Scroll to the chat node that contains ONE concrete occurrence of a name
   * and select/highlight exactly that occurrence — driven by the "Replace
   * names" dialog's per-name ◀/▶ navigation.
   */
  private nameNavigate(occ: NameOccurrence): void {
    const el = document.querySelector(`[data-node-id="${CSS.escape(occ.key)}"]`);
    if (!el) return;
    const ta = el.querySelector<HTMLTextAreaElement>('textarea.editor-textarea');
    if (ta) {
      // Editing: select the exact occurrence in the live draft.
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      ta.setSelectionRange(occ.start, occ.start + occ.length);
      ta.focus();
      this.revealSearchMatchInEditor(ta, occ.start);
      return;
    }
    // Rendered markdown: scroll to the node and highlight exactly this
    // occurrence (exact-case, whole-word).
    (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    const content = el.querySelector<HTMLElement>('.node-content');
    if (content) {
      highlightMatchesIn(
        content,
        occ.text,
        { caseSensitive: true, wholeWord: true, useRegex: false },
        occ.localNth,
      );
      content.querySelector('mark.sr-current')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /**
   * Open the "Replace names" dialog over the VISIBLE chat (the active path
   * nodes — the same scope as the search dialog's "In chat"). The dialog
   * finds names, proposes replacements and, on confirm, persists the updated
   * node contents through the same path as search replacements.
   */
  async openNameReplace(): Promise<void> {
    const units: NameTextUnit[] = this.searchUnits('chat');
    if (units.length === 0) {
      this.toast.info(this.i18n.t('nameReplace.noText'));
      return;
    }
    const chatId = this.chatService.currentChatId();
    if (!chatId) return;
    const chat = (this.host?.chats() ?? []).find((c) => c.id === chatId);
    const approved = await this.nameReplace.open({
      units,
      apply: async (updated) => {
        for (const u of updated) {
          await this.chatService.patchNode(chatId, u.key, { content: u.text });
          // An open editor renders the live draft — push the replacement into
          // it so the textarea stays in sync.
          this.host?.nodeComps().find((c) => c.node().id === u.key)?.setDraftFromSearch(u.text);
        }
      },
      navigate: (occ) => this.nameNavigate(occ),
      language: null,
      // Names already handled in THIS chat are hidden; the dialog can add and
      // remove them again (persisted on the chat record).
      handled: chat?.handledNames ?? [],
      saveHandled: async (names) => {
        await this.chatService.patchChatMeta(chatId, { handledNames: names });
      },
    });
    if (approved && approved.length > 0) {
      this.toast.success(this.i18n.t('nameReplace.applied', { count: approved.length }));
    }
  }

  /** Open the "Name lists" settings dialog. */
  async openNameList(): Promise<void> {
    const changed = await this.nameList.open({});
    if (changed) {
      this.toast.success(this.i18n.t('nameList.saved'));
    }
  }
}
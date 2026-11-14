import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatNode } from '../../models/chat';
import { ChatService } from './chat.service';
import { NodeClipboardService } from '../clipboard/node-clipboard.service';
import { I18nService } from '../i18n/i18n.service';

/** A row of a navbar context menu. */
export interface NavMenuEntry {
  label: string;
  hint?: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
  /** Renders a separator instead of a row (label/action are ignored). */
  divider?: boolean;
}

/**
 * What the menu needs from the chat page. The ACTIONS stay on the component —
 * they touch the selection, the tree and the reader, all of which the page
 * owns. The service only builds the rows and manages the two popovers.
 */
export interface ChatNavMenuHost {
  /** Visible navbar nodes, top-first. */
  navPath(): ChatNode[];
  navSelectedIds(): string[];
  navHasSelection(): boolean;
  toggleNavSelection(id: string): void;
  clearNavSelection(): void;
  startBranchAt(node: ChatNode): void | Promise<void>;
  switchNavSibling(node: ChatNode, dir: -1 | 1): void;
  copyNavNodes(node: ChatNode): void | Promise<void>;
  cutNavNodes(node: ChatNode): void | Promise<void>;
  deleteNavNodes(node: ChatNode): void | Promise<void>;
  pasteNavSelectionBefore(node: ChatNode): void | Promise<void>;
  pasteNavSelectionAfter(nodeId: string): void | Promise<void>;
  /** Splice / append the clipboard chain between the two visible nodes. */
  pasteChainInto(
    mode: 'insert' | 'append',
    leftId: string,
    rightId: string | null,
  ): void | Promise<void>;
}

/** Menu geometry, clamped into the viewport. */
const MENU_WIDTH = 260;
const PASTE_MENU_MAX_HEIGHT = 120;
const NODE_MENU_MAX_HEIGHT = 300;
const EDGE = 8;

/**
 * The two context menus of the node navbar:
 *
 *  - **paste menu** — right-click on a node's ⤵ button: Insert (splice into the
 *    visible chain) vs Append (parallel branch under the left node);
 *  - **node menu** — right-click on a nav node: branch here, switch
 *    continuation, select/unselect, copy/cut/delete, paste before/behind.
 *
 * Extracted from `ChatComponent` because it is pure menu plumbing — build the
 * rows from the node's state, place the popover, dispatch the action — while
 * the ACTIONS themselves stay on the page (they mutate the selection and open
 * dialogs). The component keeps thin delegates for every public member, so the
 * template and the specs are unchanged.
 *
 * Both menus are mutually exclusive: opening one closes the other.
 */
@Injectable()
export class ChatNavMenuService {
  private readonly chatService = inject(ChatService);
  private readonly clipboard = inject(NodeClipboardService);
  private readonly i18n = inject(I18nService);

  private host: ChatNavMenuHost | null = null;

  /** The two visible nodes around a paste button: { left = the node, right = the
   *  next visible one or null at the end }. Null when pasting is not allowed
   *  there. */
  readonly pasteTargets = (nodeId: string): { leftId: string; rightId: string | null } | null => {
    if (!this.clipboard.hasContent()) return null;
    const path = this.host?.navPath() ?? [];
    const i = path.findIndex(n => n.id === nodeId);
    if (i < 0) return null; // no longer a visible nav node
    const right = i + 1 < path.length ? path[i + 1] : null;
    // Nothing may be pasted LEFT of the empty direction node at the very end
    // of the path — the draft question stays the terminal input target.
    if (right && this.isLastEmptyDirection(right.id)) return null;
    return { leftId: nodeId, rightId: right?.id ?? null };
  };

  /** Open context menu of a paste button: { pointer position, left/right node }. */
  readonly navPasteMenu = signal<{
    x: number;
    y: number;
    leftId: string;
    rightId: string | null;
  } | null>(null);

  /** Right-clicked nav node for the inline context menu. */
  readonly navNodeMenu = signal<{ x: number; y: number; nodeId: string } | null>(null);

  /** True while either menu is open (the page skips key handling then). */
  readonly isOpen = computed(() => !!this.navPasteMenu() || !!this.navNodeMenu());

  /** Wire the page that owns the actions. Called once from the constructor. */
  bind(host: ChatNavMenuHost): void {
    this.host = host;
  }

  /** The empty "direction" node at the very end of the active path — the
   *  terminal draft the user types into. It can never be selected and nothing
   *  may be pasted to its left. */
  isLastEmptyDirection(nodeId: string): boolean {
    const last = this.chatService.getActivePath().at(-1);
    return !!last && last.id === nodeId && this.chatService.isDraftQuestion(last);
  }

  // ------------------------------------------------------------------
  // Paste menu (right-click on the ⤵ button)
  // ------------------------------------------------------------------

  openPasteMenu(event: MouseEvent, node: ChatNode): void {
    const targets = this.pasteTargets(node.id);
    if (!targets) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeNodeMenu();
    this.navPasteMenu.set({ x: event.clientX, y: event.clientY, ...targets });
  }

  closePasteMenu(): void {
    this.navPasteMenu.set(null);
  }

  pasteMenuLeftPx(): number {
    const m = this.navPasteMenu();
    if (!m) return 0;
    return Math.max(EDGE, Math.min(m.x, window.innerWidth - MENU_WIDTH - EDGE));
  }

  pasteMenuTopPx(): number {
    const m = this.navPasteMenu();
    if (!m) return 0;
    return Math.max(EDGE, Math.min(m.y, window.innerHeight - PASTE_MENU_MAX_HEIGHT - EDGE));
  }

  pasteMenuItems(menu: { leftId: string; rightId: string | null }): NavMenuEntry[] {
    return [
      {
        label: this.i18n.t('node.pasteInsert'),
        hint: this.i18n.t('node.pasteInsertTitle'),
        action: () => this.host?.pasteChainInto('insert', menu.leftId, menu.rightId),
      },
      {
        label: this.i18n.t('node.pasteAppend'),
        hint: this.i18n.t('node.pasteAppendTitle'),
        action: () => this.host?.pasteChainInto('append', menu.leftId, menu.rightId),
      },
    ];
  }

  runPasteAction(item: NavMenuEntry): void {
    this.closePasteMenu();
    void item.action();
  }

  // ------------------------------------------------------------------
  // Node menu (right-click on a nav node)
  // ------------------------------------------------------------------

  /** Open the node menu at the pointer position. The browser native menu is
   *  suppressed for nav nodes; the terminal empty direction gets no menu. */
  openNodeMenu(event: MouseEvent, node: ChatNode): void {
    if (this.isLastEmptyDirection(node.id)) return;
    event.preventDefault();
    event.stopPropagation();
    this.closePasteMenu();
    this.navNodeMenu.set({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }

  closeNodeMenu(): void {
    this.navNodeMenu.set(null);
  }

  nodeMenuLeftPx(): number {
    const m = this.navNodeMenu();
    if (!m) return 0;
    return Math.max(EDGE, Math.min(m.x, window.innerWidth - MENU_WIDTH - EDGE));
  }

  nodeMenuTopPx(): number {
    const m = this.navNodeMenu();
    if (!m) return 0;
    return Math.max(EDGE, Math.min(m.y, window.innerHeight - NODE_MENU_MAX_HEIGHT - EDGE));
  }

  /**
   * Build the rows for the right-clicked navbar node. Grouped:
   *  1. start a new branch here (empty direction leaf in parallel)
   *  2. switch the active continuation to a sibling (prev/next)
   *  3. selection (select/unselect this node, clear the selection)
   *  4. clipboard (copy / cut / delete — the whole selection when the node is
   *     part of one, otherwise just this node)
   *  5. paste in front / behind (insert into the active path)
   */
  nodeMenuItems(): NavMenuEntry[] {
    const menu = this.navNodeMenu();
    const host = this.host;
    if (!menu || !host) return [];
    const node = this.chatService.getActivePath().find(n => n.id === menu.nodeId);
    if (!node) return [];
    const busy = this.chatService.isGenerating(node.id);

    const groups: NavMenuEntry[][] = [];

    // Start a NEW branch NEXT TO the clicked node: an empty direction leaf with
    // the same parent, so the story forks in parallel right here.
    groups.push([
      {
        label: this.i18n.t('node.branchHere'),
        hint: this.i18n.t('node.branchHereTitle'),
        action: () => host.startBranchAt(node),
        disabled: busy,
      },
    ]);

    const siblings = this.chatService.getChildren(node.parentId);
    if (siblings.length > 1) {
      groups.push([
        {
          label: this.i18n.t('node.prevBranch'),
          hint: this.i18n.t('node.prevBranch'),
          action: () => host.switchNavSibling(node, -1),
          disabled: busy,
        },
        {
          label: this.i18n.t('node.nextBranch'),
          hint: this.i18n.t('node.nextBranch'),
          action: () => host.switchNavSibling(node, 1),
          disabled: busy,
        },
      ]);
    }

    const isSelected = host.navSelectedIds().includes(node.id);
    const selectionGroup: NavMenuEntry[] = [{
      label: this.i18n.t(isSelected ? 'node.navUnselect' : 'node.navSelect'),
      action: () => host.toggleNavSelection(node.id),
    }];
    if (host.navHasSelection()) {
      selectionGroup.push({
        label: this.i18n.t('node.clearSelection'),
        action: () => host.clearNavSelection(),
      });
    }
    groups.push(selectionGroup);

    groups.push([
      {
        label: this.i18n.t('node.copySelected'),
        hint: this.i18n.t('node.copySelectedTitle'),
        action: () => host.copyNavNodes(node),
      },
      {
        label: this.i18n.t('node.cutSelected'),
        hint: this.i18n.t('node.cutSelectedTitle'),
        action: () => host.cutNavNodes(node),
      },
      {
        label: this.i18n.t('node.deleteSelected'),
        hint: this.i18n.t('node.deleteSelectedTitle'),
        action: () => host.deleteNavNodes(node),
        danger: true,
      },
    ]);

    if (this.clipboard.hasContent()) {
      const before = this.pasteBeforeTargets(node);
      const after = this.pasteTargets(node.id);
      groups.push([
        {
          label: this.i18n.t('node.navPasteBefore'),
          hint: before ? this.i18n.t('node.pasteInsertTitle') : this.i18n.t('node.navPasteBeforeDisabled'),
          action: () => host.pasteNavSelectionBefore(node),
          disabled: !before,
        },
        {
          label: this.i18n.t('node.navPasteAfter'),
          hint: after ? this.i18n.t('node.pasteAfterTitle') : this.i18n.t('node.navPasteAfterDisabled'),
          action: () => host.pasteNavSelectionAfter(node.id),
          disabled: !after,
        },
      ]);
    }

    const out: NavMenuEntry[] = [];
    for (const group of groups) {
      if (!group.length) continue;
      if (out.length) out.push({ label: '', action: () => undefined, divider: true });
      out.push(...group);
    }
    return out;
  }

  /** Targets for pasting the clipboard IN FRONT OF `node`, or null when not
   *  possible — no predecessor (first visible node) or left of the terminal
   *  empty direction. */
  pasteBeforeTargets(node: ChatNode): { leftId: string; rightId: string | null } | null {
    if (!this.clipboard.hasContent()) return null;
    if (this.isLastEmptyDirection(node.id)) return null; // draft stays the terminal input
    const path = this.host?.navPath() ?? [];
    const i = path.findIndex(n => n.id === node.id);
    if (i <= 0) return null;
    return { leftId: path[i - 1].id, rightId: node.id };
  }

  /** Close the menu, then run the chosen action (if it is enabled). */
  runNodeAction(item: NavMenuEntry): void | Promise<void> {
    if (item.divider || item.disabled) return;
    this.closeNodeMenu();
    return item.action();
  }

  /** Dismiss both menus (viewport resize / scroll). */
  dismissAll(): void {
    this.closeNodeMenu();
    this.closePasteMenu();
  }
}

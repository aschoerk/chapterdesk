import { Injectable, inject, signal } from '@angular/core';
import { ChatService } from './chat.service';

/**
 * Persistent layout preferences of the chat page: the LEFT SIDEBAR width and
 * the PER-CHAT node-nav-bar height. Both are drag-resizable and remembered in
 * localStorage. Mirrors the small injectable state services
 * (AttachmentClipboardService / LightboxService) — the resize state and its
 * persistence used to live inside ChatComponent.
 */
@Injectable({ providedIn: 'root' })
export class ChatLayoutPrefsService {
  private static readonly LS_SIDEBAR_WIDTH = 'chat-client.sidebar.width';
  /** Initial sidebar width: wide enough to show ~15 characters of a chat
   *  title plus all chat-row icon buttons (rename, unassign, reassign,
   *  clone, delete) and the node count when chats are visible. */
  static readonly SIDEBAR_WIDTH_DEFAULT = 320;
  private static readonly SIDEBAR_WIDTH_MIN = 200;
  private static readonly SIDEBAR_WIDTH_MAX = 720;
  private static readonly NAV_BAR_HEIGHT_MIN = 40;
  private static readonly NAV_BAR_HEIGHT_MAX = 320;
  /** Per-chat storage prefix: `chat-client.navbar.height.<chatId>`. The
   *  vertical nav-bar size is a PER-CHAT preference — switching chats applies
   *  the new chat's size, so another chat's tall manual height never leaves
   *  empty lines in the bar of a short path. */
  private static readonly LS_NAV_BAR_HEIGHT_PREFIX = 'chat-client.navbar.height.';
  /** Legacy (pre-per-chat) key — one-time migration source. */
  private static readonly LS_NAV_BAR_HEIGHT_LEGACY = 'chat-client.navbar.height';

  private readonly chatService = inject(ChatService);

  /** Sidebar width (px) — global, remembered in localStorage. */
  readonly sidebarWidth = signal(this.loadSidebarWidth());
  readonly isResizing = signal(false);

  /** Explicit height (px) of the node-nav-bar for the CURRENT chat, or null =
   *  DEFAULT handling: content-sized, capped at 4 lines with a scrollbar, and
   *  auto-scrolled to the marked node's line. Re-applied on every chat switch. */
  readonly navBarHeight = signal<number | null>(null);
  readonly isNavResizing = signal(false);

  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private navResizeStartY = 0;
  private navResizeStartHeight = 0;
  /** Chat the nav-bar height was last applied for (undefined = not yet applied). */
  private navHeightChatId: string | null | undefined = undefined;

  // ------------------------------------------------------------------
  // Sidebar width (global, drag-resizable)
  // ------------------------------------------------------------------

  private readonly onSidebarResizePointerMove = (event: PointerEvent): void => {
    if (!this.isResizing()) return;
    event.preventDefault();
    const delta = event.clientX - this.resizeStartX;
    const max = Math.min(
      ChatLayoutPrefsService.SIDEBAR_WIDTH_MAX,
      Math.round(window.innerWidth * 0.6)
    );
    const next = Math.round(
      Math.min(
        Math.max(this.resizeStartWidth + delta, ChatLayoutPrefsService.SIDEBAR_WIDTH_MIN),
        max
      )
    );
    this.sidebarWidth.set(next);
  };

  private readonly onSidebarResizePointerUp = (): void => this.endSidebarResize();

  private loadSidebarWidth(): number {
    const n = Number(localStorage.getItem(ChatLayoutPrefsService.LS_SIDEBAR_WIDTH));
    if (!Number.isFinite(n)) return ChatLayoutPrefsService.SIDEBAR_WIDTH_DEFAULT;
    return Math.min(
      ChatLayoutPrefsService.SIDEBAR_WIDTH_MAX,
      Math.max(ChatLayoutPrefsService.SIDEBAR_WIDTH_MIN, n)
    );
  }

  startSidebarResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    this.isResizing.set(true);
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.sidebarWidth();

    document.body.classList.add('sidebar-resizing');
    document.addEventListener('pointermove', this.onSidebarResizePointerMove);
    document.addEventListener('pointerup', this.onSidebarResizePointerUp);
    document.addEventListener('pointercancel', this.onSidebarResizePointerUp);
  }

  endSidebarResize(): void {
    if (!this.isResizing()) return;
    this.isResizing.set(false);
    document.body.classList.remove('sidebar-resizing');
    document.removeEventListener('pointermove', this.onSidebarResizePointerMove);
    document.removeEventListener('pointerup', this.onSidebarResizePointerUp);
    document.removeEventListener('pointercancel', this.onSidebarResizePointerUp);
    localStorage.setItem(ChatLayoutPrefsService.LS_SIDEBAR_WIDTH, String(this.sidebarWidth()));
  }

  resetSidebarWidth(): void {
    this.sidebarWidth.set(ChatLayoutPrefsService.SIDEBAR_WIDTH_DEFAULT);
    localStorage.setItem(
      ChatLayoutPrefsService.LS_SIDEBAR_WIDTH,
      String(ChatLayoutPrefsService.SIDEBAR_WIDTH_DEFAULT)
    );
  }

  // ------------------------------------------------------------------
  // Node-nav-bar height (per-chat, drag-resizable)
  // ------------------------------------------------------------------

  private navBarHeightKey(chatId: string | null): string | null {
    return chatId ? `${ChatLayoutPrefsService.LS_NAV_BAR_HEIGHT_PREFIX}${chatId}` : null;
  }

  private loadNavBarHeight(chatId: string | null): number | null {
    // `getItem` returns null (→ Number(null) === 0) when never persisted —
    // distinguish "absent" from a stored 0 so auto-sizing stays the default.
    const key = this.navBarHeightKey(chatId);
    let raw: string | null = null;
    if (key) {
      raw = localStorage.getItem(key);
      // One-time migration from the old single global key (pre-per-chat).
      if (raw == null) raw = this.migrateLegacyNavBarHeight();
    }
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return this.clampNavHeight(n);
  }

  private migrateLegacyNavBarHeight(): string | null {
    const raw = localStorage.getItem(ChatLayoutPrefsService.LS_NAV_BAR_HEIGHT_LEGACY);
    if (raw != null) {
      try { localStorage.removeItem(ChatLayoutPrefsService.LS_NAV_BAR_HEIGHT_LEGACY); } catch { /* non-fatal */ }
    }
    return raw;
  }

  private clampNavHeight(h: number | null): number | null {
    if (h == null) return null;
    return Math.min(
      ChatLayoutPrefsService.NAV_BAR_HEIGHT_MAX,
      Math.max(ChatLayoutPrefsService.NAV_BAR_HEIGHT_MIN, Math.round(h))
    );
  }

  private readonly handleNavBarPointerMove = (event: PointerEvent): void => {
    if (!this.isNavResizing()) return;
    event.preventDefault();
    const delta = event.clientY - this.navResizeStartY;
    const next = Math.round(
      Math.min(
        Math.max(this.navResizeStartHeight + delta, ChatLayoutPrefsService.NAV_BAR_HEIGHT_MIN),
        ChatLayoutPrefsService.NAV_BAR_HEIGHT_MAX
      )
    );
    this.navBarHeight.set(next);
  };

  private readonly onNavResizePointerUp = (): void => this.endNavResize();

  /**
   * The nav-bar height is a PER-CHAT preference. On any chat switch, apply the
   * saved height for the new chat (or null = default when it was never
   * manually resized). Called from a reactive effect tracking the chat id.
   */
  applyChat(chatId: string | null): void {
    const applied = chatId ?? null;
    if (applied !== this.navHeightChatId) {
      this.navHeightChatId = applied;
      this.navBarHeight.set(chatId ? this.loadNavBarHeight(chatId) : null);
    }
  }

  /** Start a nav-bar drag; `base` is the currently rendered bar height (px). */
  startNavResize(event: PointerEvent, base: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    this.isNavResizing.set(true);
    this.navResizeStartY = event.clientY;
    this.navResizeStartHeight = base;

    document.body.classList.add('nav-resizing');
    document.addEventListener('pointermove', this.handleNavBarPointerMove);
    document.addEventListener('pointerup', this.onNavResizePointerUp);
    document.addEventListener('pointercancel', this.onNavResizePointerUp);
  }

  /** Handle a nav-bar pointer move (drives the drag while it is active). */
  onNavResizePointerMove(event: { clientY: number; preventDefault: () => void }): void {
    this.handleNavBarPointerMove(event as PointerEvent);
  }

  endNavResize(): void {
    if (!this.isNavResizing()) return;
    this.isNavResizing.set(false);
    document.body.classList.remove('nav-resizing');
    document.removeEventListener('pointermove', this.handleNavBarPointerMove);
    document.removeEventListener('pointerup', this.onNavResizePointerUp);
    document.removeEventListener('pointercancel', this.onNavResizePointerUp);
    const h = this.navBarHeight();
    const key = h != null
      ? this.navBarHeightKey(this.chatService.currentChatId())
      : null;
    if (key) {
      try { localStorage.setItem(key, String(h)); } catch { /* non-fatal */ }
    }
  }

  /** Double-click on the separator → restore the DEFAULT handling for the
   *  current chat (auto height: content-sized, max 4 lines, scroll to marked). */
  resetNavBarHeight(): void {
    this.navBarHeight.set(null);
    this.isNavResizing.set(false);
    document.body.classList.remove('nav-resizing');
    document.removeEventListener('pointermove', this.handleNavBarPointerMove);
    document.removeEventListener('pointerup', this.onNavResizePointerUp);
    document.removeEventListener('pointercancel', this.onNavResizePointerUp);
    const key = this.navBarHeightKey(this.chatService.currentChatId());
    if (key) {
      try { localStorage.removeItem(key); } catch { /* non-fatal */ }
    }
  }
}
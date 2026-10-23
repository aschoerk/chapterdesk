/**
 * context-menu.ts
 *
 * Pure builder for the chat-node right-click (context) menu. The component
 * supplies the node, its current state (busy / loading / which actions are
 * available) and the action callbacks; a plain module function assembles the
 * grouped `CtxMenuItem` rows — the big role/state switch that used to live
 * inline in `ChatNodeComponent`.
 *
 * Kept as module functions (like the shared `dom-metrics.ts`) so the menu
 * logic is testable without mounting the component.
 */
import type { ChatNode } from '../../models/chat';

/** A single command shown in the node right-click (context) menu. */
export interface CtxMenuItem {
  /** Translated display text. */
  label: string;
  /** Invoked when the item is chosen (the menu closes first). */
  action: () => void;
  /** Destructive styling (remove / delete). */
  danger?: boolean;
  /** Shown greyed-out and not clickable. */
  disabled?: boolean;
  /** Separator row, not an action. */
  divider?: boolean;
}

/** Everything `buildCtxMenuItems` needs from the component — data + callbacks. */
export interface CtxMenuContext {
  /** The node the menu was opened on. */
  node: ChatNode;
  /** True while a generation/operation runs on the node (disables most actions). */
  busy: boolean;
  /** True while the editor itself is busy (Continue / Switch / … disables). */
  loading: boolean;
  /** Only offered on assistant chapters that have text to depict. */
  canIllustrate: boolean;
  /** Empty unsent leaf question with the inline editor closed. */
  showClosedContinue: boolean;
  /** The terminal pending direction node — never gets Prepend. */
  isUnsentQuestion: boolean;
  /** The node has prior versions to show. */
  hasPriorVersions: boolean;
  /** Translation function (`I18nService.t`). */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Action callbacks — each closes the menu first (see `runCtxAction`). */
  actions: {
    copy: () => void;
    edit: () => void;
    rewrite: () => void;
    togglePriorVersions: () => void;
    toggleExclude: () => void;
    heading: () => void;
    regenerate: () => void;
    regenerateInPlace: () => void;
    illustrate: () => void;
    createImage: () => void;
    continueDraft: () => void;
    switchCharacters: () => void;
    chapterDescriptions: () => void;
    prepend: () => void;
    remove: () => void;
    delete: () => void;
  };
}

/** Build the menu rows for the given node (role- and state-aware). */
export function buildCtxMenuItems(ctx: CtxMenuContext): CtxMenuItem[] {
  const n = ctx.node;

  // Common: every node can be copied / edited.
  const common: CtxMenuItem[] = [
    { label: ctx.t('node.ctxCopy'), action: () => ctx.actions.copy() },
    { label: ctx.t('node.ctxEdit'), action: () => ctx.actions.edit() }
  ];
  if (n.content?.trim()) {
    common.push({
      label: ctx.t('node.ctxRewriteSelection'),
      action: () => ctx.actions.rewrite()
    });
  }
  if (ctx.hasPriorVersions) {
    common.push({
      label: ctx.t('node.ctxPriorVersions'),
      action: () => ctx.actions.togglePriorVersions()
    });
  }

  // Role-specific actions — mirror the toolbar buttons' availability.
  const roleItems: CtxMenuItem[] = [];
  if (n.role === 'user' || n.role === 'system') {
    roleItems.push({
      label: (n.excludeFromContext ? '✓ ' : '') + ctx.t('node.ctxExcludeFromContext'),
      action: () => ctx.actions.toggleExclude(),
      disabled: ctx.busy
    });
  }
  if (n.role === 'assistant') {
    roleItems.push(
      { label: ctx.t('node.ctxHeading'), action: () => ctx.actions.heading(), disabled: ctx.busy },
      { label: ctx.t('node.ctxRegenerate'), action: () => ctx.actions.regenerate(), disabled: ctx.busy },
      { label: ctx.t('node.ctxRegenerateInPlace'), action: () => ctx.actions.regenerateInPlace(), disabled: ctx.busy },
      { label: ctx.t('node.ctxIllustrate'), action: () => ctx.actions.illustrate(), disabled: ctx.busy || !ctx.canIllustrate },
      { label: ctx.t('node.ctxCreateImage'), action: () => ctx.actions.createImage(), disabled: ctx.busy || !n.content?.trim() }
    );
  } else if (n.role === 'user') {
    if (ctx.showClosedContinue) {
      roleItems.push({
        label: ctx.t('node.ctxContinue'),
        action: () => ctx.actions.continueDraft(),
        disabled: ctx.loading
      });
      roleItems.push({
        label: ctx.t('node.ctxSwitchCharacters'),
        action: () => ctx.actions.switchCharacters(),
        disabled: ctx.loading
      });
    }
    roleItems.push({
      label: ctx.t('node.ctxChapterDescriptions'),
      action: () => ctx.actions.chapterDescriptions(),
      disabled: ctx.loading
    });
    if (!ctx.isUnsentQuestion) {
      roleItems.push({
        label: ctx.t('node.ctxPrepend'),
        action: () => ctx.actions.prepend(),
        disabled: ctx.loading
      });
    }
  }

  // Destructive actions, always last.
  const dangerItems: CtxMenuItem[] = [
    { label: ctx.t('node.ctxRemove'), action: () => ctx.actions.remove(), danger: true, disabled: ctx.busy },
    { label: ctx.t('node.ctxDelete'), action: () => ctx.actions.delete(), danger: true, disabled: ctx.busy }
  ];

  const result: CtxMenuItem[] = [];
  const pushGroup = (items: CtxMenuItem[]) => {
    if (!items.length) return;
    if (result.length) {
      result.push({ label: '', action: () => undefined, divider: true });
    }
    result.push(...items);
  };
  pushGroup(common);
  pushGroup(roleItems);
  pushGroup(dangerItems);
  return result;
}
import { describe, it, expect, vi } from 'vitest';
import { buildCtxMenuItems, type CtxMenuContext } from './context-menu';
import { makeNode } from '../../../../test-helpers/factories';

/** Minimal label map mirroring the real i18n strings used by the host spec. */
const LABELS: Record<string, string> = {
  'node.ctxCopy': 'Copy',
  'node.ctxEdit': 'Edit',
  'node.ctxRewriteSelection': 'Rewrite selection…',
  'node.ctxPriorVersions': 'Prior versions',
  'node.ctxCompareVersions': 'Compare versions…',
  'node.ctxCompareSiblings': 'Compare siblings…',
  'node.ctxExcludeFromContext': 'Exclude from context',
  'node.ctxHeading': 'Add heading',
  'node.ctxRegenerate': 'Regenerate',
  'node.ctxRegenerateInPlace': 'Rewrite in place',
  'node.ctxIllustrate': 'Illustrate',
  'node.ctxCreateImage': 'Create image of selection…',
  'node.ctxContinue': 'Continue',
  'node.ctxSwitchCharacters': 'Switch characters',
  'node.ctxChapterDescriptions': 'Chapter descriptions',
  'node.ctxPrepend': 'Prepend director',
  'node.ctxSetReadPosition': 'Set next read position here',
  'node.ctxClearReadPosition': 'Clear next read position',
  'node.ctxMarkPosition': 'Mark this position (notice)',
  'node.ctxMarkSelection': 'Add notice to the marked text',
  'node.ctxRemove': 'Remove section',
  'node.ctxDelete': 'Delete section & following',
};
const t = (key: string): string => LABELS[key] ?? key;

function ctx(
  overrides: Partial<
    Pick<CtxMenuContext, 'node' | 'busy' | 'loading' | 'canIllustrate' | 'showClosedContinue' | 'isUnsentQuestion' | 'hasPriorVersions' | 'hasComparableSiblings' | 'hasReadPosition' | 'canMarkSelection'>
  > = {}
): CtxMenuContext {
  const noop = () => undefined;
  const actions: CtxMenuContext['actions'] = {
    copy: noop, edit: noop, rewrite: noop, togglePriorVersions: noop,
    compareVersions: noop, compareSiblings: noop,
    toggleExclude: noop, heading: noop, regenerate: noop, regenerateInPlace: noop,
    illustrate: noop, createImage: noop, continueDraft: noop, switchCharacters: noop,
    chapterDescriptions: noop, prepend: noop, setReadPosition: noop,
    clearReadPosition: noop, markPosition: noop, markSelection: noop,
    remove: noop, delete: noop,
  };
  return {
    node: makeNode({ role: 'assistant', content: 'Chapter' }),
    busy: false,
    loading: false,
    canIllustrate: false,
    showClosedContinue: false,
    isUnsentQuestion: false,
    hasPriorVersions: false,
    hasComparableSiblings: false,
    hasReadPosition: false,
    canMarkSelection: false,
    notEditing: true,
    t,
    actions,
    ...overrides,
  };
}

const labels = (items: ReturnType<typeof buildCtxMenuItems>) =>
  items.filter(i => !i.divider).map(i => i.label);

describe('buildCtxMenuItems (chat-node context menu)', () => {
  it('offers the reading-mark commands (position always, selection only while text is marked)', () => {
    const none = buildCtxMenuItems(ctx({ node: makeNode({ role: 'assistant', content: 'Chapter' }) }));
    expect(labels(none)).toContain('Mark this position (notice)');
    // Nothing selected → the selection entry is present but disabled.
    expect(none.find(i => i.label === 'Add notice to the marked text')?.disabled).toBe(true);

    const selected = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'assistant', content: 'Chapter' }),
      canMarkSelection: true,
    }));
    expect(selected.find(i => i.label === 'Add notice to the marked text')?.disabled).toBe(false);
  });

  it('offers "set next read position" for a chapter, plus clear when one is set', () => {
    const none = buildCtxMenuItems(ctx({ node: makeNode({ role: 'assistant', content: 'Chapter' }) }));
    expect(labels(none)).toContain('Set next read position here');
    expect(labels(none)).not.toContain('Clear next read position');

    const pending = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'assistant', content: 'Chapter' }),
      hasReadPosition: true,
    }));
    expect(labels(pending)).toContain('Clear next read position');

    // Nothing to read on an empty node → no read-position entry at all.
    const empty = buildCtxMenuItems(ctx({ node: makeNode({ role: 'assistant', content: '  ' }) }));
    expect(labels(empty)).not.toContain('Set next read position here');
  });

  it('lists common + destructive actions for a structure node', () => {
    const items = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'structural', content: '' }),
    }));
    expect(labels(items)).toEqual([
      'Copy', 'Edit', 'Remove section', 'Delete section & following',
    ]);
    expect(items.filter(i => i.divider).length).toBe(1);
  });

  it('lists the assistant actions grouped with separators', () => {
    const items = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'assistant', content: 'Chapter' }),
      hasPriorVersions: true,
      hasComparableSiblings: true,
      canIllustrate: true,
    }));
    expect(labels(items)).toEqual([
      'Copy', 'Edit', 'Rewrite selection…', 'Prior versions', 'Compare versions…', 'Compare siblings…',
      'Add heading', 'Regenerate', 'Rewrite in place', 'Illustrate', 'Create image of selection…',
      'Set next read position here', 'Mark this position (notice)', 'Add notice to the marked text',
      'Remove section', 'Delete section & following',
    ]);
    expect(items.filter(i => i.divider).length).toBe(3);
    expect(items.find(i => i.label === 'Regenerate')?.disabled).toBe(false);
    expect(items.find(i => i.label === 'Compare versions…')?.disabled).toBe(false);
    expect(items.find(i => i.label === 'Compare siblings…')?.disabled).toBe(false);
  });

  it('disables the role + destructive actions while busy (copy/edit stay enabled)', () => {
    const items = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'assistant', content: 'Chapter' }),
      busy: true,
      canIllustrate: true,
    }));
    // The generic copy/edit never blocks while busy (no `disabled` flag).
    expect(items.find(i => i.label === 'Copy')?.disabled).not.toBe(true);
    expect(items.find(i => i.label === 'Edit')?.disabled).not.toBe(true);
    // Role + destructive actions are all greyed out.
    for (const label of ['Add heading', 'Regenerate', 'Rewrite in place', 'Illustrate', 'Create image of selection…', 'Remove section', 'Delete section & following']) {
      expect(items.find(i => i.label === label)?.disabled, label).toBe(true);
    }
  });

  it('gives an unsent question Continue + Switch characters and no Prepend', () => {
    const items = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'user', content: '' }),
      showClosedContinue: true,
      isUnsentQuestion: true,
    }));
    const labels_ = labels(items);
    expect(labels_).toContain('Continue');
    expect(labels_).toContain('Switch characters');
    expect(labels_).not.toContain('Prepend director');
  });

  it('gives a sent question Prepend and no Continue / Switch characters', () => {
    const items = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'user', content: 'Sent' }),
      showClosedContinue: false,
      isUnsentQuestion: false,
    }));
    const labels_ = labels(items);
    expect(labels_).toContain('Prepend director');
    expect(labels_).not.toContain('Continue');
    expect(labels_).not.toContain('Switch characters');
  });

  it('marks an excluded user node with the ✓ prefix', () => {
    const items = buildCtxMenuItems(ctx({
      node: makeNode({ role: 'user', content: 'x', excludeFromContext: true }),
    }));
    expect(labels(items)).toContain('✓ Exclude from context');
  });

  it('wires the item actions to the supplied callbacks', () => {
    const copy = vi.fn();
    const items = buildCtxMenuItems(ctx({ actions: { copy } } as unknown as CtxMenuContext));
    const copyItem = items.find(i => i.label === 'Copy')!;
    copyItem.action();
    expect(copy).toHaveBeenCalled();
  });
});
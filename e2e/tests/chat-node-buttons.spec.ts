// ---------------------------------------------------------------------------
// CHAT-NODE BUTTONS — every on-card control inside the story tree:
//
//   TOP (`.node-header`):  branch-switcher (prev / “x / y” / next — only when
//                          the node has siblings), “Heading” (chapter only),
//                          “Remove Section”, “Delete Continuation”.
//   BOTTOM (`.node-actions`): role-aware actions — chapter: Regenerate,
//                          Rewrite in place, Illustrate, Copy, Rewrite,
//                          Create image, Edit; direction: Copy, Rewrite,
//                          Chapter descriptions, Prepend (answered only),
//                          Edit; empty leaf: Copy, Chapter descriptions,
//                          Continue, Switch characters, repeat counter, Edit.
//   EDITING (`.editor-actions`): draft: Send, Chapter descriptions, Continue,
//                          Switch characters, repeat counter, Cancel;
//                          answered direction: OK, Continuation, Insert,
//                          Cancel; chapter: OK, Cancel.
//
// The spec walks the state matrix requested for the node cards:
//   Direction vs Chapter roles,
//   read-only vs during editing,
//   with content vs empty,
//   leaf (terminal composer) vs non-leaf,
//   with siblings vs without,
//   with prior versions vs without.
//
// Presence / absence of every button is asserted per state; the buttons that
// are unique to the on-card UI (branch-switcher cycling, prior-version
// toggle, draft Send, Copy, Edit, header Remove Section) are exercised with
// real clicks. Every tree-mutating test builds its OWN story, so the shared
// seeded "Getting Started" chat stays intact for the rest of the run.
// ---------------------------------------------------------------------------

import { Page, Locator } from '@playwright/test';
import { test, expect } from '../support/coverage';
import { mockLlm } from '../support/llm-mock';
import {
  openApp,
  newStory,
  askQuestion,
  expectNodeText,
  nodeFor,
  openEditorOn,
  acceptConfirmDialog,
} from '../support/ui';

const QA = 'Who is the hero?';
const ANSWER = 'The hero is Ada.';
const BRANCH_ANSWER = 'A quiet branch opens.';
const NEW_ANSWER = 'The revised hero is Ada, resolute and kind.';

// i18n labels (catalog-en) — pinned here so a label rename is one-line fix.
const L = {
  regenerate: 'Regenerate',
  rewriteInPlace: 'Rewrite in place',
  illustrate: 'Illustrate',
  copy: 'Copy',
  rewrite: 'Rewrite',
  createImage: 'Create image',
  edit: 'Edit',
  send: 'Send',
  chapterDescriptions: 'Chapter descriptions',
  continue: 'Continue',
  switchCharacters: 'Switch characters',
  ok: 'OK',
  branch: 'Continuation',
  insert: 'Insert',
  cancel: 'Cancel',
  heading: 'Heading',
  prepend: 'Prepend',
};

/** Fresh story with one answered beat: … › D(QA) › C(ANSWER) › D(composer). */
async function freshQA(page: Page): Promise<void> {
  await mockLlm(page, { answer: [ANSWER] });
  await openApp(page);
  await newStory(page, 'Demo Project');
  await askQuestion(page, QA);
  await expectNodeText(page, ANSWER);
}

/** The terminal composer card (empty unsent direction leaf). */
function composerCard(page: Page): Locator {
  return page
    .locator('.tree app-chat-node')
    .filter({ has: page.getByText('Write the next direction…') })
    .first();
}

/** A footer `.node-actions` button of a card, matched by its label. */
function footerBtn(card: Locator, label: string): Locator {
  return card
    .locator('.node-actions button')
    .filter({ has: card.page().getByText(label, { exact: true }) });
}

/** A button inside the OPEN editor action row. The read-only card content
 *  (the `nodeFor`/`composerCard` anchor) disappears while the editor is open,
 *  so editor actions are matched at page level — there is only ever one
 *  inline editor open at a time. */
function editorAction(page: Page, label: string): Locator {
  return page
    .locator('.editor-actions button')
    .filter({ has: page.getByText(label, { exact: true }) });
}

/** Assert the footer button set of a card: each `present` label has exactly
 *  one button, each `absent` label has none. */
async function expectFooterSet(card: Locator, present: string[], absent: string[]): Promise<void> {
  for (const label of present) {
    await expect(footerBtn(card, label)).toHaveCount(1);
  }
  for (const label of absent) {
    await expect(footerBtn(card, label)).toHaveCount(0);
  }
}

/** Assert the editor-actions button set while an editor is open. */
async function expectEditorSet(page: Page, present: string[], absent: string[]): Promise<void> {
  for (const label of present) {
    await expect(editorAction(page, label)).toHaveCount(1);
  }
  for (const label of absent) {
    await expect(editorAction(page, label)).toHaveCount(0);
  }
}

test.describe('chat-node buttons (header + footer + editor)', () => {
  test('01 direction node (answered, non-leaf, no siblings): footer + header sets', async ({
    page,
  }) => {
    await freshQA(page);

    // Bottom action row on the answered direction: no LLM buttons, no
    // Continue / Switch characters (it is not the terminal leaf), Prepend
    // appears because the question is answered (has children).
    await expectFooterSet(nodeFor(page, QA), [
      L.copy,
      L.rewrite,
      L.chapterDescriptions,
      L.prepend,
      L.edit,
    ], [
      L.regenerate,
      L.rewriteInPlace,
      L.illustrate,
      L.createImage,
      L.continue,
      L.switchCharacters,
    ]);

    // Top header row: destructive buttons present, NO branch switcher (single
    // child) and NO “Heading” (chapter-only), no prior versions yet.
    const direction = nodeFor(page, QA);
    await expect(direction.locator('.delete-actions .remove-node-btn')).toHaveCount(1);
    await expect(direction.locator('.delete-actions .delete-btn')).toHaveCount(1);
    await expect(
      direction.locator('.delete-actions button').filter({ hasText: L.heading }),
    ).toHaveCount(0);
    await expect(direction.locator('.branch-switcher')).toHaveCount(0);
    await expect(direction.locator('.prior-versions')).toHaveCount(0);
  });

  test('02 chapter node (answered, non-leaf, no siblings): footer + header sets', async ({
    page,
  }) => {
    await freshQA(page);

    // Bottom action row on the answered chapter: the full LLM + content set.
    await expectFooterSet(nodeFor(page, ANSWER), [
      L.regenerate,
      L.rewriteInPlace,
      L.illustrate,
      L.copy,
      L.rewrite,
      L.createImage,
      L.edit,
    ], [
      L.prepend,
      L.chapterDescriptions,
      L.continue,
      L.switchCharacters,
    ]);

    // Top header row: “Heading” (assistant-only) + destructive buttons, no
    // branch switcher, no prior versions yet.
    const chapter = nodeFor(page, ANSWER);
    await expect(
      chapter.locator('.delete-actions button').filter({ hasText: L.heading }),
    ).toHaveCount(1);
    await expect(chapter.locator('.delete-actions .remove-node-btn')).toHaveCount(1);
    await expect(chapter.locator('.delete-actions .delete-btn')).toHaveCount(1);
    await expect(chapter.locator('.branch-switcher')).toHaveCount(0);
    await expect(chapter.locator('.prior-versions')).toHaveCount(0);
  });

  test('03 empty chapter (stream finished without content): reduced footer set', async ({
    page,
  }) => {
    // answer: [] → only the [DONE] sentinel, no content deltas → the chapter
    // stays an empty placeholder that renders "Generation stopped".
    await mockLlm(page, { answer: [] });
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, QA);

    const emptyChapter = page
      .locator('.tree app-chat-node')
      .filter({ hasText: 'Generation stopped' })
      .first();
    await expect(emptyChapter).toBeVisible();

    // Content-requiring buttons disappear (Rewrite, Create image); structure /
    // stream controls remain.
    await expectFooterSet(emptyChapter, [
      L.regenerate,
      L.rewriteInPlace,
      L.illustrate,
      L.copy,
      L.edit,
    ], [
      L.rewrite,
      L.createImage,
      L.chapterDescriptions,
      L.prepend,
      L.continue,
      L.switchCharacters,
    ]);

    // Illustrate is present but disabled: there is no text to depict yet.
    await expect(footerBtn(emptyChapter, L.illustrate)).toBeDisabled();
  });

  test('04 empty leaf direction (composer, closed): Continue / Switch characters, no Prepend', async ({
    page,
  }) => {
    await freshQA(page);
    const composer = composerCard(page);
    await expect(composer).toBeVisible();

    // The terminal leaf offers the continuation controls, Copy, chapter
    // descriptions and Edit — but no Prepend (unsent), no Rewrite (empty),
    // no LLM/structure buttons.
    await expectFooterSet(composer, [
      L.copy,
      L.chapterDescriptions,
      L.edit,
      L.continue,
      L.switchCharacters,
    ], [
      L.prepend,
      L.rewrite,
      L.regenerate,
      L.rewriteInPlace,
      L.illustrate,
      L.createImage,
    ]);

    // Repeat counter is part of the closed-continuation control group.
    await expect(composer.locator('.repeat-counter')).toHaveCount(1);

    // No branch switcher (no siblings) and no Heading on a direction.
    await expect(composer.locator('.branch-switcher')).toHaveCount(0);
    await expect(
      composer.locator('.delete-actions button').filter({ hasText: L.heading }),
    ).toHaveCount(0);
  });

  test('05 editing the empty leaf direction: draft editor actions', async ({ page }) => {
    await freshQA(page);
    const composer = composerCard(page);

    // Open the composer via its footer Edit button (a real on-card click).
    await footerBtn(composer, L.edit).click();
    const editor = page.locator('.editor-textarea');
    await expect(editor).toBeVisible();
    await expect(editor.first()).toHaveValue('');

    // Empty-draft editor: Send + Chapter descriptions + Continue / Switch
    // characters + repeat counter + Cancel; no version/branch/insert actions.
    await expectEditorSet(page, [
      L.send,
      L.chapterDescriptions,
      L.continue,
      L.switchCharacters,
      L.cancel,
    ], [
      L.ok,
      L.branch,
      L.insert,
    ]);
    await expect(page.locator('.editor-actions .repeat-counter')).toHaveCount(1);

    // Cancel closes the editor without saving.
    await editorAction(page, L.cancel).click();
    await expect(page.locator('.editor-textarea')).toHaveCount(0);
  });

  test('06 editing an answered direction: OK / Continuation / Insert / Cancel', async ({
    page,
  }) => {
    await freshQA(page);
    await openEditorOn(page, QA);
    await expect(page.locator('.editor-textarea').first()).toHaveValue(QA);

    // Existing (answered) direction: versioning + branch/insert flows.
    await expectEditorSet(page, [
      L.ok,
      L.branch,
      L.insert,
      L.cancel,
    ], [
      L.send,
      L.continue,
      L.switchCharacters,
    ]);

    // Cancel leaves the node untouched.
    await editorAction(page, L.cancel).click();
    await expect(page.locator('.editor-textarea')).toHaveCount(0);
    await expectNodeText(page, QA);
  });

  test('07 editing a chapter: OK / Cancel only', async ({ page }) => {
    await freshQA(page);
    await openEditorOn(page, ANSWER);
    await expect(page.locator('.editor-textarea').first()).toHaveValue(ANSWER);

    // A chapter edit is a plain version-save — no send/branch/insert controls.
    await expectEditorSet(page, [L.ok, L.cancel], [
      L.send,
      L.branch,
      L.insert,
      L.continue,
      L.switchCharacters,
    ]);

    await editorAction(page, L.cancel).click();
    await expect(page.locator('.editor-textarea')).toHaveCount(0);
  });

  test('08 siblings exist: branch-switcher appears and prev/next cycle the active continuation', async ({
    page,
  }) => {
    await freshQA(page);

    // Branch the answered direction: Edit → Continuation creates a sibling
    // direction + streamed answer (the new branch is activated).
    await mockLlm(page, { answer: [BRANCH_ANSWER] });
    await openEditorOn(page, QA);
    await editorAction(page, L.branch).click();
    await expectNodeText(page, BRANCH_ANSWER);

    // The new branch is active: branch-switcher shows 2 / 2, the original
    // answer is OFF the active path.
    const direction = nodeFor(page, QA);
    await expect(direction.locator('.branch-switcher')).toBeVisible();
    await expect(direction.locator('.branch-count')).toContainText('2 / 2');
    await expect(
      page.locator('.tree .node-content').filter({ hasText: ANSWER }),
    ).toHaveCount(0);

    // Previous → original continuation active again: count 1 / 2, old answer
    // visible, branch answer off-path.
    await direction.locator('.branch-switcher button').first().click();
    await expect(
      page.locator('.tree .node-content').filter({ hasText: ANSWER }),
    ).toBeVisible();
    const directionAgain = nodeFor(page, QA);
    await expect(directionAgain.locator('.branch-count')).toContainText('1 / 2');

    // Next → branch continuation active again.
    await directionAgain.locator('.branch-switcher button').last().click();
    await expect(
      page.locator('.tree .node-content').filter({ hasText: BRANCH_ANSWER }),
    ).toBeVisible();
    await expect(
      page.locator('.tree .node-content').filter({ hasText: ANSWER }),
    ).toHaveCount(0);
  });

  test('09 versions exist: saving a version shows the prior-version toggle', async ({
    page,
  }) => {
    await freshQA(page);

    // Version 1: edit the chapter, change the text, save with OK.
    await openEditorOn(page, ANSWER);
    await page.locator('.editor-textarea').first().fill(NEW_ANSWER);
    await editorAction(page, L.ok).click();

    const v2 = nodeFor(page, NEW_ANSWER);
    await expect(v2).toBeVisible();
    await expect(v2.locator('.node-header')).toContainText('v2');
    // The old text is retained as a prior version (toggle is collapsed).
    await expect(v2.locator('.prior-toggle')).toContainText('1 previous version(s)');
    await v2.locator('.prior-toggle').click();
    await expect(v2.locator('.prior-version').first()).toContainText(ANSWER);

    // Version 2: the toggle accumulates to 2 previous version(s).
    await openEditorOn(page, NEW_ANSWER);
    await page.locator('.editor-textarea').first().fill('Chapter two starts with a storm.');
    await editorAction(page, L.ok).click();

    const v3 = nodeFor(page, 'Chapter two starts with a storm.');
    await expect(v3.locator('.node-header')).toContainText('v3');
    await expect(v3.locator('.prior-toggle')).toContainText('2 previous version(s)');
  });

  test('10 on-card Copy copies the chapter; on-card Edit opens the prefilled editor', async ({
    page,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await freshQA(page);

    await footerBtn(nodeFor(page, ANSWER), L.copy).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(ANSWER);

    await footerBtn(nodeFor(page, ANSWER), L.edit).click();
    const editor = page.locator('.editor-textarea').first();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(ANSWER);
    await editorAction(page, L.cancel).click();
    await expect(editor).toHaveCount(0);
  });

  test('11 the composer Send button sends the draft (leaf → streamed answer)', async ({
    page,
  }) => {
    await freshQA(page);
    const question = 'Where does the story begin?';

    const composer = composerCard(page);
    await footerBtn(composer, L.edit).click();
    const editor = page.locator('.editor-textarea').first();
    await editor.fill(question);

    await mockLlm(page, { answer: ['In a quiet harbour.'] });
    await editorAction(page, L.send).click();

    await expectNodeText(page, 'In a quiet harbour.');
    // The sent direction became a real content node (a rendered card, no
    // longer the "Write the next direction…" composer).
    await expect(nodeFor(page, question)).toBeVisible();
    await expect(
      composerCard(page).locator('.node-content'),
    ).toContainText('Write the next direction…');
  });

  test('12 header "Remove Section" removes only that node (children stay)', async ({
    page,
  }) => {
    await freshQA(page);

    const direction = nodeFor(page, QA);
    await direction.locator('.delete-actions .remove-node-btn').click();
    await acceptConfirmDialog(page);

    // The answered direction is gone …
    await expect(nodeFor(page, QA)).toHaveCount(0);
    // … but its chapter child is re-parented and still on the active path.
    await expectNodeText(page, ANSWER);
  });
});
// ---------------------------------------------------------------------------
// NODE-NAV-BAR — the active-path navigation bar above the tree.
//
// The nav bar renders the linear reading order as D/C/S buttons (directions /
// chapters / structure), lets the user scroll to a node by clicking, multi-
// select a contiguous chain with Ctrl+click, and provides:
//   - a right-click context menu per nav node (start branch here, previous /
//     next continuation, select, copy / cut / delete, paste in front/behind),
//   - a ⤵ paste button (with its own Insert / Append right-click menu),
//   - a drag-resizable vertical separator (double-click resets).
//
// "Getting Started" (seed) is used non-destructively: user → assistant →
// draft = 3 nav nodes. Every tree-mutating test builds its OWN story so the
// shared seeded chat stays intact for the rest of the run.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { mockLlm, mockLlmScripts } from '../support/llm-mock';
import {
  openApp,
  openChat,
  newStory,
  askQuestion,
  expectNavPathLength,
  expectNodeText,
  clickNavNode,
  navNode,
  openNavNodeMenu,
  clickNavMenuAction,
  ctrlClickNavNode,
  expectNavNodeSelected,
  expectNavSelection,
  navPasteButtonAfter,
  acceptConfirmDialog,
  dragNavResizer,
  navBarHeightPx,
} from '../support/ui';

test.describe('node-nav-bar', () => {
  test('01 renders the active path as nav buttons with role badges and full-content tooltips', async ({
    page,
  }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');

    // user → assistant → draft = D / C / D.
    await expectNavPathLength(page, 3);
    await expect(page.locator('.node-nav-bar .nav-node .nav-badge')).toHaveText([
      'D',
      'C',
      'D',
    ]);

    // Tooltips carry the FULL node content (never a shortened description).
    await expect(navNode(page, 1)).toHaveAttribute(
      'title',
      'How should I introduce my main character?',
    );
    await expect(navNode(page, 2)).toHaveAttribute(
      'title',
      'Introduce your hero in a memorable, decisive moment.',
    );
  });

  test('02 clicking a nav node scrolls the tree so that node becomes the active viewport node', async ({
    page,
  }) => {
    // A fresh story opens scrolled to the leaf (bottom); the first nodes are
    // above the fold. Clicking the FIRST nav node scrolls the tree up so that
    // node sits at the top and is marked `.active`.
    await mockLlmScripts(page, [
      { answer: ['A quiet, warm opening scene.'] },
      { answer: ['The story turns in chapter two.'] },
    ]);
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, 'Who is the hero?');
    await askQuestion(page, 'What happens in chapter two?');
    await expectNavPathLength(page, 8);

    await clickNavNode(page, 1);
    await expect(navNode(page, 1)).toHaveClass(/active/);
    await expect(navNode(page, 1)).toHaveAttribute(
      'title',
      'You are a thoughtful writing coach.',
    );
  });

  test('03 nav context menu: "start branch here" forks a parallel continuation', async ({
    page,
  }) => {
    await mockLlm(page, { answer: ['A quiet, warm opening scene.'] });
    await openApp(page);

    // A fresh story seeds system → user → greeting-assistant → draft (4 nodes).
    await newStory(page, 'Demo Project');
    await expectNavPathLength(page, 4);

    // Branch next to the greeting assistant (nav 3): a parallel empty draft
    // becomes the active continuation under the same parent (user).
    await openNavNodeMenu(page, 3);
    await expect(
      page.locator('.nav-paste-menu .nav-paste-item').filter({ hasText: 'Start branch here' }),
    ).toBeVisible();
    await clickNavMenuAction(page, 'Start branch here');

    await expectNavPathLength(page, 3);
    await expect(navNode(page, 3)).toHaveClass(/question/);
  });

  test('04 nav context menu: previous/next continuation switches the active branch', async ({
    page,
  }) => {
    await mockLlmScripts(page, [{ answer: ['The hero wakes at dawn.'] }]);
    await openApp(page);
    await newStory(page, 'Demo Project');
    await expectNavPathLength(page, 4); // S, D, C(greeting), draft

    // Fork a second continuation under the greeting (nav 3): a parallel empty
    // draft becomes the active continuation.
    await openNavNodeMenu(page, 3);
    await clickNavMenuAction(page, 'Start branch here');
    await expectNavPathLength(page, 3); // S, D, D2

    // Give the branch a real answer so it is no longer the terminal draft
    // (the terminal empty direction gets no context menu).
    await askQuestion(page, 'Who is the hero?');
    await expectNavPathLength(page, 5); // S, D, D2, A2, draft2

    // "Next continuation" on the branch (nav 3) cycles the active child of the
    // user node back to the greeting → S, D, C, draft (4).
    await openNavNodeMenu(page, 3);
    await expect(
      page.locator('.nav-paste-menu .nav-paste-item').filter({ hasText: 'Next continuation' }),
    ).toBeVisible();
    await clickNavMenuAction(page, 'Next continuation');
    await expectNavPathLength(page, 4);
    await expect(navNode(page, 3)).toHaveClass(/answer/);
    await expect(navNode(page, 3)).toHaveAttribute(
      'title',
      'Welcome! What should we write today?',
    );

    // "Previous continuation" switches back to the branch.
    await openNavNodeMenu(page, 3);
    await expect(
      page.locator('.nav-paste-menu .nav-paste-item').filter({ hasText: 'Previous continuation' }),
    ).toBeVisible();
    await clickNavMenuAction(page, 'Previous continuation');
    await expectNavPathLength(page, 5);
    await expect(navNode(page, 3)).toHaveClass(/question/);
  });

  test('05 ctrl+click multi-selects a chain; the toolbar copy/clear act on it', async ({
    page,
  }) => {
    await mockLlm(page, { answer: ['A quiet, warm opening scene.'] });
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, 'Who is the hero?');
    // path: system, user, greeting, Q1, A1, draft → 6 nav nodes.
    await expectNavPathLength(page, 6);

    await ctrlClickNavNode(page, 4); // Q1
    await ctrlClickNavNode(page, 5); // A1
    await expectNavNodeSelected(page, 4, true);
    await expectNavNodeSelected(page, 5, true);
    await expectNavSelection(page, 2);

    // Copy fills the clipboard → the ⤵ paste-after buttons appear.
    await page.locator('.nav-tools button').filter({ hasText: 'Copy' }).first().click();
    await expect(navPasteButtonAfter(page, 1)).toBeVisible();

    // Clear empties the selection toolbar.
    await page.locator('.nav-tools button').filter({ hasText: 'Clear' }).first().click();
    await expect(page.locator('.nav-tools')).toHaveCount(0);
    await expectNavNodeSelected(page, 4, false);
  });

  test('06 cut selected splices the chain out; the ⤵ paste-after re-inserts it', async ({
    page,
  }) => {
    await mockLlmScripts(page, [
      { answer: ['The hero wakes at dawn.'] },
      { answer: ['The story turns in chapter two.'] },
    ]);
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, 'How does chapter one begin?');
    await askQuestion(page, 'What happens in chapter two?');
    // path: system, user, greeting, Q1, A1, Q2, A2, draft → 8 nav nodes.
    await expectNavPathLength(page, 8);

    // Select Q2 + A2 (nav 6+7) and cut them; following text stays.
    await ctrlClickNavNode(page, 6);
    await ctrlClickNavNode(page, 7);
    await expectNavSelection(page, 2);
    await page.locator('.nav-tools button').filter({ hasText: 'Cut' }).first().click();
    await acceptConfirmDialog(page);

    await expectNavPathLength(page, 6);
    await expect(page.locator('.tree')).not.toContainText('The story turns in chapter two.');

    // Paste the chain back after Q1 (nav 4): Q1 → [Q2, A2] → A1.
    await navPasteButtonAfter(page, 4).click();
    await expectNavPathLength(page, 8);
    await expectNodeText(page, 'The story turns in chapter two.');
  });

  test('07 the ⤵ paste button has an Insert/Append right-click menu', async ({ page }) => {
    await mockLlmScripts(page, [
      { answer: ['The hero wakes at dawn.'] },
      { answer: ['The story turns in chapter two.'] },
    ]);
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, 'How does chapter one begin?');
    await askQuestion(page, 'What happens in chapter two?');
    await expectNavPathLength(page, 8);

    // Cut Q2+A2 (nav 6+7) → path shrinks to 6.
    await ctrlClickNavNode(page, 6);
    await ctrlClickNavNode(page, 7);
    await page.locator('.nav-tools button').filter({ hasText: 'Cut' }).first().click();
    await acceptConfirmDialog(page);
    await expectNavPathLength(page, 6);

    // Right-click the ⤵ after Q1 → the paste menu offers Insert / Append.
    const pasteMenu = page.locator('.nav-paste-menu:not(.nav-node-menu)');
    await navPasteButtonAfter(page, 4).click({ button: 'right' });
    await expect(pasteMenu).toBeVisible();
    await expect(pasteMenu.locator('.nav-paste-item').filter({ hasText: 'Append' })).toBeVisible();

    // Append keeps the chain as a hidden parallel branch → path unchanged.
    await pasteMenu.locator('.nav-paste-item').filter({ hasText: 'Append' }).click();
    await expectNavPathLength(page, 6);
    await expect(page.locator('.tree')).not.toContainText('The story turns in chapter two.');

    // Re-open and choose Insert → the chain splices back into the visible path.
    await navPasteButtonAfter(page, 4).click({ button: 'right' });
    await expect(pasteMenu).toBeVisible();
    await pasteMenu.locator('.nav-paste-item').filter({ hasText: 'Insert' }).click();
    await expectNavPathLength(page, 8);
    await expectNodeText(page, 'The story turns in chapter two.');
  });

  test('08 the vertical separator drags the nav bar taller; double-click resets', async ({
    page,
  }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await expectNavPathLength(page, 3);

    const before = await navBarHeightPx(page);
    await dragNavResizer(page, 80);
    await expect(page.locator('.node-nav-bar')).toHaveClass(/grown/);
    const after = await navBarHeightPx(page);
    expect(after).toBeGreaterThan(before);

    // Double-click resets to the default (content-sized, capped) handling.
    await page.locator('.nav-resizer').dblclick();
    await expect(page.locator('.node-nav-bar')).not.toHaveClass(/grown/);
  });
});

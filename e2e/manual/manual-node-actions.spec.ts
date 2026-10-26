// ---------------------------------------------------------------------------
// USER MANUAL — "Section actions and the context menu".
//
// Generates docs/manuals/manual-node-actions.md + screenshots. Uses the seeded
// "Getting Started" story to show the right-click context menu of a section
// (copy / edit / rewrite / exclude from model context / remove / delete).
// Non-destructive.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  ctxMenuItem,
  openApp,
  openChat,
  openNodeContextMenu,
} from '../support/ui';
import { newManual } from './manual-support';

const QUESTION = 'How should I introduce my main character?';

test('Section actions and the context menu', async ({ page }) => {
  const manual = newManual(
    page,
    'manual-node-actions',
    'Section actions and the context menu',
  );

  await manual.step(
    'Open a story',
    'Open the seeded **Getting Started** story.',
    (p) => openApp(p).then(() => openChat(p, 'Getting Started')),
    { waitAfter: 500 },
  );

  await manual.step(
    'Right-click a section',
    'Right-click any section to open its context menu.',
    (p) => openNodeContextMenu(p, QUESTION),
    { waitAfter: 300 },
  );

  await manual.step(
    'See the section actions',
    'The menu offers common actions: **Copy**, **Edit**, **Rewrite**, **Exclude from model context**, **Remove section** or **Delete section & following**.',
    async (p) => {
      await expect(ctxMenuItem(p, 'Copy')).toBeVisible();
      await expect(ctxMenuItem(p, 'Edit')).toBeVisible();
      await expect(ctxMenuItem(p, 'Remove section')).toBeVisible();
      await expect(ctxMenuItem(p, 'Delete section & following')).toBeVisible();
    },
    { waitAfter: 300, highlightTarget: page.locator('.context-menu') },
  );

  await manual.step(
    'Close the menu',
    'Click outside (or press Escape) to dismiss the menu without changing anything.',
    async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('.context-menu')).toHaveCount(0);
    },
    { waitAfter: 300 },
  );

  await manual.generate();
});
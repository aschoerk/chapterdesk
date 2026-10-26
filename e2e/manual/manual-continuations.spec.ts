// ---------------------------------------------------------------------------
// USER MANUAL — "Continuations and the navigation bar".
//
// Generates docs/manuals/manual-continuations.md + screenshots. Uses the
// seeded "Getting Started" story to show the navigation bar (the active path),
// right-click context menu actions and multi-selection. Non-destructive.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  ctrlClickNavNode,
  expectNavNodeSelected,
  expectNavPathLength,
  expectNavSelection,
  navNode,
  openApp,
  openChat,
} from '../support/ui';
import { newManual } from './manual-support';

test('Continuations and the navigation bar', async ({ page }) => {
  const manual = newManual(
    page,
    'manual-continuations',
    'Continuations and the navigation bar',
  );

  await manual.step(
    'Open a story',
    'Open the seeded **Getting Started** story.',
    (p) => openApp(p).then(() => openChat(p, 'Getting Started')),
    { waitAfter: 500 },
  );

  await manual.step(
    'See the navigation bar',
    'The **navigation bar** shows the active path: direction (**D**), chapter (**C**), then the next direction. Click a button to jump to that section.',
    async (p) => {
      await expectNavPathLength(p, 3);
      await expect(p.locator('.node-nav-bar .nav-node .nav-badge')).toHaveText(['D', 'C', 'D']);
    },
    { waitAfter: 300, highlightTarget: page.locator('.node-nav-bar') },
  );

  await manual.step(
    'Open a section context menu',
    'Right-click a section to rename, copy, edit or branch a continuation from it.',
    async (p) => {
      await navNode(p, 2).click({ button: 'right' });
      await expect(p.locator('.nav-paste-menu.nav-node-menu')).toBeVisible();
      await expect(
        p.locator('.nav-paste-menu .nav-paste-item').filter({ hasText: 'Start branch here' }),
      ).toBeVisible();
    },
    { waitAfter: 300 },
  );

  await manual.step(
    'Multi-select sections',
    'Hold **Ctrl** and click several navigation buttons to select a contiguous chain — the toolbar copies, cuts, deletes or clears the selection.',
    async (p) => {
      await p.keyboard.press('Escape'); // close the context menu
      await ctrlClickNavNode(p, 1);
      await ctrlClickNavNode(p, 2);
      await expectNavSelection(p, 2);
      await expectNavNodeSelected(p, 1, true);
      await expectNavNodeSelected(p, 2, true);
    },
    { waitAfter: 300, highlightTarget: page.locator('.nav-tools') },
  );

  await manual.generate();
});
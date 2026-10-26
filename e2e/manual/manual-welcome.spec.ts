// ---------------------------------------------------------------------------
// USER MANUAL — "Getting Started with ChapterDesk".
//
// Generates docs/manuals/manual-welcome.md + screenshots. Covers the first
// launch, the sidebar (environments + stories) and opening a story.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { openApp, openChat, nodeFor } from '../support/ui';
import { newManual } from './manual-support';

test('Getting Started with ChapterDesk', async ({ page }) => {
  const manual = newManual(page, 'manual-welcome', 'Getting Started with ChapterDesk');

  await manual.step(
    'Open the application',
    'Launch ChapterDesk. The left **sidebar** lists your books (environments) and their **stories**.',
    (p) => openApp(p),
    { waitAfter: 500 },
  );

  await manual.step(
    'Open a story',
    'Click a story in the sidebar. Its **sections** (directions and chapters) unfold in the tree.',
    async (p) => {
      await openChat(p, 'Getting Started');
      await expect(nodeFor(p, 'memorable, decisive moment')).toBeVisible();
    },
    { waitAfter: 800 },
  );

  await manual.step(
    'Read the story',
    'Scroll through the sections. The **navigation bar** at the bottom takes you to any section of the current continuation.',
    async (p) => {
      await expect(p.locator('.node-nav-bar .nav-node').first()).toBeVisible();
    },
    { waitAfter: 300, highlightTarget: page.locator('.node-nav-bar') },
  );

  await manual.generate();
});
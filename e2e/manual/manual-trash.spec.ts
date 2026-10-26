// ---------------------------------------------------------------------------
// USER MANUAL — "Delete and Restore Sections".
//
// Generates docs/manuals/manual-trash.md + screenshots. Demonstrates the
// soft-delete workflow: delete a continuation into the Trash, restore it, and
// purge it forever.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  openApp,
  newStory,
  nodeFor,
  deleteContinuation,
  openTrash,
  trashItem,
  restoreTrashItem,
  purgeTrashItem,
  expectTrashEmpty,
  expectTrashCount,
  closeTrash,
  deleteChatViaApi,
} from '../support/ui';
import { newManual } from './manual-support';

/** The greeting chapter every fresh story under "Demo Project" is seeded with. */
const GREETING = 'Welcome! What should we write today?';

test('Delete and Restore Sections', async ({ page }) => {
  const manual = newManual(page, 'manual-trash', 'Delete and Restore Sections');
  let title = '';

  await manual.step(
    'Open a fresh story',
    'Start from a new story so there is a section to delete.',
    async (p) => {
      await openApp(p);
      title = await newStory(p, 'Demo Project');
      await expect(nodeFor(p, GREETING)).toBeVisible();
    },
    { waitAfter: 500 },
  );

  await manual.step(
    'Delete a continuation',
    'In the section header click **Delete Continuation** and confirm. The section is NOT destroyed — it moves to the **Trash**.',
    (p) => deleteContinuation(p, GREETING),
    {
      waitAfter: 400,
      highlightTarget: page
        .locator('.params-bar button')
        .filter({ hasText: 'Trash' }),
    },
  );

  await manual.step(
    'Open the Trash',
    'Click **Trash (1)** in the toolbar. Each deleted continuation is listed with its role and a preview.',
    (p) => openTrash(p),
    { waitAfter: 400, highlightTarget: trashItem(page, GREETING) },
  );

  await manual.step(
    'Restore the section',
    'Click **Restore** — the continuation is placed back into the story and the Trash empties.',
    async (p) => {
      await restoreTrashItem(p, GREETING);
      await expectTrashEmpty(p);
      await expect(nodeFor(p, GREETING)).toBeVisible();
      await closeTrash(p);
    },
    { waitAfter: 400 },
  );

  await manual.step(
    'Purge forever',
    'Delete the continuation again and choose **Delete forever** in the Trash. Purged sections cannot be recovered.',
    async (p) => {
      await deleteContinuation(p, GREETING);
      await expectTrashCount(p, 1);
      await openTrash(p);
      await purgeTrashItem(p, GREETING);
      await expectTrashEmpty(p);
    },
    { waitAfter: 400 },
  );

  await manual.generate();
  await closeTrash(page).catch(() => {});
  await deleteChatViaApi(page, title);
});
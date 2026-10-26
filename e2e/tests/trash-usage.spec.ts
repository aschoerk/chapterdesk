// ---------------------------------------------------------------------------
// TRASH USAGE — soft-delete / restore / purge of nodes.
//
// Deleting a node is a SOFT delete on ChapterDesk: the deleted continuation
// lands in the chat's trash panel (params-bar "Trash (n)" button) instead of
// being removed. From the trash the user can RESTORE the branch back into the
// tree, or PURGE it forever.
//
// Each test creates its own fresh story (whose seeded greeting chapter offers
// a deterministic node to delete) and cleans the chat up afterwards, so the
// shared seed ("Getting Started") stays intact for the other specs.
// ---------------------------------------------------------------------------

import { Page } from '@playwright/test';
import { test, expect } from '../support/coverage';
import {
  closeTrash,
  deleteChatViaApi,
  deleteContinuation,
  expectTrashCount,
  expectTrashEmpty,
  newStory,
  nodeFor,
  openApp,
  openChat,
  openTrash,
  purgeTrashItem,
  removeSectionOnly,
  restoreTrashItem,
  trashItem,
} from '../support/ui';

/** The greeting chapter every fresh story under "Demo Project" is seeded with. */
const GREETING = 'Welcome! What should we write today?';

/** Create a fresh story and return its auto-generated title (for cleanup). */
async function openGreetingStory(page: Page): Promise<string> {
  const title = await newStory(page, 'Demo Project');
  await expect(nodeFor(page, GREETING)).toBeVisible();
  return title;
}

test.describe('trash usage', () => {
  test('01 deleting a continuation soft-deletes it into the trash', async ({ page }) => {
    await openApp(page);
    const title = await openGreetingStory(page);

    // The params-bar Trash button shows no count before anything is deleted.
    await expectTrashCount(page, null);

    // "Delete Continuation" cascades the whole branch into the trash as one root.
    await deleteContinuation(page, GREETING);
    await expectTrashCount(page, 1);

    await openTrash(page);
    const item = trashItem(page, GREETING);
    await expect(item).toBeVisible();
    await expect(item.locator('.trash-badge')).toHaveText('chapter');
    await closeTrash(page);

    await deleteChatViaApi(page, title);
  });

  test('02 restore brings the deleted branch back into the tree', async ({ page }) => {
    await openApp(page);
    const title = await openGreetingStory(page);

    await deleteContinuation(page, GREETING);
    await expectTrashCount(page, 1);
    await expect(nodeFor(page, GREETING)).toHaveCount(0);

    await openTrash(page);
    await restoreTrashItem(page, GREETING);

    // The branch is back on the active path and the trash is empty again.
    await expect(nodeFor(page, GREETING)).toBeVisible();
    await expectTrashEmpty(page);
    await expectTrashCount(page, null);
    await closeTrash(page);

    await deleteChatViaApi(page, title);
  });

  test('03 purge deletes the branch forever (survives a reload)', async ({ page }) => {
    await openApp(page);
    const title = await openGreetingStory(page);

    await deleteContinuation(page, GREETING);
    await expectTrashCount(page, 1);

    await openTrash(page);
    await purgeTrashItem(page, GREETING);
    await expectTrashEmpty(page);
    await expectTrashCount(page, null);
    await closeTrash(page);
    await expect(nodeFor(page, GREETING)).toHaveCount(0);

    // Permanent: after a full reload the node is still gone and the trash empty.
    await page.reload();
    await openChat(page, title);
    await expect(nodeFor(page, GREETING)).toHaveCount(0);
    await openTrash(page);
    await expectTrashEmpty(page);
    await closeTrash(page);

    await deleteChatViaApi(page, title);
  });

  test('04 trash shows the empty state when nothing was deleted', async ({ page }) => {
    await openApp(page);
    const title = await openGreetingStory(page);

    await openTrash(page);
    await expectTrashEmpty(page);
    await expectTrashCount(page, null);
    await closeTrash(page);

    await deleteChatViaApi(page, title);
  });

  test('05 remove section (keep following text) also soft-deletes into the trash', async ({
    page,
  }) => {
    await openApp(page);
    const title = await openGreetingStory(page);

    // "Remove Section" deletes ONLY the chapter — the following draft re-attaches
    // to the user direction, but the removed chapter still lands in the trash.
    await removeSectionOnly(page, GREETING);
    await expectTrashCount(page, 1);

    await openTrash(page);
    await expect(trashItem(page, GREETING)).toBeVisible();
    await closeTrash(page);

    await deleteChatViaApi(page, title);
  });
});

// ---------------------------------------------------------------------------
// RIGHT CONTEXT-MENU — the in-app right-click menus on chat-node cards.
//
// The node card context menu is role- and state-aware (buildCtxMenuItems):
//   - common: Copy (to the OS clipboard), Edit, Rewrite selection…, Prior versions
//   - assistant: Add heading, Regenerate, Rewrite in place, Illustrate,
//     Create image of selection…,
//   - user: Exclude from model context, Chapter descriptions…, Prepend director
//     (and Continue / Switch characters on the terminal empty draft leaf),
//   - danger tail: Remove section, Delete section & following.
//
// Destructive actions (remove/delete) are exercised on freshly created chats
// so the shared seeded "Getting Started" chat stays intact.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { mockLlm } from '../support/llm-mock';
import {
  openApp,
  openChat,
  newStory,
  askQuestion,
  expectNavPathLength,
  expectNodeText,
  openNodeContextMenu,
  ctxMenuItem,
  clickCtxAction,
  acceptConfirmDialog,
} from '../support/ui';

test.describe('node right-click context menu', () => {
  test('01 right-click opens the menu with the common copy/edit actions', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openNodeContextMenu(page, 'How should I introduce my main character?');
    await expect(ctxMenuItem(page, 'Copy')).toBeVisible();
    await expect(ctxMenuItem(page, 'Edit')).toBeVisible();
  });

  test('02 the assistant (chapter) menu offers the chapter actions', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openNodeContextMenu(page, 'memorable, decisive moment');
    for (const label of [
      'Add heading',
      'Regenerate',
      'Rewrite in place',
      'Illustrate',
      'Create image of selection…',
      'Remove section',
      'Delete section & following',
    ]) {
      await expect(ctxMenuItem(page, label)).toBeVisible();
    }
  });

  test('03 the user (direction) menu offers direction + prepend actions', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openNodeContextMenu(page, 'How should I introduce my main character?');
    for (const label of [
      'Exclude from model context',
      'Chapter descriptions…',
      'Prepend director',
      'Remove section',
      'Delete section & following',
    ]) {
      await expect(ctxMenuItem(page, label)).toBeVisible();
    }
  });

  test('04 the terminal draft leaf offers continue / switch characters (and no prepend)', async ({
    page,
  }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    // The empty composer leaf is uniquely identified by its placeholder.
    const draft = page
      .locator('.tree app-chat-node')
      .filter({ hasText: 'Write the next direction…' })
      .first();
    await draft.click({ button: 'right' });
    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(ctxMenuItem(page, 'Continue')).toBeVisible();
    await expect(ctxMenuItem(page, 'Switch characters')).toBeVisible();
    await expect(ctxMenuItem(page, 'Exclude from model context')).toBeVisible();
    // The terminal pending direction never gets Prepend.
    await expect(ctxMenuItem(page, 'Prepend director')).toHaveCount(0);
  });

  test('05 copy puts the node content on the OS clipboard', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openNodeContextMenu(page, 'How should I introduce my main character?');
    await clickCtxAction(page, 'Copy');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('How should I introduce my main character?');
  });

  test('06 edit opens the inline editor prefilled with the node content', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openNodeContextMenu(page, 'How should I introduce my main character?');
    await clickCtxAction(page, 'Edit');
    const editor = page.locator('.editor-textarea').first();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue('How should I introduce my main character?');
    // Cancel without saving so the shared seed chat stays unchanged.
    await page
      .locator('.editor-actions button')
      .filter({ hasText: 'Cancel' })
      .first()
      .click();
    await expect(editor).toHaveCount(0);
  });

  test('07 "exclude from model context" toggles the ✓ marker on the item', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openNodeContextMenu(page, 'How should I introduce my main character?');

    // The shared seeded chat may already be dirty from a previous (failed)
    // run — read the current state instead of assuming it is un-excluded.
    const item = ctxMenuItem(page, 'Exclude from model context');
    const initiallyExcluded = (await item.textContent())?.includes('✓') ?? false;
    await clickCtxAction(page, 'Exclude from model context');

    // Re-open: the flag flipped.
    await openNodeContextMenu(page, 'How should I introduce my main character?');
    const afterFirst = ctxMenuItem(page, 'Exclude from model context');
    if (initiallyExcluded) {
      await expect(afterFirst).not.toHaveText(/✓/);
    } else {
      await expect(afterFirst).toHaveText(/✓/);
    }

    // Toggle back to the ORIGINAL state so the shared seed stays clean.
    await clickCtxAction(page, 'Exclude from model context');
    await openNodeContextMenu(page, 'How should I introduce my main character?');
    const afterSecond = ctxMenuItem(page, 'Exclude from model context');
    if (initiallyExcluded) {
      await expect(afterSecond).toHaveText(/✓/);
    } else {
      await expect(afterSecond).not.toHaveText(/✓/);
    }
  });

  test('08 "remove section" trashes only that node (children stay in the thread)', async ({
    page,
  }) => {
    await mockLlm(page, { answer: ['A quiet, warm opening scene.'] });
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, 'Who is the hero?');
    // path: system, user, greeting, Q1, A1, draft → 6 nav nodes.
    await expectNavPathLength(page, 6);

    await openNodeContextMenu(page, 'A quiet, warm opening scene.');
    await clickCtxAction(page, 'Remove section');
    await acceptConfirmDialog(page);

    // The answer is gone; its child (the draft) is re-parented under the
    // question → the question + draft remain (5 nav nodes).
    await expect(page.locator('.tree')).not.toContainText('A quiet, warm opening scene.');
    await expectNavPathLength(page, 5);
    await expectNodeText(page, 'Who is the hero?');
  });

  test('09 "delete section & following" removes the whole subtree', async ({ page }) => {
    await mockLlm(page, { answer: ['A quiet, warm opening scene.'] });
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, 'Who is the hero?');
    await expectNavPathLength(page, 6);

    await openNodeContextMenu(page, 'Who is the hero?');
    await clickCtxAction(page, 'Delete section & following');
    await acceptConfirmDialog(page);

    // The question + its whole following subtree are gone; a fresh composer
    // leaf is re-created under the remaining greeting chapter (4 nav nodes).
    await expect(page.locator('.tree')).not.toContainText('Who is the hero?');
    await expectNavPathLength(page, 4);
    await expectNodeText(page, 'Welcome! What should we write today?');
  });
});

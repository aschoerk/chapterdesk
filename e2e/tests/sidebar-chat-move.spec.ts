// ---------------------------------------------------------------------------
// SIDEBAR CHAT MOVEMENT — move a story between environments (books).
//
// A chat can be relocated on the sidebar in three ways, each covered here:
//   1. per-chat "Move to another environment" button + reassign dropdown
//      (target: another environment OR "— Unassigned —"),
//   2. per-chat "Move to Unassigned" button (eject into Unfiled stories),
//   3. HTML5 drag & drop of the chat row onto another environment header,
// plus the multi-selection toolbar (Ctrl+click → Cut → paste button in the
// target environment header) which moves a whole batch at once.
//
// Tests are self-contained: they create their own chats and target
// environments, move them, and clean up, so the shared seed ("Demo Project" /
// "Getting Started") stays intact for the specs that run before/after.
// ---------------------------------------------------------------------------

import { Page } from '@playwright/test';
import { test, expect } from '../support/coverage';
import {
  cancelClipboard,
  chatItem,
  createProject,
  ctrlClickChat,
  cutSelectedChats,
  deleteChatViaApi,
  deleteProject,
  dragChatToProject,
  expandProject,
  expectChatInProject,
  expectChatNotInProject,
  expectChatUnassigned,
  expectSelectionCount,
  moveChatToUnassigned,
  moveChatViaReassign,
  newStory,
  pasteIntoProject,
  projectBlock,
  seedSidebarWidth,
  uniqueName,
  widenSidebar,
} from '../support/ui';

const SOURCE_PROJECT = 'Demo Project';
const AUTO_TITLE = 'Demo Project – New Chat';
const UNASSIGNED_LABEL = '— Unassigned —';

/** Boot the app on the chat page with the sidebar widened (chat items clickable). */
async function openChatSidebar(page: Page): Promise<void> {
  await seedSidebarWidth(page);
  await page.goto('/#/chat');
  await expect(page.locator('.sidebar')).toBeVisible();
  await widenSidebar(page);
}

/** Create a fresh environment (book) to move chats into. */
async function createTargetProject(page: Page, name: string): Promise<void> {
  await createProject(page, name, 'Demo Topic');
  await openChatSidebar(page);
}

/**
 * Create a chat in the source environment and give it a unique, unambiguous
 * title. `newStory` itself has a race: right after clicking "New story" the
 * main title editor can still show the PREVIOUS chat's title, so we wait for
 * the new chat to actually render in the sidebar (count + 1) and rename the
 * ACTIVE (auto-selected) item — never by matching the colliding auto title.
 */
async function makeMoveChat(page: Page, label: string): Promise<string> {
  const block = projectBlock(page, SOURCE_PROJECT);
  await expandProject(page, SOURCE_PROJECT);
  const before = await block.locator('.chat-item').count();
  await newStory(page, SOURCE_PROJECT);
  const name = uniqueName(label);
  await expect(block.locator('.chat-item')).toHaveCount(before + 1);
  const active = block.locator('.chat-item.active').first();
  await expect(active).toBeVisible();
  await expect(active.locator('.chat-title').first()).toHaveText(AUTO_TITLE);
  await active.locator('.rename-btn').click();
  const input = page.locator('.chat-title-input').first();
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(chatItem(page, name)).toBeVisible();
  return name;
}

test.describe('sidebar chat movement', () => {
  test('01 move a chat to another environment via the "Move to another environment" button', async ({
    page,
  }) => {
    await openChatSidebar(page);
    const target = uniqueName('Move Target');
    await createTargetProject(page, target);

    const chat = await makeMoveChat(page, 'Move Chat');
    await expectChatInProject(page, chat, SOURCE_PROJECT);

    await moveChatViaReassign(page, chat, target);
    await expectChatInProject(page, chat, target);
    await expectChatNotInProject(page, chat, SOURCE_PROJECT);

    await deleteProject(page, target);
  });

  test('02 move a chat to "Unfiled stories" via the reassign dropdown', async ({ page }) => {
    await openChatSidebar(page);
    const chat = await makeMoveChat(page, 'Move Chat');
    await expectChatInProject(page, chat, SOURCE_PROJECT);

    await moveChatViaReassign(page, chat, UNASSIGNED_LABEL);
    await expectChatUnassigned(page, chat);
    await expectChatNotInProject(page, chat, SOURCE_PROJECT);

    await deleteChatViaApi(page, chat);
  });

  test('03 move a chat to "Unfiled stories" via the "Move to Unassigned" button', async ({
    page,
  }) => {
    await openChatSidebar(page);
    const chat = await makeMoveChat(page, 'Move Chat');
    await expectChatInProject(page, chat, SOURCE_PROJECT);

    await moveChatToUnassigned(page, chat);
    await expectChatUnassigned(page, chat);
    await expectChatNotInProject(page, chat, SOURCE_PROJECT);

    await deleteChatViaApi(page, chat);
  });

  test('04 move a chat to another environment by dragging it onto the environment header', async ({
    page,
  }) => {
    await openChatSidebar(page);
    const target = uniqueName('Drag Target');
    await createTargetProject(page, target);

    const chat = await makeMoveChat(page, 'Move Chat');
    await expectChatInProject(page, chat, SOURCE_PROJECT);

    await dragChatToProject(page, chat, target);
    await expectChatInProject(page, chat, target);
    await expectChatNotInProject(page, chat, SOURCE_PROJECT);

    await deleteProject(page, target);
  });

  test('05 cut + paste moves the selected chats into another environment', async ({ page }) => {
    await openChatSidebar(page);
    const target = uniqueName('Paste Target');
    await createTargetProject(page, target);

    const chatA = await makeMoveChat(page, 'Move Chat A');
    const chatB = await makeMoveChat(page, 'Move Chat B');
    await expectChatInProject(page, chatA, SOURCE_PROJECT);
    await expectChatInProject(page, chatB, SOURCE_PROJECT);

    // Multi-select both chats, then stage a move with the Cut button.
    await ctrlClickChat(page, chatA);
    await ctrlClickChat(page, chatB);
    await expectSelectionCount(page, 2);
    await cutSelectedChats(page);

    // Cut is staged (non-destructive) — the chats stay in the source until pasted.
    await expectChatInProject(page, chatA, SOURCE_PROJECT);
    await expectChatInProject(page, chatB, SOURCE_PROJECT);

    // Paste the batch into the target environment via its header paste button.
    await pasteIntoProject(page, target);
    await expectChatInProject(page, chatA, target);
    await expectChatInProject(page, chatB, target);
    await expectChatNotInProject(page, chatA, SOURCE_PROJECT);
    await expectChatNotInProject(page, chatB, SOURCE_PROJECT);
    // The seeded story must be untouched.
    await expectChatInProject(page, 'Getting Started', SOURCE_PROJECT);

    await deleteProject(page, target);
  });

  test('06 cancel leaves a staged cut chat untouched', async ({ page }) => {
    await openChatSidebar(page);
    const chat = await makeMoveChat(page, 'Move Chat');
    await expectChatInProject(page, chat, SOURCE_PROJECT);

    await ctrlClickChat(page, chat);
    await expectSelectionCount(page, 1);
    await cutSelectedChats(page);

    // Staged: still in the source and marked with the ✂ cut badge.
    await expectChatInProject(page, chat, SOURCE_PROJECT);
    await expect(chatItem(page, chat)).toHaveClass(/cut/);

    // Cancel the clipboard → badge gone, chat untouched.
    await cancelClipboard(page);
    await expect(chatItem(page, chat)).not.toHaveClass(/cut/);
    await expectChatInProject(page, chat, SOURCE_PROJECT);

    await deleteChatViaApi(page, chat);
  });
});

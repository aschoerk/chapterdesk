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
  deleteProjectStoriesExcept,
  dragChatToProject,
  dragChatToUnassigned,
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
const UNASSIGNED_LABEL = '— Unassigned —';
const SEED_STORY = 'Getting Started';

/** Boot the app on the chat page with the sidebar widened (chat items clickable). */
async function openChatSidebar(page: Page): Promise<void> {
  await seedSidebarWidth(page);
  await page.goto('/#/chat');
  await expect(page.locator('.sidebar')).toBeVisible();
  await widenSidebar(page);
}

/** Create a fresh environment (book) and return to the chat sidebar. */
async function createEnvironment(page: Page, name: string): Promise<void> {
  await createProject(page, name, 'Demo Topic');
  await openChatSidebar(page);
}

/**
 * Empty the shared seed environment down to its original story so the sidebar
 * scroll window stays short. A drag needs its source + target on screen; with
 * time-sorting the freshly created source/target environments are the YOUNGEST
 * and sort to the TOP regardless, but removing the accumulated strays keeps any
 * scroll-to-active-chat from pulling the view down into a long project list.
 */
async function tidySourceProject(page: Page): Promise<void> {
  await deleteProjectStoriesExcept(page, SOURCE_PROJECT, [SEED_STORY]);
}

/**
 * Create a chat in the source environment and give it a unique, unambiguous
 * title. `newStory` itself has a race: right after clicking "New story" the
 * main title editor can still show the PREVIOUS chat's title, so we wait for
 * the new chat to actually render in the sidebar (count + 1) and rename the
 * ACTIVE (auto-selected) item — never by matching the colliding auto title.
 */
async function makeMoveChat(page: Page, label: string, projectName = SOURCE_PROJECT): Promise<string> {
  const block = projectBlock(page, projectName);
  await expandProject(page, projectName);
  // The chat list renders asynchronously (zoneless change detection + the
  // chats loading from the API). Wait for the item count to SETTLE before
  // taking the baseline so `before` is accurate — this works for BOTH a
  // populated environment (Demo Project seed) and a freshly created EMPTY
  // source environment (the drag tests), which has zero chats.
  let before = await block.locator('.chat-item').count();
  await expect.poll(async () => {
    const now = await block.locator('.chat-item').count();
    const stable = now === before;
    before = now;
    return stable;
  }, { timeout: 10_000 }).toBe(true);

  await newStory(page, projectName);
  const name = uniqueName(label);
  await expect(block.locator('.chat-item')).toHaveCount(before + 1);
  const active = block.locator('.chat-item.active').first();
  await expect(active).toBeVisible();
  await expect(active.locator('.chat-title').first()).toHaveText(`${projectName} – New Chat`);
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
    await createEnvironment(page, target);

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
    await tidySourceProject(page);

    // A drag needs BOTH source + target on screen. Instead of dragging out of
    // the shared seed project (which accumulates many stories and pushes the
    // target below the fold in the full suite), use a DEDICATED source
    // environment with its own story — with the sidebar sorted by time, the
    // freshly created SOURCE and TARGET environments are the youngest and sit
    // at the TOP of the list, so the drag is feasible.
    const source = uniqueName('Drag Source');
    const target = uniqueName('Drag Target');
    await createEnvironment(page, source);
    await createEnvironment(page, target);

    const chat = await makeMoveChat(page, 'Move Chat', source);
    await expectChatInProject(page, chat, source);

    await dragChatToProject(page, chat, target, source);
    await expectChatInProject(page, chat, target);
    await expectChatNotInProject(page, chat, source);

    await deleteProject(page, target);
    await deleteProject(page, source);
  });

  test('05 move a chat to "Unfiled stories" by dragging it onto the unassigned header', async ({
    page,
  }) => {
    await openChatSidebar(page);
    await tidySourceProject(page);

    // Same principle as 04: a dedicated source env (newest → top) makes the
    // drag-on/off and the unassigned block reachable without deep scrolling.
    const source = uniqueName('Drag Source');
    await createEnvironment(page, source);

    const chat = await makeMoveChat(page, 'Move Chat', source);
    await expectChatInProject(page, chat, source);

    await dragChatToUnassigned(page, chat, source);
    await expectChatUnassigned(page, chat);
    await expectChatNotInProject(page, chat, source);

    await deleteProject(page, source);
    // The chat now lives in Unfiled stories — remove it via API (no env owns it).
    await deleteChatViaApi(page, chat);
  });

  test('06 cut + paste moves the selected chats into another environment', async ({ page }) => {
    await openChatSidebar(page);
    const target = uniqueName('Paste Target');
    await createEnvironment(page, target);

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

  test('07 cancel leaves a staged cut chat untouched', async ({ page }) => {
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

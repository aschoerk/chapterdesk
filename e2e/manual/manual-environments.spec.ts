// ---------------------------------------------------------------------------
// USER MANUAL — "Books (Environments) and moving stories".
//
// Generates docs/manuals/manual-environments.md + screenshots. Shows the
// Environments page (create a book / environment) and then how a story can be
// moved into another book from the sidebar (via the "Move to another
// environment" reassign dropdown). Self-contained + cleans up.
// ---------------------------------------------------------------------------

import { Page } from '@playwright/test';
import { test, expect } from '../support/coverage';
import {
  chatItem,
  createProject,
  deleteProject,
  deleteChatViaApi,
  expandProject,
  expectChatInProject,
  gotoProjects,
  moveChatViaReassign,
  newStory,
  projectCard,
  projectBlock,
  seedSidebarWidth,
  widenSidebar,
} from '../support/ui';
import { newManual } from './manual-support';

test('Books (environments) and moving stories', async ({ page }: { page: Page }) => {
  const manual = newManual(
    page,
    'manual-environments',
    'Books (Environments) and moving stories',
  );
  const book = `Manual Book ${Date.now().toString(36)}`;
  const story = `Manual Story ${Date.now().toString(36)}`;

  await manual.step(
    'Open the Environments page',
    'Use the **Environments** link in the top navigation. Environments are your books; each groups stories that belong together.',
    (p) => gotoProjects(p),
    { waitAfter: 400 },
  );

  await manual.step(
    'Create a book',
    'Click **+ New environment**, give it a name and choose a main topic. Save to create the book.',
    async (p) => {
      await createProject(p, book, 'Demo Topic', { greeting: 'Welcome to the new book.' });
      await expect(projectCard(p, book)).toBeVisible();
    },
    { waitAfter: 400, highlightTarget: projectCard(page, book) },
  );

  await manual.step(
    'Back to the stories sidebar',
    'Return to **Stories**. The new book appears under its topic in the sidebar.',
    async (p) => {
      await seedSidebarWidth(p);
      await p.goto('/#/chat');
      await expect(p.locator('.sidebar')).toBeVisible();
      await widenSidebar(p);
      await expect(projectBlock(p, book)).toBeVisible();
    },
    { waitAfter: 400 },
  );

  await manual.step(
    'Create and name a story',
    'Create a new story in **Demo Project** and rename it so it is easy to find.',
    async (p) => {
      await newStory(p, 'Demo Project');
      const renamed = await renameActiveChat(p, story);
      expect(renamed).toBe(true);
    },
    { waitAfter: 400, highlightTarget: chatItem(page, story) },
  );

  await manual.step(
    'Move the story into the book',
    'Open the story’s **Move to another environment** menu and pick the new book. The story is reassigned and now appears in that book.',
    async (p) => {
      await moveChatViaReassign(p, story, book);
      await expectChatInProject(p, story, book);
    },
    {
      waitAfter: 500,
      highlightTarget: projectBlock(page, book).locator('.chat-item').first(),
    },
  );

  await manual.generate();

  // Cleanup: remove the moved story + the book (keeps Demo Project clean).
  await deleteChatViaApi(page, story);
  await deleteProject(page, book);
});

/** Rename the ACTIVE (just-created, auto-selected) chat via its sidebar rename
 *  input. The auto title is "Demo Project – New Chat" too ambiguous to match
 *  reliably, so we target the active `.chat-item` instead. */
async function renameActiveChat(page: Page, newTitle: string): Promise<boolean> {
  const active = page.locator('.chat-item.active').first();
  await active.waitFor({ state: 'visible' });
  await active.locator('.rename-btn').click();
  const input = page.locator('.chat-title-input').first();
  await expect(input).toBeVisible();
  await input.fill(newTitle);
  await input.press('Enter');
  await expect(chatItem(page, newTitle)).toBeVisible();
  return true;
}
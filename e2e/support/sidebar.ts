import { Page, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Sidebar / app-bootstrap helpers.
//
// The sidebar is a drag-resizable pane (`.sidebar-pane` width in px, persisted
// to `chat-client.sidebar.width`, range 200–720). A narrow sidebar clips the
// project-actions row ("New story" / edit / delete books) or collapses the
// project list, so most tests widen it first. We BOTH:
//  1. seed the persisted width before the app boots (so `ChatLayoutPrefsService`
//     reads it in its constructor), and
//  2. actually drag the `.sidebar-resizer` handle to the target width — a real
//     pointer drag that exercises the same interaction a user performs.
// ---------------------------------------------------------------------------

export const SIDEBAR_WIDTH_TARGET = 640;

/** Seed the persisted sidebar width before any page script runs. */
export async function seedSidebarWidth(page: Page, width = SIDEBAR_WIDTH_TARGET): Promise<void> {
  await page.addInitScript((w) => {
    try {
      localStorage.setItem('chat-client.sidebar.width', String(w));
    } catch {
      /* ignore */
    }
  }, width);
}

/** Read the current rendered sidebar width (px). */
export async function sidebarWidth(page: Page): Promise<number> {
  return page.locator('.sidebar-pane').evaluate((el) => {
    const w = parseFloat(getComputedStyle(el).width);
    return Number.isFinite(w) ? w : -1;
  });
}

/**
 * Drag the sidebar resizer handle until the pane is at least `targetPx` wide.
 * Real pointer drag on `.sidebar-resizer` (the same interaction the UI offers).
 */
export async function widenSidebar(page: Page, targetPx = SIDEBAR_WIDTH_TARGET): Promise<void> {
  const resizer = page.locator('.sidebar-resizer');
  await resizer.waitFor({ state: 'visible' });
  const pane = page.locator('.sidebar-pane');
  await pane.waitFor({ state: 'visible' });

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = Number(await sidebarWidth(page));
    if (current >= targetPx - 1) return;

    const box = await resizer.boundingBox();
    if (!box) return;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const delta = targetPx - current;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move in steps so the pointermove handler emits successive widths.
    await page.mouse.move(startX + delta, startY, { steps: 15 });
    await page.mouse.up();
  }

  // Final assertion: the pane must now be wide (bounded by 60% of the window
  // and the 720px max — on a small viewport the target may not be reachable,
  // so assert it grew instead of exact equality).
  const final = Number(await sidebarWidth(page));
  expect(final).toBeGreaterThanOrEqual(500);
}

export async function openApp(page: Page): Promise<void> {
  // Single origin (docker-compose.e2e.yml): SPA + API + proxy on the same
  // host, so the Angular client resolves the API base from window.location.
  // Make the sidebar fully visible FIRST (drag the splitter wide), so every
  // project action ("New story" etc.) is on screen for all use cases.
  await seedSidebarWidth(page);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await widenSidebar(page);
}

// ---------------------------------------------------------------------------
// Sidebar chat-movement helpers.
//
// A story (chat) can be moved between environments ("books") on the sidebar in
// three ways, all exercised by `e2e/tests/sidebar-chat-move.spec.ts`:
//   1. the per-chat "Move to another environment" button + the reassign
//      dropdown (`reassign-select`) — including "— Unassigned —" as a target,
//   2. the per-chat "Move to Unassigned" button (ejects from an environment),
//   3. HTML5 drag & drop of the chat row onto another environment header,
// and the multi-selection toolbar (Ctrl+click → Cut → paste button in the
// target environment header) which moves a whole batch at once.
// ---------------------------------------------------------------------------

/** The sidebar project block (environment) with the given name. */
export function projectBlock(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator('.project-block').filter({ hasText: name }).first();
}

/** The header row of a project block — also the drag & drop target. */
export function projectHeader(page: Page, name: string): ReturnType<Page['locator']> {
  return projectBlock(page, name).locator('.project-header');
}

/** Expand a project block so its chat list is rendered. */
export async function expandProject(page: Page, name: string): Promise<void> {
  const block = projectBlock(page, name);
  if (!(await block.evaluate(el => el.classList.contains('expanded')))) {
    await block.locator('.project-header').click();
  }
}

/** Expand the "Unfiled stories" (unassigned) block. */
export async function expandUnassigned(page: Page): Promise<void> {
  const block = page.locator('.project-block.unassigned');
  if (!(await block.evaluate(el => el.classList.contains('expanded')))) {
    await block.locator('.project-header').click();
  }
}

/** A sidebar chat item by title. */
export function chatItem(page: Page, title: string): ReturnType<Page['locator']> {
  return page.locator('.chat-item').filter({ hasText: title }).first();
}

/** Assert a chat appears inside the given project's chat list. */
export async function expectChatInProject(
  page: Page,
  title: string,
  projectName: string,
): Promise<void> {
  await expandProject(page, projectName);
  await expect(
    projectBlock(page, projectName).locator('.chat-item').filter({ hasText: title }),
  ).toBeVisible();
}

/** Assert a chat is NOT inside the given project's chat list. */
export async function expectChatNotInProject(
  page: Page,
  title: string,
  projectName: string,
): Promise<void> {
  await expandProject(page, projectName);
  await expect(
    projectBlock(page, projectName).locator('.chat-item').filter({ hasText: title }),
  ).toHaveCount(0);
}

/** Assert a chat appears inside the "Unfiled stories" (unassigned) block. */
export async function expectChatUnassigned(page: Page, title: string): Promise<void> {
  await expandUnassigned(page);
  await expect(
    page.locator('.project-block.unassigned .chat-item').filter({ hasText: title }),
  ).toBeVisible();
}

/** Move a chat to another environment (or to unassigned) via its "Move to
 *  another environment" button + the reassign dropdown. `targetLabel` is the
 *  option label: another project's name or "— Unassigned —".
 *
 * NOTE: the `.reassign-dropdown` is a SIBLING of the `.chat-item` (it sits in
 * the `@for` loop after the item's closing `</div>`), so the select is located
 * page-wide — only one dropdown is open at a time (`toggleReassign` closes the
 * others). */
export async function moveChatViaReassign(
  page: Page,
  title: string,
  targetLabel: string,
): Promise<void> {
  const item = chatItem(page, title);
  await item.locator('.btn-icon[title="Move to another environment"]').click();
  const select = page.locator('.reassign-dropdown .reassign-select').first();
  await expect(select).toBeVisible();
  await select.selectOption({ label: targetLabel });
  await expect(page.locator('.reassign-dropdown')).toHaveCount(0);
}

/** Eject a chat out of its environment into "Unfiled stories" via the "Move to
 *  Unassigned" button. */
export async function moveChatToUnassigned(page: Page, title: string): Promise<void> {
  const item = chatItem(page, title);
  await item.locator('.btn-icon[title="Move to Unassigned"]').click();
}

/** Move a chat to another environment by HTML5-dragging its row onto the target
 *  environment header (the drag & drop target). */
export async function dragChatToProject(
  page: Page,
  title: string,
  targetProject: string,
): Promise<void> {
  const source = chatItem(page, title).locator('.chat-title');
  const target = projectHeader(page, targetProject);
  await source.dragTo(target);
}

/** Ctrl+click a chat item — toggles multi-selection on the sidebar. */
export async function ctrlClickChat(page: Page, title: string): Promise<void> {
  // Click the title TEXT (left part of the `.chat-title` span) so the click
  // never lands on the trailing rename button inside the same span.
  const span = chatItem(page, title).locator('.chat-title');
  await span.click({ modifiers: ['Control'], position: { x: 20, y: 8 } });
}

/** Click the multi-selection toolbar's "Cut" button (stages a move). */
export async function cutSelectedChats(page: Page): Promise<void> {
  await page.locator('.story-tools .btn.small').filter({ hasText: 'Cut' }).click();
}

/** Click the "Paste the clipboard into this environment" button of a project header. */
export async function pasteIntoProject(page: Page, projectName: string): Promise<void> {
  await projectHeader(page, projectName).locator('.paste-btn').click();
}

/** Assert the multi-selection toolbar reports the given selected count. */
export async function expectSelectionCount(page: Page, n: number): Promise<void> {
  await expect(page.locator('.story-tools')).toBeVisible();
  await expect(page.locator('.story-selection-info')).toContainText(`${n} selected`);
}

/** Cancel a staged cut/copy (nothing moved, nothing deleted). */
export async function cancelClipboard(page: Page): Promise<void> {
  await page.locator('.story-tools .btn.small').filter({ hasText: 'Cancel' }).click();
}

/**
 * Delete a chat via the API by title. Teardown-only: the USE-CASE steps of a
 * spec stay UI-driven; removing leftover data through the API is far more
 * robust than clicking the sidebar's delete button (an Angular re-render loop
 * detaches the row of an unassigned/current chat mid-click).
 */
export async function deleteChatViaApi(page: Page, title: string): Promise<void> {
  const res = await page.request.get('/api/chats');
  if (!res.ok()) return;
  const chats = (await res.json()) as Array<{ id: string; title: string }>;
  const chat = chats.find((c) => c.title === title);
  if (!chat) return;
  await page.request.delete(`/api/chats/${chat.id}`);
}

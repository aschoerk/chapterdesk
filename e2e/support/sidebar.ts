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

/**
 * Ensure a project block is expanded and its chat list is rendered.
 *
 * The app uses zoneless change detection, so the expanded state is applied
 * ASYNCHRONOUSLY after a header click — and, crucially, after an AUTO-expand
 * triggered by a paste/drop that is still in flight. Reading the DOM class too
 * early returns a STALE collapsed state, and clicking the header then toggles
 * the (about-to-be-expanded) block back to collapsed (`toggleExpanded` reads
 * the already-updated signal, not the stale DOM). Callers that count or step
 * through `.chat-item`s on the next line would otherwise race.
 *
 * NOTE: the UNASSIGNED block never receives the `expanded` class — it is
 * absent from its template binding — so we anchor on the `.chat-list` being
 * rendered, which is the actual functional signal of "expanded".
 */
async function ensureBlockExpanded(
  page: Page,
  block: ReturnType<Page['locator']>,
): Promise<void> {
  await expect(async () => {
    if (await block.locator('.chat-list').count() === 0) {
      await block.locator('.project-header').click();
    }
    // The list must be rendered…
    await expect(block.locator('.chat-list')).toBeAttached({ timeout: 1_000 });
    // …and STAY rendered. An auto-expand from a paste/drop can still be in
    // flight and late-toggle the block back closed right after we see the
    // list (zoneless: the paste's `toggleExpanded` reads the signal, which
    // our earlier click may have already flipped to "open" → it closes it).
    // Requiring the list to survive a short settle makes the helper converge
    // to a STABLE open state instead of returning mid-race.
    await page.waitForTimeout(250);
    await expect(block.locator('.chat-list')).toBeAttached({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Expand a project block so its chat list is rendered. */
export async function expandProject(page: Page, name: string): Promise<void> {
  await ensureBlockExpanded(page, projectBlock(page, name));
}

/**
 * Expand the "Unfiled stories" (unassigned) block.
 *
 * Unlike a named project, the unassigned block is CONDITIONALLY rendered:
 * `@if (getChatsForProject(null).length > 0)` mounts the whole block (header
 * included) only when there is at least one unassigned chat. Right after a
 * move-to-unassigned the chat list updates asynchronously (zoneless), so the
 * block can be torn down and re-mounted mid-expansion — clicking its header
 * too early sees a stale/recreating element. We therefore wait for the block
 * to be attached (which implies it has a chat), then expand it.
 */
export async function expandUnassigned(page: Page): Promise<void> {
  const block = page.locator('.project-block.unassigned');
  await expect(block).toBeAttached({ timeout: 10_000 });
  await ensureBlockExpanded(page, block);
}

/** A sidebar chat item by title. */
export function chatItem(page: Page, title: string): ReturnType<Page['locator']> {
  return page.locator('.chat-item').filter({ hasText: title }).first();
}

/**
 * Assert a chat appears inside the given project's chat list.
 *
 * Converges: a paste/drop auto-expands the target, but a LATE auto-expand
 * toggle can collapse it right after (zoneless — `toggleExpanded` reads the
 * signal while the DOM lags), so the chat may vanish between expand and
 * assertion. Re-expanding and re-checking until stable removes the race.
 */
export async function expectChatInProject(
  page: Page,
  title: string,
  projectName: string,
): Promise<void> {
  const item = projectBlock(page, projectName).locator('.chat-item').filter({ hasText: title });
  await expect(async () => {
    await expandProject(page, projectName);
    await expect(item).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Assert a chat is NOT inside the given project's chat list. */
export async function expectChatNotInProject(
  page: Page,
  title: string,
  projectName: string,
): Promise<void> {
  const item = projectBlock(page, projectName).locator('.chat-item').filter({ hasText: title });
  await expect(async () => {
    await expandProject(page, projectName);
    await expect(item).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Assert a chat appears inside the "Unfiled stories" (unassigned) block. */
export async function expectChatUnassigned(page: Page, title: string): Promise<void> {
  const item = page.locator('.project-block.unassigned .chat-item').filter({ hasText: title });
  await expect(async () => {
    await expandUnassigned(page);
    await expect(item).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
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

/**
 * Delete every story in a project except a keep-list, via the API.
 * Teardown-only cleanup: the shared "Demo Project" accumulates stray stories
 * from many specs in the full suite, which pushes the sidebar's scroll window
 * down. For the DRAG tests this matters — see the `dragChatTo*` docs.
 */
export async function deleteProjectStoriesExcept(
  page: Page,
  projectName: string,
  keepTitles: string[],
): Promise<void> {
  const projectsRes = await page.request.get('/api/projects');
  if (!projectsRes.ok()) return;
  const projects = (await projectsRes.json()) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === projectName);
  if (!project) return;

  const chatsRes = await page.request.get('/api/chats');
  if (!chatsRes.ok()) return;
  const chats = (await chatsRes.json()) as Array<{ id: string; title: string; projectId: string | null }>;
  for (const chat of chats) {
    if (chat.projectId === project.id && !keepTitles.includes(chat.title)) {
      await page.request.delete(`/api/chats/${chat.id}`);
    }
  }
}

/**
 * Move a chat to a target by dragging its row onto the target header (the
 * drag & drop target). `targetHeader`/`targetBlock` let the caller point at
 * either a named environment OR the "Unfiled stories" (unassigned) block.
 *
 * Two strategies, in order:
 *
 * 1. REAL pointer drag (`locator.dragTo`) — used when BOTH the source chat and
 *    the target header are actually inside the visible `.project-list`
 *    viewport. This exercises the true HTML5 drag UX.
 *
 * 2. DETERMINISTIC synthetic HTML5 drag (`dragstart` → `dragenter` →
 *    `dragover` → `drop` → `dragend` dispatched in-page with a real
 *    `DataTransfer`) — the fallback when either element is scrolled out of the
 *    visible list. When the sidebar has many expanded stories, the source chat
 *    and/or the target environment can sit BELOW the fold; Playwright's
 *    `dragTo` auto-scrolls BOTH elements, but with both inside the same
 *    `.project-list` scroll container its scroll-into-view thrashes and times
 *    out (reproduced: 26 stories + target header at y>1000 → `dragTo` threw
 *    "Timeout 5000ms exceeded" and no drop registered). The synthetic events
 *    still run the app's REAL Angular drag handlers (`onChatDragStart` /
 *    `onDragOver` / `onDropEnvironment`), so the drop logic is fully exercised —
 *    only the visual ghost drag is skipped.
 *
 * In both cases the helper does NOT return until the move actually completed:
 * the chat is present in the target AND gone from the source (the app's
 * `reassignChat` is a real move, so a successful drop must remove it from the
 * source). If the first strategy doesn't satisfy that, it retries with the
 * other.
 */
async function dragTo(
  page: Page,
  title: string,
  sourceProject: string,
  targetHeader: ReturnType<Page['locator']>,
  targetBlock: ReturnType<Page['locator']>,
  targetLabel: string,
): Promise<void> {
  const source = chatItem(page, title).locator('.chat-title');

  await expect(source).toBeAttached();
  await expect(targetHeader).toBeAttached();

  const sourceBlock = projectBlock(page, sourceProject);
  const done = async (): Promise<boolean> => {
    const inTarget = await targetBlock.locator('.chat-item').filter({ hasText: title }).count();
    const inSource = await sourceBlock.locator('.chat-item').filter({ hasText: title }).count();
    return inTarget > 0 && inSource === 0;
  };

  // Order the strategies: real drag first when both are on screen, then the
  // deterministic synthetic drag as a retry.
  const realFirst = await withinListViewport(page, source) && await withinListViewport(page, targetHeader);
  const order = realFirst ? (['real', 'synthetic'] as const) : (['synthetic'] as const);

  for (const kind of order) {
    try {
      if (kind === 'real') {
        await source.dragTo(targetHeader, { timeout: 5_000 });
      } else {
        await syntheticDrag(page, source, targetHeader);
      }
      await expect.poll(done, { timeout: 6_000 }).toBe(true);
      return;
    } catch {
      // Try the next strategy (or surface the last failure below).
    }
  }

  throw new Error(
    `drag: moving chat "${title}" onto "${targetLabel}" did not move (still in source "${sourceProject}"); target/source may be scrolled out of the sidebar list`,
  );
}

/** Drag a chat onto a named environment header. */
export async function dragChatToProject(
  page: Page,
  title: string,
  targetProject: string,
  sourceProject: string,
): Promise<void> {
  await dragTo(
    page,
    title,
    sourceProject,
    projectHeader(page, targetProject),
    projectBlock(page, targetProject),
    targetProject,
  );
}

/** Drag a chat onto the "Unfiled stories" (unassigned) block header. */
export async function dragChatToUnassigned(
  page: Page,
  title: string,
  sourceProject: string,
): Promise<void> {
  const unassigned = page.locator('.project-block.unassigned');
  await dragTo(page, title, sourceProject, unassigned.locator('.project-header'), unassigned, 'Unfiled stories');
}

/** Deterministic in-page HTML5 drag: `dragstart` on the source, `dragenter` /
 *  `dragover` / `drop` on the target, `dragend` back on the source — reusing a
 *  single `DataTransfer` so `onChatDragStart.setData` reaches `readDragIds`. */
async function syntheticDrag(
  page: Page,
  source: ReturnType<Page['locator']>,
  target: ReturnType<Page['locator']>,
): Promise<void> {
  await source.evaluate((el) => {
    const dt = new DataTransfer();
    (window as unknown as Record<string, unknown>).__cdDrag = dt;
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await target.evaluate((el) => {
    const dt = (window as unknown as Record<string, unknown>).__cdDrag as DataTransfer;
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await source.evaluate((el) => {
    const dt = (window as unknown as Record<string, unknown>).__cdDrag as DataTransfer;
    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    delete (window as unknown as Record<string, unknown>).__cdDrag;
  });
}

/** True when `locator` is fully inside the visible (clipped) `.project-list`
 *  viewport — i.e. actually on screen and not scrolled below the fold. */
async function withinListViewport(
  page: Page,
  locator: ReturnType<Page['locator']>,
): Promise<boolean> {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((el) => {
    const list = el.closest('.project-list');
    if (!list) return true; // not inside a scroll list → assume visible
    const lr = list.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.top >= lr.top - 1 && er.bottom <= lr.bottom + 1;
  }).catch(() => false);
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

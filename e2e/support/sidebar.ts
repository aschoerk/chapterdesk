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

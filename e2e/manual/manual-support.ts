// ---------------------------------------------------------------------------
// Shared support for the USER-MANUAL scenarios (e2e/manual/*).
//
// These specs are NOT part of the assertion test-suite (`testDir` is
// ./e2e/tests, so `npx playwright test` / coverage never pick them up). They
// choreograph the real UI a step at a time and record annotated screenshots
// into docs/manuals/ via playwright-scenario-recorder
// (https://www.npmjs.com/package/playwright-scenario-recorder).
//
// Run them with:  npm run docs:manual
// ---------------------------------------------------------------------------

import { Page } from '@playwright/test';
import { ScenarioRecorder } from 'playwright-scenario-recorder';

/** Where the generated manual (markdown + screenshots) is written.
 *  Relative to the repo root (process.cwd() when playwright runs). */
export const MANUAL_DIR = './docs/manuals';

/**
 * Create a scenario recorder configured for the ChapterDesk manual (English,
 * Markdown only). `hideOverlaySelectors: []` disables the Next.js-specific
 * defaults baked into the package.
 */
export function newManual(
  page: Page,
  scenarioName: string,
  title: string,
): ScenarioRecorder {
  return new ScenarioRecorder(page, scenarioName, title, MANUAL_DIR, {
    locale: 'en',
    outputFormat: 'md',
    hideOverlaySelectors: [],
  });
}

// ---------------------------------------------------------------------------
// API-based cleanup helpers (teardown only — the manual steps themselves are
// pure UI). Deleting through the REST API avoids the flaky card-menu → delete
// click race (an Angular re-render detaches the freshly-opened menu) that
// plagues the CRUD helpers on repeated runs.
// ---------------------------------------------------------------------------

/** Delete a topic by name via the API (no-op when absent). */
export async function deleteTopicViaApi(page: Page, name: string): Promise<void> {
  await deleteByTitle(
    page,
    '/api/topics',
    'DELETE /api/topics/:id',
    name,
  );
}

/** Delete a persona by name via the API (no-op when absent). */
export async function deletePersonaViaApi(page: Page, name: string): Promise<void> {
  await deleteByTitle(
    page,
    '/api/personas',
    'DELETE /api/personas/:id',
    name,
  );
}

/** Generic: find an entity by title and DELETE it. */
async function deleteByTitle(
  page: Page,
  listUrl: string,
  deleteUrl: string,
  name: string,
): Promise<void> {
  const res = await page.request.get(listUrl);
  if (!res.ok()) return;
  const rows = (await res.json()) as Array<{ id: string; name: string }>;
  const row = rows.find((r) => r.name === name);
  if (!row) return;
  await page.request.delete(deleteUrl.replace(':id', row.id));
}
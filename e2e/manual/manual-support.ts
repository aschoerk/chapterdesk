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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_INTROS } from './manual-intros';

/** Where the generated manual (markdown + screenshots) is written.
 *  Relative to the repo root (process.cwd() when playwright runs). */
export const MANUAL_DIR = './docs/manuals';

/**
 * Create a scenario recorder configured for the ChapterDesk manual (English,
 * Markdown only). `hideOverlaySelectors: []` disables the Next.js-specific
 * defaults baked into the package.
 *
 * `intro` controls the formatted explanation rendered right below the page
 * title (after the "Auto-generated on …" line), before the first step:
 *
 *   - a non-empty `string` → rendered verbatim, overriding the auto-generated
 *     default for this scenario;
 *   - `false` (or an empty string) → no intro at all;
 *   - `undefined` → falls back to the auto-generated default from
 *     `DEFAULT_INTROS` in ./manual-intros.ts.
 *
 * Overriding a default for a single run is as simple as passing a different
 * string here; to change the default for everyone, edit `DEFAULT_INTROS`.
 */
export function newManual(
  page: Page,
  scenarioName: string,
  title: string,
  intro?: string | false,
): ScenarioRecorder {
  const recorder = new ScenarioRecorder(page, scenarioName, title, MANUAL_DIR, {
    locale: 'en',
    outputFormat: 'md',
    hideOverlaySelectors: [],
  });

  const introText = resolveIntro(scenarioName, intro);
  if (introText === null) return recorder;

  // The recorder always rewrites the markdown on generate(); we post-process
  // the file to drop the intro between the title and the first step.
  const originalGenerate = recorder.generate.bind(recorder);
  recorder.generate = async () => {
    await originalGenerate();
    const mdPath = join(MANUAL_DIR, `${scenarioName}.md`);
    if (!existsSync(mdPath)) return;
    const lines = readFileSync(mdPath, 'utf8').split('\n');
    // Anchor on the "> Auto-generated on …" blockquote right below the title.
    // The recorder leaves a blank line right after it, which becomes the
    // separator between the blockquote and the intro paragraph.
    const anchor = lines.findIndex((l) => l.trim().startsWith('> '));
    if (anchor >= 0) {
      lines.splice(anchor + 1, 0, '', introText);
      writeFileSync(mdPath, lines.join('\n'));
    }
  };

  return recorder;
}

/**
 * Resolve the intro for a scenario: an explicit non-empty argument wins over
 * the auto-generated default; `false` / an empty string suppress it entirely.
 */
function resolveIntro(scenarioName: string, intro?: string | false): string | null {
  if (intro === false || (typeof intro === 'string' && !intro.trim())) return null;
  if (typeof intro === 'string') return intro.trim();
  return DEFAULT_INTROS[scenarioName]?.trim() || null;
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
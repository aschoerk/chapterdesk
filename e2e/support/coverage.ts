// ---------------------------------------------------------------------------
// E2E V8 coverage harvester.
//
// When E2E_COVERAGE=1 is set, this fixture starts JS coverage collection on
// every page (Chromium-only — the project already restricts to chromium),
// stops it after the test, downloads each script's .map DURING the run (the
// docker e2e webServer is up then), and writes the raw V8 coverage JSON to
// .e2e-coverage-raw/<testId>.json.
//
// The raw files are merged with the Angular unit coverage by
// 0scripts/merge-coverage.mjs (v8-to-istanbul + istanbul-lib-*).
// ---------------------------------------------------------------------------

import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COVERAGE_ENABLED = process.env.E2E_COVERAGE === '1';
const RAW_DIR = join(process.cwd(), '.e2e-coverage-raw');

/** A single Chromium `page.coverage` entry with its source map attached. */
interface CoverageEntryWithMap {
  url: string;
  source?: string;
  functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }>; isBlockCoverage: boolean }>;
  map: unknown;
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    if (!COVERAGE_ENABLED) {
      await use(page);
      return;
    }

    // resetOnNavigation: false keeps collected coverage across SPA route
    // changes so a single test's whole session contributes.
    await page.coverage.startJSCoverage({ resetOnNavigation: false });

    await use(page);

    const entries = await page.coverage.stopJSCoverage();

    // Download the matching .map for each script while the e2e server is still
    // up. Files without a map are kept (the merger skips them) — e.g. inline
    // scripts with no .map sibling. Use the browser context request so it
    // shares cookies/baseURL with the page.
    const withMaps: CoverageEntryWithMap[] = await Promise.all(
      entries.map(async (entry) => {
        let map: unknown = null;
        try {
          const res = await page.context().request.get(`${entry.url}.map`);
          if (res.ok()) map = await res.json();
        } catch {
          /* no map available */
        }
        return {
          url: entry.url,
          source: entry.source,
          functions: entry.functions,
          map,
        };
      }),
    );

    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(join(RAW_DIR, `${testInfo.testId}.json`), JSON.stringify(withMaps));
  },
});

export { expect };

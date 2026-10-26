// ---------------------------------------------------------------------------
// Playwright config for the USER-MANUAL generator (e2e/manual).
//
// Reuses everything from the main playwright.config.ts (single-origin Docker
// webServer on :8081, the chromium-only "Desktop Chrome" project, reporter),
// but points testDir at e2e/manual so the manual specs are NOT picked up by
// the regular e2e / coverage runs (which use testDir: ./e2e/tests).
//
// Run with:  npm run docs:manual
// ---------------------------------------------------------------------------

import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  testDir: './e2e/manual',
});
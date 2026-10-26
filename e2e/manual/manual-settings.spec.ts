// ---------------------------------------------------------------------------
// USER MANUAL — "Settings: Appearance, Providers, Tasks and Prompts".
//
// Generates docs/manuals/manual-settings.md + screenshots. Walks through the
// /config pages by clicking the Settings navigation items.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { openApp } from '../support/ui';
import { newManual } from './manual-support';

/** Click the Settings nav item of the given label and wait for it to activate. */
async function openConfigTab(
  page: import('@playwright/test').Page,
  label: string,
): Promise<void> {
  const item = page.locator('.config-nav-item').filter({ hasText: label }).first();
  await item.click();
  await expect(item).toHaveClass(/active/);
  await expect(page.locator('.config-shell')).toBeVisible();
}

test('Settings: Appearance, Providers, Tasks and Prompts', async ({ page }) => {
  const manual = newManual(
    page,
    'manual-settings',
    'Settings: Appearance, Providers, Tasks and Prompts',
  );

  await manual.step(
    'Open the application',
    'Launch ChapterDesk.',
    (p) => openApp(p),
    { waitAfter: 400 },
  );

  await manual.step(
    'Open Settings',
    'Use the **Settings** link in the top navigation. The **Appearance** page opens first — theme and language are stored per browser.',
    async (p) => {
      await p.goto('/#/config/appearance');
      await expect(p.locator('.config-shell')).toBeVisible();
    },
    { waitAfter: 500 },
  );

  await manual.step(
    'AI providers',
    'The **Providers / Models** page manages AI providers and enables the models ChapterDesk may call.',
    (p) => openConfigTab(p, 'Providers / Models'),
    { waitAfter: 500 },
  );

  await manual.step(
    'Generation tasks',
    '**Generation Tasks** picks which enabled model is used for each kind of writing task (title, headings, language check, images…).',
    (p) => openConfigTab(p, 'Generation Tasks'),
    { waitAfter: 500 },
  );

  await manual.step(
    'Prompt defaults',
    '**Prompt defaults** lets you read, edit or version the built-in prompts ChapterDesk builds automatically.',
    (p) => openConfigTab(p, 'Prompt defaults'),
    { waitAfter: 500 },
  );

  await manual.generate();
});
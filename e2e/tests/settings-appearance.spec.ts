// ---------------------------------------------------------------------------
// SETTINGS — Appearance (theme + language).
//
// Theme and language are localStorage-backed (per browser context, fresh for
// every test), so these usecases need no server cleanup:
//   - theme presets: System (OS-following) / White / Dark, resolved on <html>
//     and persisted across reloads.
//   - language: English / Deutsch re-labels the whole UI and persists.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  expectLocale,
  expectResolvedTheme,
  gotoAppearance,
  selectThemeOption,
} from '../support/ui';

test.describe('settings: appearance (theme + language)', () => {
  test('01 theme defaults to System; choosing Dark/White applies and persists', async ({ page }) => {
    await gotoAppearance(page);

    // Default: the System preset is selected and resolves to the OS scheme.
    const system = page.locator('.theme-option').filter({ hasText: 'System' }).first();
    await expect(system.locator('input[type="radio"]')).toBeChecked();
    // Fresh context resolves light (headless, no dark OS preference).
    await expectResolvedTheme(page, 'light');

    // Choose Dark → applied immediately.
    await selectThemeOption(page, 'Dark');
    await expectResolvedTheme(page, 'dark');

    // Persisted across reloads.
    await page.reload();
    await expect(page.locator('.config-shell')).toBeVisible();
    await expectResolvedTheme(page, 'dark');

    // Choose White → applied + persisted.
    await selectThemeOption(page, 'White');
    await expectResolvedTheme(page, 'light');
    await page.reload();
    await expect(page.locator('.config-shell')).toBeVisible();
    await expectResolvedTheme(page, 'light');

    // Back to System → follows the OS again (light in the test env).
    await selectThemeOption(page, 'System');
    await expectResolvedTheme(page, 'light');
  });

  test('02 switching to Deutsch re-labels the UI and persists', async ({ page }) => {
    await gotoAppearance(page);
    await expectLocale(page, 'en');

    // The appearance title in the default language.
    await expect(page.locator('.section h2').filter({ hasText: 'Appearance' }).first()).toBeVisible();

    await selectThemeOption(page, 'Deutsch');
    await expectLocale(page, 'de');

    // The UI re-labels: config sidebar shows the German nav title and the
    // appearance section header switches to "Darstellung".
    await expect(page.locator('.section h2').filter({ hasText: 'Darstellung' }).first()).toBeVisible();
    const providersNav = page.locator('.config-nav-item').filter({ hasText: 'Anbieter / Modelle' }).first();
    await expect(providersNav).toBeVisible();

    // Persists across reloads.
    await page.reload();
    await expect(page.locator('.config-shell')).toBeVisible();
    await expectLocale(page, 'de');
    await expect(page.locator('.config-nav-item').filter({ hasText: 'Anbieter / Modelle' }).first()).toBeVisible();

    // Cleanup for the shared browser profile: back to English.
    await selectThemeOption(page, 'English');
    await expectLocale(page, 'en');
  });

  test('03 switching back to English restores English labels', async ({ page }) => {
    // Force German up-front (as if a previous session left it), then switch back.
    await page.addInitScript(() => localStorage.setItem('chat.view.locale', 'de'));
    await gotoAppearance(page);
    await expectLocale(page, 'de');

    await selectThemeOption(page, 'English');
    await expectLocale(page, 'en');
    await expect(page.locator('.section h2').filter({ hasText: 'Appearance' }).first()).toBeVisible();
    const providersNav = page.locator('.config-nav-item').filter({ hasText: 'Providers / Models' }).first();
    await expect(providersNav).toBeVisible();
  });
});

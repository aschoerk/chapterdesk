import { Page, expect } from '@playwright/test';
import { formControl } from './forms';

// ---------------------------------------------------------------------------
// Settings / configuration page helpers (the /config/* subpages: Appearance,
// Providers & Models, Generation Tasks, Prompt defaults).
//
// These operate purely on the config page DOM. Provider/model data lives on
// the shared in-memory API  (seeded from e2e/fixtures/seed.json + the Docker
// "Mock (no key)" bootstrap), so provider/preset tests use unique names and
// delete what they create — mirroring the CRUD spec conventions. Theme,
// locale, generation tasks and topic selection are localStorage-backed and
// isolated per browser context (fresh for every test).
// ---------------------------------------------------------------------------

// ---- navigation -----------------------------------------------------------

/** Navigate to a /config/:sub page and wait for the config shell to render. */
export async function gotoConfig(page: Page, sub: 'appearance' | 'providers' | 'tasks' | 'prompts'): Promise<void> {
  await page.goto(`/#/config/${sub}`);
  await expect(page.locator('.config-shell')).toBeVisible();
}

export async function gotoAppearance(page: Page): Promise<void> {
  await gotoConfig(page, 'appearance');
}

export async function gotoProviders(page: Page): Promise<void> {
  await gotoConfig(page, 'providers');
}

export async function gotoGenerationTasks(page: Page): Promise<void> {
  await gotoConfig(page, 'tasks');
}

export async function gotoPromptDefaults(page: Page): Promise<void> {
  await gotoConfig(page, 'prompts');
}

/** Click a config sidebar tab (in-SPA navigation keeps in-memory state). */
export async function clickConfigNav(page: Page, label: string): Promise<void> {
  const item = page.locator('.config-nav-item').filter({ hasText: label }).first();
  await item.click();
  await expect(item).toHaveClass(/active/);
}

// ---- Appearance: theme + language ----------------------------------------

export function themeOption(page: Page, label: string): ReturnType<Page['locator']> {
  return page.locator('.theme-option').filter({ hasText: label }).first();
}

/** Select a theme / locale radio by its label (White/Dark/System/English/Deutsch). */
export async function selectThemeOption(page: Page, label: string): Promise<void> {
  await themeOption(page, label).locator('input[type="radio"]').check({ force: true });
}

/** Assert the visible resolved theme + the <html data-theme> attribute. */
export async function expectResolvedTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await expect(page.locator('.theme-resolved')).toHaveText(`Active: ${theme}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

export async function expectLocale(page: Page, locale: 'en' | 'de'): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

// ---- Providers ------------------------------------------------------------

export function providerCard(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator('.provider-card').filter({ hasText: name }).first();
}

/** Click a card-header action (Test / Fetch Models / Edit / Delete). */
export async function providerCardAction(page: Page, name: string, action: string): Promise<void> {
  const card = providerCard(page, name);
  await card.locator('.card-header .actions .btn').filter({ hasText: action }).click();
}

/** Open the "Add Provider" modal (page must already be on /config/providers). */
export async function openAddProviderModal(page: Page): Promise<ReturnType<Page['locator']>> {
  await page
    .locator('.section-header')
    .filter({ hasText: 'Providers' })
    .locator('button.btn.primary')
    .click();
  const modal = page.locator('.modal-backdrop .modal');
  await expect(modal).toBeVisible();
  return modal;
}

/** Open the "Add Preset" modal. */
export async function openAddPresetModal(page: Page): Promise<ReturnType<Page['locator']>> {
  await page
    .locator('.section-header')
    .filter({ hasText: 'Models' })
    .locator('button.btn.primary')
    .click();
  const modal = page.locator('.modal-backdrop .modal');
  await expect(modal).toBeVisible();
  return modal;
}

/**
 * Add a provider through the UI. Waits for the provider card to appear.
 * `apiKey` is required by the form (native alert otherwise).
 */
export async function addProvider(
  page: Page,
  opts: { name: string; baseUrl?: string; apiKey?: string; type?: string },
): Promise<void> {
  await gotoProviders(page);
  const modal = await openAddProviderModal(page);
  await formControl(page, modal, 'Name', 'input').fill(opts.name);
  if (opts.type) {
    await formControl(page, modal, 'Type', 'select').selectOption({ label: opts.type });
  }
  if (opts.baseUrl) await formControl(page, modal, 'Base URL', 'input').fill(opts.baseUrl);
  if (opts.apiKey !== undefined) await formControl(page, modal, 'API Key', 'input').fill(opts.apiKey);
  await modal.locator('.modal-actions .btn.primary').click();
  await expect(providerCard(page, opts.name)).toBeVisible();
}

/** Edit a provider's name / base URL through the UI. */
export async function editProvider(
  page: Page,
  name: string,
  next: { name?: string; baseUrl?: string },
): Promise<void> {
  await gotoProviders(page);
  await providerCardAction(page, name, 'Edit');
  const modal = page.locator('.modal-backdrop .modal');
  await expect(modal).toBeVisible();
  if (next.name) await formControl(page, modal, 'Name', 'input').fill(next.name);
  if (next.baseUrl) await formControl(page, modal, 'Base URL', 'input').fill(next.baseUrl);
  await modal.locator('.modal-actions .btn.primary').click();
  const expected = next.name ?? name;
  await expect(providerCard(page, expected)).toBeVisible();
}

/** Delete a provider (native confirm), asserting the card is gone. */
export async function deleteProvider(page: Page, name: string): Promise<void> {
  await gotoProviders(page);
  page.once('dialog', (dialog) => dialog.accept());
  await providerCardAction(page, name, 'Delete');
  await expect(providerCard(page, name)).toHaveCount(0);
}

// ---- Models / presets ------------------------------------------------------

export function modelRow(page: Page, displayName: string): ReturnType<Page['locator']> {
  return page.locator('.models-table tbody tr').filter({ hasText: displayName }).first();
}

/**
 * Add a preset through the UI (display name + model id + provider).
 * `modalities` optionally toggles input/output chips: { in: ['image'], out: ['image','text'] }.
 */
export async function addPreset(
  page: Page,
  opts: {
    displayName: string;
    modelId: string;
    providerName: string;
    modalities?: { in?: string[]; out?: string[] };
  },
): Promise<void> {
  await gotoProviders(page);
  const modal = await openAddPresetModal(page);
  await formControl(page, modal, 'Display Name', 'input').fill(opts.displayName);
  await formControl(page, modal, 'Model ID', 'input').fill(opts.modelId);
  await formControl(page, modal, 'Provider', 'select').selectOption({ label: opts.providerName });

  for (const m of opts.modalities?.in ?? []) {
    await modal
      .locator('.modality-row')
      .filter({ hasText: 'In' })
      .locator('button.chip')
      .filter({ hasText: m })
      .click();
  }
  for (const m of opts.modalities?.out ?? []) {
    await modal
      .locator('.modality-row')
      .filter({ hasText: 'Out' })
      .locator('button.chip')
      .filter({ hasText: m })
      .click();
  }

  await modal.locator('.modal-actions .btn.primary').click();
  await expect(modelRow(page, opts.displayName)).toBeVisible();
}

/** Delete a preset/model via its table row danger button. */
export async function deletePreset(page: Page, displayName: string): Promise<void> {
  await gotoProviders(page);
  const row = modelRow(page, displayName);
  await row.locator('button.btn.small.danger').click();
  await expect(modelRow(page, displayName)).toHaveCount(0);
}

/** Toggle the enabled checkbox of a model row; returns the new state. */
export async function toggleModelEnabled(page: Page, displayName: string): Promise<boolean> {
  await gotoProviders(page);
  const row = modelRow(page, displayName);
  const cb = row.locator('input[type="checkbox"]');
  await cb.click();
  const checked = await cb.isChecked();
  return checked;
}

// ---- Provider-catalog wiremock (via the /proxy) ---------------------------

export interface MockCatalogModel {
  id: string;
  name?: string;
}

/**
 * Mock the provider-catalog proxy endpoints the settings page uses:
 *   GET /proxy/models      (provider connection test + fetch models)
 *   GET /proxy/images/models (OpenRouter image-catalog merge)
 * Returns `{"data": [...]}`. Pass `failWith` to simulate a failing provider.
 */
export async function mockProviderModels(
  page: Page,
  models: MockCatalogModel[] = [],
  opts?: { failWith?: number },
): Promise<void> {
  const data = models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    object: 'model',
    owned_by: 'e2e',
  }));

  const fulfill = async (route: import('@playwright/test').Route) => {
    if (opts?.failWith) {
      await route.fulfill({
        status: opts.failWith,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Connection refused by mock' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data }),
    });
  };

  await page.route('**/proxy/models', fulfill);
  await page.route('**/proxy/images/models', fulfill);
}

// ---- Generation tasks -----------------------------------------------------

export function taskCard(page: Page, label: string): ReturnType<Page['locator']> {
  return page.locator('.gen-task-card').filter({ hasText: label }).first();
}

/** The provider <select> inside a task card. */
export function taskProviderSelect(page: Page, label: string): ReturnType<Page['locator']> {
  return taskCard(page, label).locator('.gen-field select').first();
}

/** The model <input> inside a task card. */
export function taskModelInput(page: Page, label: string): ReturnType<Page['locator']> {
  return taskCard(page, label).locator('.gen-field input').first();
}

/** The prompt <textarea> inside a task card. */
export function taskPromptTextarea(page: Page, label: string): ReturnType<Page['locator']> {
  return taskCard(page, label).locator('.gen-field textarea').first();
}

/** Reset a task card back to inherit / empty (enabled once a task is set). */
export async function resetTask(page: Page, label: string): Promise<void> {
  await taskCard(page, label).locator('.card-header .btn.small').click();
  await expect(taskModelInput(page, label)).toHaveValue('');
  await expect(taskProviderSelect(page, label)).toHaveValue('');
}

/** Configure a task's provider/model/prompt (model select via datalist input). */
export async function setTask(
  page: Page,
  label: string,
  opts: { providerName?: string; modelId?: string; prompt?: string },
): Promise<void> {
  if (opts.providerName) {
    await taskProviderSelect(page, label).selectOption({ label: opts.providerName });
  }
  if (opts.modelId) {
    await taskModelInput(page, label).fill(opts.modelId);
  }
  if (opts.prompt !== undefined && opts.prompt !== '') {
    await taskPromptTextarea(page, label).fill(opts.prompt);
  }
}

// ---- Prompt defaults ------------------------------------------------------

export function promptCard(page: Page, label: string): ReturnType<Page['locator']> {
  return page.locator('.prompt-card').filter({ hasText: label }).first();
}

export function promptTextarea(page: Page, label: string): ReturnType<Page['locator']> {
  return promptCard(page, label).locator('textarea.prompt-text');
}

/** The "Using:" source label of a prompt card. */
export function promptSourceLabel(page: Page, label: string): ReturnType<Page['locator']> {
  return promptCard(page, label).locator('.prompt-source-label');
}

/** Click "Save as version…" and fill + confirm the inline version form. */
export async function saveAsVersion(
  page: Page,
  label: string,
  name: string,
  scope?: 'user' | 'topic',
): Promise<void> {
  await promptCard(page, label).locator('.prompt-version-row .btn').filter({ hasText: 'Save as version' }).click();
  const form = promptCard(page, label).locator('.prompt-new-version');
  await expect(form).toBeVisible();
  await form.locator('input[type="text"]').fill(name);
  if (scope === 'topic') {
    // The scope <select> options are literal values 'user' / 'topic'.
    await form.locator('select').selectOption('topic');
  }
  await form.locator('button.btn.primary').click();
  // "Create & use" is async (create + select + discard draft). The inline
  // form only closes after it resolves — wait for it so a follow-up edit of
  // the textarea does not race with the internal draft-discard.
  await expect(form).toHaveCount(0);
}

// --- prompt versions  ------------------------------------------------------

export function promptVersionsList(page: Page, label: string): ReturnType<Page['locator']> {
  return promptCard(page, label).locator('details.prompt-versions');
}

/** Open a card's "All versions" <details>. */
export async function openPromptVersions(page: Page, label: string): Promise<void> {
  const details = promptVersionsList(page, label);
  const summary = details.locator('summary').first();
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await summary.click();
  }
  await expect(details.locator('.prompt-version-item').first()).toBeVisible();
}

export function promptVersionItem(page: Page, label: string, versionName: string): ReturnType<Page['locator']> {
  return promptVersionsList(page, label)
    .locator('.prompt-version-item')
    .filter({ hasText: versionName })
    .first();
}

/** Rename a stored prompt version via the inline form. */
export async function renamePromptVersion(
  page: Page,
  label: string,
  currentName: string,
  nextName: string,
): Promise<void> {
  await openPromptVersions(page, label);
  const item = promptVersionItem(page, label, currentName);
  await item.locator('button.btn.small').filter({ hasText: 'Rename' }).click();

  // Entering rename mode swaps the name span for the inline form (the name
  // text disappears), so continue from the details root — the inline form is
  // also hidden when the native <details> collapses, so force it open.
  const details = promptVersionsList(page, label);
  await details.evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  const input = details.locator('.prompt-rename input[type="text"]');
  await expect(input).toBeVisible();
  await input.fill(nextName);
  await details.locator('.prompt-rename .btn').filter({ hasText: 'Save' }).click();
  await expect(promptVersionItem(page, label, nextName)).toBeVisible();
}

/** Delete a stored prompt version. */
export async function deletePromptVersion(
  page: Page,
  label: string,
  versionName: string,
): Promise<void> {
  await openPromptVersions(page, label);
  const item = promptVersionItem(page, label, versionName);
  await item.locator('button.btn.small.danger').click();
  await expect(promptVersionItem(page, label, versionName)).toHaveCount(0);
}

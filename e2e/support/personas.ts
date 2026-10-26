import { Page, expect } from '@playwright/test';
import {
  formControl,
  gotoPersonas,
  modalSave,
} from './forms';

// ---------------------------------------------------------------------------
// Persona CRUD helpers (personas page).
// ---------------------------------------------------------------------------

export function personaCard(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator('.persona-card').filter({ hasText: name }).first();
}

/** Open the personas page and create a persona in `topicName`. */
export async function createPersona(
  page: Page,
  name: string,
  topicName: string,
  opts?: { shortName?: string; description?: string },
): Promise<void> {
  await gotoPersonas(page);
  await page.locator('.personas-page .toolbar input[type="search"]').fill('');
  await page.locator('.personas-page .page-header .btn.primary').click();
  const modal = page.locator('.personas-page .modal');
  await expect(modal).toBeVisible();
  await formControl(page, modal, 'Name', 'input', 'Short').fill(name);
  await formControl(page, modal, 'Short Name', 'input').fill(opts?.shortName ?? name.slice(0, 2));
  await formControl(page, modal, 'Main topic', 'select').selectOption({ label: topicName });
  if (opts?.description) await formControl(page, modal, 'Description', 'textarea').fill(opts.description);
  await modalSave(page, modal);
  await expect(personaCard(page, name)).toBeVisible();
}

/** Open a persona card's context menu and run an action by its menu label. */
export async function personaMenuAction(page: Page, name: string, action: string): Promise<void> {
  await gotoPersonas(page);
  await page.locator('.personas-page .toolbar input[type="search"]').fill('');
  const card = personaCard(page, name);
  await card.locator('.card-image .menu-btn').click();
  await card.locator('.card-menu button').filter({ hasText: action }).click();
}

/** Edit a persona's name/description and save. */
export async function editPersona(
  page: Page,
  name: string,
  next: { name?: string; description?: string },
): Promise<void> {
  await gotoPersonas(page);
  await page.locator('.personas-page .toolbar input[type="search"]').fill('');
  await personaCard(page, name).click();
  const modal = page.locator('.personas-page .modal');
  await expect(modal).toBeVisible();
  if (next.name) await formControl(page, modal, 'Name', 'input', 'Short').fill(next.name);
  if (next.description) await formControl(page, modal, 'Description', 'textarea').fill(next.description);
  await modalSave(page, modal);
  const expected = next.name ?? name;
  await expect(personaCard(page, expected)).toBeVisible();
}

/** Delete a persona (uses window.confirm → accept the native dialog). */
export async function deletePersona(page: Page, name: string): Promise<void> {
  await gotoPersonas(page);
  page.once('dialog', (dialog) => void dialog.accept());
  await personaMenuAction(page, name, 'Delete');
  await expect(personaCard(page, name)).toHaveCount(0);
}

/** Set a persona as current via card menu; assert the current badge. */
export async function setCurrentPersona(page: Page, name: string): Promise<void> {
  await gotoPersonas(page);
  await personaMenuAction(page, name, 'Set as current');
  await expect(personaCard(page, name).locator('.current-badge').filter({ hasText: 'Current' })).toBeVisible();
}

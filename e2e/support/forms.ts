import { Page, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared form/modal/navigation helpers for the topic / environment / persona
// CRUD specs. Everything here is cross-page generic; the per-entity helpers
// (topics.ts / projects.ts / personas.ts) build on it.
// ---------------------------------------------------------------------------

let _entitySeq = 0;

/** A unique display name so tests never collide on shared server state. */
export function uniqueName(label: string): string {
  _entitySeq += 1;
  return `${label} ${Date.now().toString(36)}-${_entitySeq}`;
}

// ---- page navigation ------------------------------------------------------

export async function gotoTopics(page: Page): Promise<void> {
  await page.goto('/#/topics');
  await expect(page.locator('.topics-page')).toBeVisible();
}

export async function gotoProjects(page: Page): Promise<void> {
  await page.goto('/#/projects');
  await expect(page.locator('.projects-layout')).toBeVisible();
}

export async function gotoPersonas(page: Page): Promise<void> {
  await page.goto('/#/personas');
  await expect(page.locator('.personas-page')).toBeVisible();
}

// ---- form control lookup --------------------------------------------------
// `label` is a substring of the <label> text; `hasNotLabel` excludes an
// ambiguous sibling (e.g. "Name *" vs "Short Name *").

type ControlKind = 'input' | 'textarea' | 'select';

export function formControl(
  page: Page,
  modal: ReturnType<Page['locator']>,
  label: string,
  kind: ControlKind,
  hasNotLabel?: string,
): ReturnType<Page['locator']> {
  let l = modal.locator('label').filter({ hasText: label });
  if (hasNotLabel) l = l.filter({ hasNotText: hasNotLabel });
  return l.locator(kind).first();
}

/** Click a modal's primary action (Create / Save changes). */
export async function modalSave(page: Page, modal: ReturnType<Page['locator']>): Promise<void> {
  await modal.locator('.modal-actions .btn.primary').click();
}

/** Click a modal's Cancel action. */
export async function modalCancel(page: Page, modal: ReturnType<Page['locator']>): Promise<void> {
  await modal.locator('.modal-actions .btn:not(.primary)').click();
}

// ---- ConfirmService dialog (used by topic/project deletes) ----------------

export async function confirmDialogOk(page: Page): Promise<void> {
  await page.locator('.confirm-backdrop .btn.primary').click();
}

export async function confirmDialogCancel(page: Page): Promise<void> {
  await page.locator('.confirm-backdrop .btn:not(.primary)').click();
}

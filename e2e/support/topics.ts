import { Page, expect } from '@playwright/test';
import {
  confirmDialogOk,
  formControl,
  gotoTopics,
  modalSave,
} from './forms';

// ---------------------------------------------------------------------------
// Topic CRUD helpers (topics page).
// ---------------------------------------------------------------------------

export function topicCard(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator('.topic-card').filter({ hasText: name }).first();
}

/** Open the topics page, create a topic with the given name, save, assert card. */
export async function createTopic(
  page: Page,
  name: string,
  opts?: { description?: string; systemPrompt?: string },
): Promise<void> {
  await gotoTopics(page);
  await page.locator('.topics-page .toolbar input[type="search"]').fill('');
  await page.locator('.topics-page .page-header .btn.primary').click();
  const modal = page.locator('.topics-page .modal');
  await expect(modal).toBeVisible();
  await formControl(page, modal, 'Name', 'input').fill(name);
  if (opts?.description) await formControl(page, modal, 'Description', 'textarea').fill(opts.description);
  if (opts?.systemPrompt) await formControl(page, modal, 'Default system prompt', 'textarea').fill(opts.systemPrompt);
  await modalSave(page, modal);
  await expect(topicCard(page, name)).toBeVisible();
}

/** Open a topic card's context menu and run an action by its menu label. */
export async function topicMenuAction(page: Page, name: string, action: string): Promise<void> {
  await gotoTopics(page);
  // Same-URL navigation is a no-op (Angular state persists) — a leftover search
  // filter would hide the card, so clear the search box first.
  await page.locator('.topics-page .toolbar input[type="search"]').fill('');
  const card = topicCard(page, name);
  await card.locator('.card-image .menu-btn').click();
  await card.locator('.card-menu button').filter({ hasText: action }).click();
}

/** Edit a topic's name (and optionally description) and save. */
export async function editTopic(
  page: Page,
  name: string,
  next: { name?: string; description?: string },
): Promise<void> {
  await gotoTopics(page);
  await page.locator('.topics-page .toolbar input[type="search"]').fill('');
  await topicCard(page, name).click();
  const modal = page.locator('.topics-page .modal');
  await expect(modal).toBeVisible();
  if (next.name) await formControl(page, modal, 'Name', 'input').fill(next.name);
  if (next.description) await formControl(page, modal, 'Description', 'textarea').fill(next.description);
  await modalSave(page, modal);
  const expected = next.name ?? name;
  await expect(topicCard(page, expected)).toBeVisible();
}

/** Set a topic as the current topic via its card menu; assert the chip. */
export async function setCurrentTopic(page: Page, name: string): Promise<void> {
  await gotoTopics(page);
  await topicMenuAction(page, name, 'Set as current topic');
  await expect(page.locator('.current-topic-chip', { hasText: name })).toBeVisible();
}

/** Delete a topic via its card menu + ConfirmService dialog; assert it is gone. */
export async function deleteTopic(page: Page, name: string): Promise<void> {
  await gotoTopics(page);
  await topicMenuAction(page, name, 'Delete');
  await confirmDialogOk(page);
  await expect(topicCard(page, name)).toHaveCount(0);
}

/** Assert the topic card shows the linked-counts line (topics.linkedCounts). */
export async function expectTopicCounts(
  page: Page,
  name: string,
  projects: number,
  personas: number,
): Promise<void> {
  await gotoTopics(page);
  await expect(
    topicCard(page, name).locator('.card-body p').last().filter({ hasText: `${projects} environment(s)` })
  ).toBeVisible();
  // The same line also carries the persona count.
  await expect(topicCard(page, name).locator('.card-body p').last()).toContainText(`${personas} persona(s)`);
}

import { Page, expect } from '@playwright/test';
import {
  confirmDialogOk,
  formControl,
  gotoProjects,
  modalSave,
} from './forms';

// ---------------------------------------------------------------------------
// Environment (project) CRUD helpers — the Projects page.
// ---------------------------------------------------------------------------

export function projectCard(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator('.project-card').filter({ hasText: name }).first();
}

/** Select a topic filter in the projects page's left topic pane. */
export async function selectProjectTopicFilter(page: Page, topicName: 'all' | 'unassigned' | string): Promise<void> {
  const li = page.locator('.topic-pane .topic-list li').filter({ hasText: topicName }).first();
  await li.click();
}

/** Open the projects page and create an environment inside `topicName`. */
export async function createProject(
  page: Page,
  name: string,
  topicName: string,
  opts?: { greeting?: string; personaName?: string },
): Promise<void> {
  await gotoProjects(page);
  await page.locator('.project-pane .pane-search').fill('');
  await page.locator('.project-pane .pane-header .btn.primary').click();
  const modal = page.locator('.modal.project-form');
  await expect(modal).toBeVisible();
  await formControl(page, modal, 'Name', 'input').fill(name);
  await formControl(page, modal, 'Main topic', 'select').selectOption({ label: topicName });
  if (opts?.greeting) await formControl(page, modal, 'Greeting', 'textarea').fill(opts.greeting);
  if (opts?.personaName) {
    await modal.locator('.persona-option').filter({ hasText: opts.personaName }).click();
  }
  await modalSave(page, modal);
  await expect(projectCard(page, name)).toBeVisible();
}

/** Edit an environment's name/greeting and save. */
export async function editProject(
  page: Page,
  name: string,
  next: { name?: string; greeting?: string },
): Promise<void> {
  await gotoProjects(page);
  await page.locator('.project-pane .pane-search').fill('');
  await projectCard(page, name).click();
  const modal = page.locator('.modal.project-form');
  await expect(modal).toBeVisible();
  if (next.name) await formControl(page, modal, 'Name', 'input').fill(next.name);
  if (next.greeting) await formControl(page, modal, 'Greeting', 'textarea').fill(next.greeting);
  await modalSave(page, modal);
  const expected = next.name ?? name;
  await expect(projectCard(page, expected)).toBeVisible();
}

/** Delete an environment via its card action + ConfirmService dialog. */
export async function deleteProject(page: Page, name: string): Promise<void> {
  await gotoProjects(page);
  await page.locator('.project-pane .pane-search').fill('');
  const card = projectCard(page, name);
  await card.locator('.card-actions .btn.small.danger').click();
  await expect(page.locator('.confirm-backdrop')).toBeVisible();
  await confirmDialogOk(page);
}

/** Assert an environment card carries a topic chip with `topicName`. */
export async function expectProjectTopicChip(page: Page, name: string, topicName: string): Promise<void> {
  await gotoProjects(page);
  // The SPA keeps topics/projects in memory; same-URL navigation is a no-op and
  // the client topic cache may not reflect a mutation done in THIS test, so
  // reload to read fresh server truth.
  await page.reload();
  await expect(page.locator('.projects-layout')).toBeVisible();
  await selectProjectTopicFilter(page, 'all');
  await page.locator('.project-pane .pane-search').fill('');
  await expect(projectCard(page, name).locator('.topic-chips .chip', { hasText: topicName })).toBeVisible();
}

/** In a concrete topic view, move the env's main topic to another topic. */
export async function changeProjectTopic(
  page: Page,
  envName: string,
  currentTopic: string,
  newTopic: string,
): Promise<void> {
  await gotoProjects(page);
  await page.reload();
  await expect(page.locator('.projects-layout')).toBeVisible();
  await selectProjectTopicFilter(page, currentTopic);
  await page.locator('.project-pane .pane-search').fill('');
  const card = projectCard(page, envName);
  // Current topic == main topic → the card offers "Change topic".
  await card.locator('.card-actions button', { hasText: 'Change topic' }).click();
  await card.locator('.add-topic-popover button').filter({ hasText: newTopic }).click();
  await expect(card.locator('.topic-chips .chip', { hasText: newTopic })).toBeVisible();
}

/** From the "All" filter, add an env to `topicName` via its "Add environment to topic…" popover. */
export async function addProjectToTopic(
  page: Page,
  envName: string,
  topicName: string,
): Promise<void> {
  await gotoProjects(page);
  await page.reload();
  await expect(page.locator('.projects-layout')).toBeVisible();
  await selectProjectTopicFilter(page, 'all');
  await page.locator('.project-pane .pane-search').fill('');
  const card = projectCard(page, envName);
  await card.locator('.card-actions button', { hasText: 'Add environment to topic' }).click();
  await card.locator('.add-topic-popover button').filter({ hasText: topicName }).click();
  await expect(card.locator('.topic-chips .chip', { hasText: topicName })).toBeVisible();
}

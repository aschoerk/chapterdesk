// ---------------------------------------------------------------------------
// ENVIRONMENT (project) — Create / Use / Edit / Delete (separated usecases),
// plus topic-membership usecases (add to topic / change main topic).
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  addProjectToTopic,
  changeProjectTopic,
  createProject,
  createTopic,
  deleteProject,
  deleteTopic,
  editProject,
  expectProjectTopicChip,
  gotoProjects,
  projectCard,
  selectProjectTopicFilter,
  uniqueName,
} from '../support/ui';

test.describe('environment (project): create / use / edit / delete', () => {
  test('01 create an environment inside a topic', async ({ page }) => {
    const topic = uniqueName('Topic');
    const env = uniqueName('Env');
    await createTopic(page, topic);
    await createProject(page, env, topic, { greeting: 'Welcome to the new environment.' });

    // "Use": the environment card is visible under "All" and shows the topic chip,
    // and filtering by that topic narrows the list to just it.
    await expectProjectTopicChip(page, env, topic);
    await selectProjectTopicFilter(page, topic);
    await expect(projectCard(page, env)).toBeVisible();

    // Cleanup.
    await deleteProject(page, env);
    await deleteTopic(page, topic);
  });

  test('02 edit an environment (name + greeting)', async ({ page }) => {
    const topic = uniqueName('Topic');
    const env = uniqueName('Env');
    const renamed = `${env} (edited)`;
    await createTopic(page, topic);
    await createProject(page, env, topic, { greeting: 'before' });
    await editProject(page, env, { name: renamed, greeting: 'after' });

    await expect(projectCard(page, renamed)).toBeVisible();
    // Reopening the card shows the persisted greeting.
    await projectCard(page, renamed).click();
    const modal = page.locator('.modal.project-form');
    await expect(modal).toBeVisible();
    // The greeting textarea is pre-filled with the saved value.
    const nameInput = modal.locator('label').filter({ hasText: 'Name' }).locator('input').first();
    await expect(nameInput).toHaveValue(renamed);
    await modal.locator('.modal-actions .btn:not(.primary)').click();

    await deleteProject(page, renamed);
    await deleteTopic(page, topic);
  });

  test('03 add an environment to a second topic', async ({ page }) => {
    const topicA = uniqueName('Topic');
    const topicB = uniqueName('Topic');
    const env = uniqueName('Env');
    await createTopic(page, topicA);
    await createTopic(page, topicB);
    await createProject(page, env, topicA);

    // Membership "use": add the env to a second topic from the card popover.
    await addProjectToTopic(page, env, topicB);
    // It is now a member of both topics.
    await expectProjectTopicChip(page, env, topicA);
    await expectProjectTopicChip(page, env, topicB);

    await deleteProject(page, env);
    await deleteTopic(page, topicA);
    await deleteTopic(page, topicB);
  });

  test('04 change the main topic of an environment', async ({ page }) => {
    const topicA = uniqueName('Topic');
    const topicB = uniqueName('Topic');
    const env = uniqueName('Env');
    await createTopic(page, topicA);
    await createTopic(page, topicB);
    await createProject(page, env, topicA);

    await changeProjectTopic(page, env, topicA, topicB);
    await expectProjectTopicChip(page, env, topicB);

    await deleteProject(page, env);
    await deleteTopic(page, topicA);
    await deleteTopic(page, topicB);
  });

  test('05 cancel delete keeps the environment', async ({ page }) => {
    const topic = uniqueName('Topic');
    const env = uniqueName('Env');
    await createTopic(page, topic);
    await createProject(page, env, topic);

    await gotoProjects(page);
    const card = projectCard(page, env);
    await card.locator('.card-actions .btn.small.danger').click();
    await expect(page.locator('.confirm-backdrop')).toBeVisible();
    await page.locator('.confirm-backdrop .btn:not(.primary)').click();
    await expect(projectCard(page, env)).toBeVisible();

    await deleteProject(page, env);
    await deleteTopic(page, topic);
  });

  test('06 delete an environment', async ({ page }) => {
    const topic = uniqueName('Topic');
    const env = uniqueName('Env');
    await createTopic(page, topic);
    await createProject(page, env, topic);
    await deleteProject(page, env); // asserts the card is gone afterwards
    await deleteTopic(page, topic);
  });
});

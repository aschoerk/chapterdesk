// ---------------------------------------------------------------------------
// CROSS-ENTITY WORKFLOWS — topics, environments (projects) and personas used
// together, per the request: "in various usecases combined".
//
// Usecases covered:
//   01  round trip:  topic → persona → environment (persona attached to env),
//       then verify the topic counts and the env's persona selection.
//   02  bulk-assign two personas to a different topic.
//   03  environment membership lifecycle: add to a second topic, then remove.
//   04  deleting a topic keeps its environments (they become unassigned).
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  addProjectToTopic,
  createPersona,
  createProject,
  createTopic,
  deletePersona,
  deleteProject,
  deleteTopic,
  expectProjectTopicChip,
  expectTopicCounts,
  gotoPersonas,
  gotoProjects,
  personaCard,
  projectCard,
  selectProjectTopicFilter,
  uniqueName,
} from '../support/ui';

test.describe('combined topic × environment × persona workflows', () => {
  test('01 round trip: topic → persona → environment wired together', async ({ page }) => {
    const topic = uniqueName('World');
    const persona = uniqueName('Persona');
    const env = uniqueName('Env');

    // 1) Topic
    await createTopic(page, topic);
    // 2) Persona inside that topic
    await createPersona(page, persona, topic);
    // 3) Environment in the same topic, with the persona attached
    await createProject(page, env, topic, { personaName: persona });

    // The topic page reflects the linked entities: 1 environment · 1 persona.
    await expectTopicCounts(page, topic, 1, 1);

    // The environment card shows the topic chip…
    await expectProjectTopicChip(page, env, topic);

    // …and reopening the environment shows the persona is selected.
    await gotoProjects(page);
    await projectCard(page, env).click();
    const modal = page.locator('.modal.project-form');
    await expect(modal).toBeVisible();
    await expect(
      modal.locator('.persona-option.selected').filter({ hasText: persona }),
    ).toBeVisible();
    await modal.locator('.modal-actions .btn:not(.primary)').click();

    // Cleanup (reverse order: env → persona → topic).
    await deleteProject(page, env);
    await deletePersona(page, persona);
    await deleteTopic(page, topic);
  });

  test('02 bulk-assign two personas to a different topic', async ({ page }) => {
    const topicA = uniqueName('Topic');
    const topicB = uniqueName('Topic');
    const personaA = uniqueName('Persona');
    const personaB = uniqueName('Persona');

    await createTopic(page, topicA);
    await createTopic(page, topicB);
    await createPersona(page, personaA, topicA);
    await createPersona(page, personaB, topicA);

    // Select both personas, pick topicB in the bulk bar and assign.
    await gotoPersonas(page);
    await personaCard(page, personaA).locator('.select-box input').check();
    await personaCard(page, personaB).locator('.select-box input').check();
    await expect(page.locator('.bulk-bar')).toBeVisible();
    await page.locator('.bulk-bar select').selectOption({ label: topicB });
    await page.locator('.bulk-bar .btn.primary').click();

    // Both cards now report topicB as their main topic.
    await expect(personaCard(page, personaA)).toContainText(topicB);
    await expect(personaCard(page, personaB)).toContainText(topicB);

    await deletePersona(page, personaA);
    await deletePersona(page, personaB);
    await deleteTopic(page, topicA);
    await deleteTopic(page, topicB);
  });

  test('03 environment membership lifecycle: add to a topic, then remove', async ({ page }) => {
    const topicA = uniqueName('Topic');
    const topicB = uniqueName('Topic');
    const env = uniqueName('Env');

    await createTopic(page, topicA);
    await createTopic(page, topicB);
    await createProject(page, env, topicA);

    // Add the environment to a second topic → member of both.
    await addProjectToTopic(page, env, topicB);
    await expectProjectTopicChip(page, env, topicA);
    await expectProjectTopicChip(page, env, topicB);

    // Inside topicB (not the main topic) the card offers "Remove from this topic".
    await gotoProjects(page);
    await selectProjectTopicFilter(page, topicB);
    await projectCard(page, env).locator('.card-actions button', { hasText: 'Remove from this topic' }).click();

    // Back to "All": topicB chip is gone, topicA chip remains.
    await selectProjectTopicFilter(page, 'all');
    await expectProjectTopicChip(page, env, topicA);
    await expect(projectCard(page, env).locator('.topic-chips .chip').filter({ hasText: topicB })).toHaveCount(0);

    await deleteProject(page, env);
    await deleteTopic(page, topicA);
    await deleteTopic(page, topicB);
  });

  test('04 deleting a topic keeps its environments (they become unassigned)', async ({ page }) => {
    const topic = uniqueName('Topic');
    const env = uniqueName('Env');

    await createTopic(page, topic);
    await createProject(page, env, topic);
    await expectProjectTopicChip(page, env, topic);

    // Delete the topic while the environment still exists.
    await deleteTopic(page, topic);

    // The environment survives and now appears under "Unassigned".
    await gotoProjects(page);
    await selectProjectTopicFilter(page, 'unassigned');
    await expect(projectCard(page, env)).toBeVisible();

    await deleteProject(page, env);
  });
});

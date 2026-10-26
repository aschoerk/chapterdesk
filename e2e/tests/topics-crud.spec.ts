// ---------------------------------------------------------------------------
// TOPIC — Create / Use / Edit / Delete (separated usecases).
//
// The e2e stack runs one memory-seeded server for the whole run; entities
// created here persist into later tests, so every test uses a UNIQUE name and
// cleans up after itself. The seeded "Demo Topic" / "Demo Project"/"Editor"
// entities are NEVER touched.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  createTopic,
  deleteTopic,
  editTopic,
  gotoTopics,
  setCurrentTopic,
  topicCard,
  topicMenuAction,
  confirmDialogOk,
  uniqueName,
} from '../support/ui';

test.describe('topic: create / use / edit / delete', () => {
  test('01 create a topic and find it via search', async ({ page }) => {
    const name = uniqueName('Topic');
    await createTopic(page, name, {
      description: 'A topic created by the e2e suite',
      systemPrompt: 'You are a thoughtful writing coach.',
    });

    // It is listed with its description rendered on the card.
    const card = topicCard(page, name);
    await expect(card.locator('.card-body .name')).toHaveText(name);
    await expect(card.locator('.card-body p').first()).toContainText(
      'A topic created by the e2e suite',
    );

    // Search narrows to it; a non-matching term clears the list.
    const search = page.locator('.topics-page .toolbar input[type="search"]');
    await search.fill(name);
    await expect(topicCard(page, name)).toBeVisible();
    await search.fill('zzz-no-such-topic');
    await expect(topicCard(page, name)).toHaveCount(0);

    // Cleanup: remove the topic we created.
    await deleteTopic(page, name);
  });

  test('02 edit a topic (name + description)', async ({ page }) => {
    const name = uniqueName('Topic');
    const renamed = `${name} renamed`;
    await createTopic(page, name, { description: 'before' });

    await editTopic(page, name, { name: renamed, description: 'after' });
    await expect(topicCard(page, renamed)).toBeVisible();

    // The card now shows the updated description.
    await expect(topicCard(page, renamed).locator('.card-body p').first()).toContainText('after');

    await deleteTopic(page, renamed);
  });

  test('03 set a topic as the current topic', async ({ page }) => {
    const name = uniqueName('Topic');
    await createTopic(page, name);

    // "Use": make it the current topic (via the card's context menu) and
    // verify the chip in the toolbar reflects exactly that topic.
    await setCurrentTopic(page, name);

    // Clear the current topic again (fresh client state for the next test).
    await page.locator('.current-topic-chip .btn-icon').click();
    await expect(page.locator('.current-topic-chip')).toHaveCount(0);

    await deleteTopic(page, name);
  });

  test('04 cancel delete keeps the topic', async ({ page }) => {
    const name = uniqueName('Topic');
    await createTopic(page, name);

    await gotoTopics(page);
    await topicMenuAction(page, name, 'Delete');
    await expect(page.locator('.confirm-backdrop')).toBeVisible();
    // Dismiss the confirm dialog → the topic must survive.
    await page.locator('.confirm-backdrop .btn:not(.primary)').click();
    await expect(topicCard(page, name)).toBeVisible();

    await deleteTopic(page, name);
  });

  test('05 delete a topic', async ({ page }) => {
    const name = uniqueName('Topic');
    await createTopic(page, name);
    await deleteTopic(page, name); // asserts the card is gone afterwards
  });
});

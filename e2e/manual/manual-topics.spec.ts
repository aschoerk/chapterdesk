// ---------------------------------------------------------------------------
// USER MANUAL — "Organize with topics".
//
// Generates docs/manuals/manual-topics.md + screenshots. Shows the topics page
// (create a topic and make it the current topic). Self-contained: it creates
// a uniquely named topic and cleans it up.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { gotoTopics, topicCard, createTopic } from '../support/ui';
import { deleteTopicViaApi, newManual } from './manual-support';

test('Organize with topics', async ({ page }) => {
  const manual = newManual(page, 'manual-topics', 'Organize with topics');
  const topic = `Manual Topic ${Date.now().toString(36)}`;

  await manual.step(
    'Open the Topics page',
    'Use the **Topics** link in the top navigation. Topics group environments (books) and personas.',
    (p) => gotoTopics(p),
    { waitAfter: 400 },
  );

  await manual.step(
    'Create a topic',
    'Click **+ New topic**, give it a name and description, then save.',
    async (p) => {
      await createTopic(p, topic, { description: 'A topic created for the user manual.' });
      await expect(topicCard(p, topic)).toBeVisible();
    },
    { waitAfter: 400, highlightTarget: topicCard(page, topic) },
  );

  await manual.step(
    'Review the topic',
    'The topic appears as a card with its description. Open its menu to edit, delete or mark it as the current topic.',
    async (p) => {
      await topicCard(p, topic).locator('.card-image .menu-btn').click();
      await expect(
        topicCard(p, topic).locator('.card-menu button').filter({ hasText: 'Set as current topic' }),
      ).toBeVisible();
    },
    { waitAfter: 300 },
  );

  await manual.generate();

  // Cleanup so the manual run stays repeatable on the shared server.
  await deleteTopicViaApi(page, topic);
});
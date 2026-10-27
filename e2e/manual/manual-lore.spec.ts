// ---------------------------------------------------------------------------
// USER MANUAL — "Story lore — canon for every prompt".
//
// Generates docs/manuals/manual-lore.md + screenshots. Shows the per-story
// Lore dialog, entering never-miss world facts, and how the lore is inserted
// in front of each direction when it is sent — then documented without being
// re-shipped, so it never clots the context. Self-contained: it creates a
// fresh story, works on it, and cleans it up via the API.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { mockLlm } from '../support/llm-mock';
import {
  openApp,
  newStory,
  askQuestion,
  nodeFor,
  deleteChatViaApi,
} from '../support/ui';
import { newManual } from './manual-support';

const ANSWER = 'She passed the Velvet Cage without glancing at the door.';
const LORE = [
  'Ashley is married to Dr. Harvey — never mentioned aloud.',
  'The Velvet Cage has no exterior sign.',
].join('\n');

test('Story lore — canon for every prompt', async ({ page }) => {
  await mockLlm(page, { answer: [ANSWER] });
  const manual = newManual(page, 'manual-lore', 'Story lore — canon for every prompt');
  let title = '';

  await manual.step(
    'Open the application',
    'Launch ChapterDesk. Your books and stories are listed in the left sidebar.',
    (p) => openApp(p),
    { waitAfter: 400 },
  );

  await manual.step(
    'Open a fresh story',
    'Click **New story** in a book. ChapterDesk opens an empty story with a composer at the end.',
    async (p) => {
      title = await newStory(p, 'Demo Project');
    },
    { waitAfter: 500 },
  );

  await manual.step(
    'Open the Story Lore dialog',
    'The **Lore** button in the toolbar opens the per-story lore dialog. Lore is a short set of never-miss world facts the model must respect and never contradict.',
    async (p) => {
      await p.locator('.params-bar button').filter({ hasText: 'Lore' }).first().click();
      await expect(p.locator('.lore-dialog')).toBeVisible();
    },
    { waitAfter: 400, highlightTarget: page.locator('.lore-dialog') },
  );

  await manual.step(
    'Enter the lore text',
    'Type the facts that must always hold, then **Save**. The toolbar now shows **Lore ✓**. **Auto-exclude new directions after their first send** keeps the chat lean by sending each new direction once and then removing it from the history the model sees.',
    async (p) => {
      await p.locator('.lore-dialog textarea').fill(LORE);
      await p.locator('.lore-dialog button').filter({ hasText: 'Save' }).click();
      await expect(
        p.locator('.params-bar button').filter({ hasText: 'Lore ✓' }),
      ).toBeVisible();
    },
    { waitAfter: 400 },
  );

  await manual.step(
    'Send a direction',
    'Write the next direction and press **Ctrl+Enter**. Just before the prompt is sent, the lore is materialized as its own node right in front of the direction, wrapped in canon markers so the model treats it as fixed lore.',
    async (p) => {
      await askQuestion(p, 'What happens at the door?');
    },
    { waitAfter: 2500 },
  );

  await manual.step(
    'Lore travels with the prompt, then documents itself',
    'The answer streams in as a new chapter. The lore node stays in the tree — it was sent **exactly once** with the direction, then documented (excluded from later context) so it never repeats and never clutters the prompts.',
    async (p) => {
      await expect(nodeFor(p, ANSWER)).toBeVisible();
      await expect(p.locator('.tree').getByText(/Current chat-lore/)).toBeVisible();
    },
    { waitAfter: 300 },
  );

  await manual.generate();

  // Cleanup so the manual run stays repeatable on the shared server.
  await deleteChatViaApi(page, title);
});
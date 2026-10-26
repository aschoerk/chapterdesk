// ---------------------------------------------------------------------------
// USER MANUAL — "Write Your First Chapter".
//
// Generates docs/manuals/manual-new-story.md + screenshots. Creates a story,
// writes a direction and shows the AI answer streaming into a new chapter.
// The LLM is faked with the same wiremock used by the assertion suite, so the
// manual is deterministic and offline.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { mockLlm } from '../support/llm-mock';
import { openApp, newStory, askQuestion, nodeFor, deleteChatViaApi } from '../support/ui';
import { newManual } from './manual-support';

const ANSWER = 'The hero is Ada, an engineer living among the clouds.';

test('Write Your First Chapter', async ({ page }) => {
  await mockLlm(page, { answer: [ANSWER] });
  const manual = newManual(page, 'manual-new-story', 'Write Your First Chapter');
  let title = '';

  await manual.step(
    'Open the application',
    'Launch ChapterDesk. Your books and stories are listed in the left sidebar.',
    (p) => openApp(p),
    { waitAfter: 400 },
  );

  await manual.step(
    'Create a new story',
    'Click **New story** in your book. ChapterDesk opens a fresh story with a welcome section.',
    async (p) => {
      title = await newStory(p, 'Demo Project');
    },
    { waitAfter: 800, highlightTarget: page.locator('.chat-title-editor') },
  );

  await manual.step(
    'Write a direction',
    'Click the composer at the end of the story and type what should happen next, then press **Ctrl+Enter**.',
    async (p) => {
      await askQuestion(p, 'Who is the hero?');
    },
    { waitAfter: 2500 },
  );

  await manual.step(
    'Read the answer',
    'The model streams its reply into a new chapter beneath your direction.',
    async (p) => {
      await expect(nodeFor(p, ANSWER)).toBeVisible();
    },
    { waitAfter: 300, highlightTarget: nodeFor(page, ANSWER) },
  );

  await manual.generate();
  await deleteChatViaApi(page, title);
});
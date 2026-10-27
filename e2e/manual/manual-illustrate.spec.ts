// ---------------------------------------------------------------------------
// USER MANUAL — "Illustrate your chapters".
//
// Generates docs/manuals/manual-illustrate.md + screenshots. Creates a fresh
// story, asks the mock model a direction, then uses **Illustrate** to attach a
// generated picture to the chapter. Self-contained (mocked LLM) + cleans up.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { mockLlmScripts } from '../support/llm-mock';
import {
  deleteChatViaApi,
  expectImageThumbsOn,
  nodeFor,
  openApp,
  newStory,
  askQuestion,
  illustrateOn,
} from '../support/ui';
import { newManual } from './manual-support';

const QA = 'Describe the hero of the story.';
const ANSWER = 'The hero is Ada, a lighthouse keeper.';

test('Illustrate your chapters', async ({ page }) => {
  // Call 1 = streamed writing answer; call 2 = Illustrate (whole chapter);
  // call 3 = Illustrate of a MARKED part.
  await mockLlmScripts(page, [{ answer: [ANSWER] }, { images: 1 }, { images: 1 }]);
  const manual = newManual(page, 'manual-illustrate', 'Illustrate your chapters');
  let title = '';

  await manual.step(
    'Open a story',
    'Create a fresh story and ask a direction. The mock model writes a short chapter.',
    async (p) => {
      await openApp(p);
      title = await newStory(p, 'Demo Project');
      await askQuestion(p, QA);
      await expect(nodeFor(p, ANSWER)).toBeVisible();
    },
    { waitAfter: 1200 },
  );

  await manual.step(
    'Open Illustrate',
    'On the chapter card, click **Illustrate**. The dialog lets you choose the model, the story context and the number of pictures.',
    (p) => illustrateOn(p, ANSWER, { count: 1, mode: 'direct' }),
    { waitAfter: 1500 },
  );

  await manual.step(
    'See the generated picture',
    'When the model returns an image it is attached to the chapter as a thumbnail — shown in the tree and exported with the story.',
    async (p) => {
      // The mock returns a deterministic data-URL image.
      await expectImageThumbsOn(p, ANSWER, 1);
    },
    { waitAfter: 400, highlightTarget: nodeFor(page, ANSWER).locator('.chip img.thumb') },
  );

  await manual.step(
    'Illustrate a marked part',
    'Select a part of the chapter text and press **Illustrate** again: the dialog pre-fills **Scene to depict** with the marked text (editable). The picture then shows exactly that marked moment — in every use case (planned / direct / pure).',
    (p) => illustrateOn(p, ANSWER, { count: 1, mode: 'direct', scene: 'a lighthouse keeper' }),
    { waitAfter: 1500 },
  );

  await manual.generate();
  await deleteChatViaApi(page, title);
});
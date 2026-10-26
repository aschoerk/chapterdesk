// ---------------------------------------------------------------------------
// LLM orchestration — IMAGE use cases (UC1–UC5, UC14), environment B.
//
// Drives the real UI (Docker single-origin at http://127.0.0.1:8081). The LLM
// is the browser-side wiremock; image render/planning calls are answered with
// deterministic non-stream JSON (image_url parts / planning descriptions), so
// every render lands a real attachable thumbnail on the chapter node.
//
// A new story is pre-populated (structure + greeting direction + chapter), so
// the chapter to illustrate is anchored by its CONTENT TEXT (`ANSWER`), not by
// position.
//
// UC1  storyboard-direct      UC4  render-full
// UC2  planned-enblock        UC4b render-window
// UC3  planned-scenes         UC5  render-node
//                            UC14 image-send (create image of a selection)
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { mockLlm, mockLlmScripts } from '../support/llm-mock';
import {
  openApp,
  newStory,
  askQuestion,
  expectNodeText,
  nodeFor,
  clickNodeActionOn,
  selectNodeText,
  illustrateOn,
  expectImageThumbsOn,
  confirmCreateImage,
} from '../support/ui';

const QA = 'Who is the hero?';
const ANSWER = 'The hero is Ada.';

/** Fresh chat with one answered chapter (anchored by `ANSWER`). */
async function freshChapter(page: import('@playwright/test').Page): Promise<void> {
  await mockLlm(page, { answer: [ANSWER] });
  await openApp(page);
  await newStory(page, 'Demo Project');
  await askQuestion(page, QA);
  await expectNodeText(page, ANSWER);
}

// ---------------------------------------------------------------------------
// UC1 — storyboard-direct
// ---------------------------------------------------------------------------

test('UC1 storyboard-direct — count 3, no planning: all 3 pictures attach in one render', async ({
  page,
}) => {
  await freshChapter(page);
  // One render call returning all 3 pictures → no fallback.
  await mockLlm(page, { images: 3 });
  await illustrateOn(page, ANSWER, { count: 3, mode: 'direct' });
  await expectImageThumbsOn(page, ANSWER, 3);
  // The prompt record is attached too.
  await expect(nodeFor(page, ANSWER).locator('.chip .name')).toContainText('prompt-1.txt');
});

// ---------------------------------------------------------------------------
// UC2 — planned-enblock (pure picture mode always plans)
// ---------------------------------------------------------------------------

test('UC2 planned-enblock — pure mode plans then renders N pictures as one batch', async ({
  page,
}) => {
  await freshChapter(page);
  // Call 1 = planning (descriptions), call 2 = render (N images, batch).
  await mockLlmScripts(page, [{ planning: 2 }, { images: 2 }]);
  await illustrateOn(page, ANSWER, { count: 2, mode: 'pure' });
  await expectImageThumbsOn(page, ANSWER, 2);
});

// ---------------------------------------------------------------------------
// UC3 — planned-scenes
// ---------------------------------------------------------------------------

test('UC3 planned-scenes — planned → one en-block render of N scenes', async ({ page }) => {
  await freshChapter(page);
  await mockLlmScripts(page, [{ planning: 3 }, { images: 3 }]);
  await illustrateOn(page, ANSWER, { count: 3, mode: 'planned' });
  await expectImageThumbsOn(page, ANSWER, 3);
});

// ---------------------------------------------------------------------------
// UC4 / UC4b / UC5 — render-full / render-window / render-node
// ---------------------------------------------------------------------------

test('UC4 render-full — single picture with the complete chat as context', async ({ page }) => {
  await freshChapter(page);
  await mockLlm(page, { images: 1 });
  await illustrateOn(page, ANSWER, {
    count: 1,
    mode: 'direct',
    context: 'All story text up to this point',
  });
  await expectImageThumbsOn(page, ANSWER, 1);
});

test('UC4b render-window — single picture bounded to the last N beats', async ({ page }) => {
  await freshChapter(page);
  await mockLlm(page, { images: 1 });
  await illustrateOn(page, ANSWER, {
    count: 1,
    mode: 'direct',
    context: 'Last beats up to this point',
    windowCount: 2,
  });
  await expectImageThumbsOn(page, ANSWER, 1);
});

test('UC5 render-node — single picture from the current node only', async ({ page }) => {
  await freshChapter(page);
  await mockLlm(page, { images: 1 });
  await illustrateOn(page, ANSWER, { count: 1, mode: 'direct', context: 'Current text only' });
  await expectImageThumbsOn(page, ANSWER, 1);
});

// ---------------------------------------------------------------------------
// UC14 — image-send (create image of a selection)
// ---------------------------------------------------------------------------

test('UC14 image-send — marked text sent AS-IS, picture attached to the chapter', async ({
  page,
}) => {
  await freshChapter(page);
  await mockLlm(page, { images: 1 });
  await selectNodeText(page, ANSWER, 'hero');
  await clickNodeActionOn(page, ANSWER, 'Create image');
  await page.locator('.cimg-dialog').waitFor({ state: 'visible' });
  await confirmCreateImage(page);
  await expectImageThumbsOn(page, ANSWER, 1);
});

// ---------------------------------------------------------------------------
// Refusal / zero-image error paths
// ---------------------------------------------------------------------------

test('UC1 refused — moderation refusal keeps the prompt, shows the empty toast', async ({
  page,
}) => {
  await freshChapter(page);
  await mockLlm(page, { refusal: 'Cannot create this picture.' });
  await illustrateOn(page, ANSWER, { count: 2, mode: 'direct' });
  // Nothing produced → the refused prompt record is kept, no thumbnails.
  await expect(nodeFor(page, ANSWER).locator('.chip .name').first()).toContainText('refused-prompt-1.txt');
  await expect(nodeFor(page, ANSWER).locator('.chip img.thumb')).toHaveCount(0);
  // Non-modal toast surfaces the refusal reason (UX playbook §8) — no
  // blocking native alert.
  const toast = page.locator('.toast-error');
  await expect(toast).toContainText(/no picture/i);
  await expect(toast).toContainText(/cannot create this picture/i);
});
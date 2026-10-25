// ---------------------------------------------------------------------------
// LLM orchestration — TEXT use cases (UC6–13, UC15–21), environment B.
//
// Drives the real UI (Docker single-origin at http://127.0.0.1:8081). The LLM
// is a browser-side wiremock (`e2e/support/llm-mock.ts`) intercepting
// `/proxy/chat/completions`, so every request is deterministic and every
// assertion reads the actual DOM / request log.
//
// A new story is NOT empty: it is pre-populated from the topic/project/
// persona (a structure node with the topic system prompt, then a direction +
// chapter built from the project greeting + persona). `freshQA()` therefore
// leaves a tree like: S(structure) › D(greeting) › C(greeting) › D(Q) › C(A) ›
// D(draft). All helpers below anchor nodes by their CONTENT TEXT, not by
// position, so the starter nodes never break them.
//
// UC6  append                    UC12 send-prepend
// UC7  append-with-images        UC13 send-elaborate
// UC8  send-branch               UC15 structure-title
// UC9  send-insert               UC16 structure-overview
// UC10 send-regenerate           UC17 structure-heading
// UC11 send-rewrite              UC18 structure-headings
//                               UC19 language-check
//                               UC20 rewrite-selection
//                               UC21 send-chapter-descriptions
// ---------------------------------------------------------------------------

import { test, expect } from '@playwright/test';
import { mockLlm, mockLlmScripts } from '../support/llm-mock';
import {
  openApp,
  newStory,
  askQuestion,
  expectNodeText,
  nodeFor,
  clickNodeActionOn,
  openEditorOn,
  clickChatToolbarAction,
  acceptConfirmDialog,
  captureAlerts,
  selectNodeText,
  expectImageThumbsOn,
  illustrateOn,
} from '../support/ui';

const QA = 'Who is the hero?';
const ANSWER = 'The hero is Ada.';

/** Fresh chat with one answered beat: starter nodes + [Q(user), A(assistant), draft]. */
async function freshQA(page: import('@playwright/test').Page): Promise<void> {
  await mockLlm(page, { answer: [ANSWER] });
  await openApp(page);
  await newStory(page, 'Demo Project');
  await askQuestion(page, QA);
  await expectNodeText(page, ANSWER);
}

/** Type `text` into the trailing composer leaf and send it. */
async function typeAndSend(page: import('@playwright/test').Page, text: string): Promise<void> {
  const draft = page
    .locator('.node-content.empty-draft.click-to-edit')
    .filter({ hasText: 'Write the next direction…' })
    .first();
  await draft.click();
  const editor = page.locator('.editor-textarea').first();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await editor.press('Control+Enter');
}

test('UC6 append — send a direction, stream the answer under it', async ({ page }) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['And then the storm came.'] });
  await typeAndSend(page, 'Describe the storm.');
  await expectNodeText(page, 'And then the storm came.');
});

test('UC7 append-with-images — attached image is interpreted, then the answer streams', async ({
  page,
}) => {
  // Call 1 = image-interpret (non-stream JSON text); call 2 = the streamed answer.
  await mockLlmScripts(page, [
    { nonStream: true, answer: ['A lighthouse on a cliff at dusk.'] },
    { answer: ['She watched the light sweep the sea.'] },
  ]);
  await openApp(page);
  await newStory(page, 'Demo Project');

  // Open the composer and attach an image file.
  const draft = page
    .locator('.node-content.empty-draft.click-to-edit')
    .filter({ hasText: 'Write the next direction…' })
    .first();
  await draft.click();
  const editor = page.locator('.editor-textarea').first();
  await expect(editor).toBeVisible();
  await page.locator('.inline-content-editor input[type="file"]').setInputFiles({
    name: 'lighthouse.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  await expect(
    page.locator('.inline-content-editor .attachment-chips img.thumb'),
  ).toHaveCount(1);

  const directionText = 'Describe this image and continue.';
  await editor.fill(directionText);
  await editor.press('Control+Enter');

  await expectNodeText(page, 'She watched the light sweep the sea.');
  // The QUESTION node carries the merged interpretation (inner rendered
  // content — the outer wrapper is a clickable empty-draft container that also
  // matches `.node-content`) + the stored image-description record.
  const question = nodeFor(page, directionText);
  await expect(question.locator('.node-content .node-content').first()).toContainText('lighthouse');
  await expect(question.locator('.chip .name, .chip a.file-link')).toContainText('image-description.txt');
});

test('UC8 send-branch — new sibling question + streamed answer under it', async ({ page }) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['A quiet branch opens.'] });
  // Edit the direction node and click Continuation.
  await openEditorOn(page, QA);
  await page.locator('.editor-actions button').filter({ hasText: 'Continuation' }).click();
  await expectNodeText(page, 'A quiet branch opens.');
  // The original question now has two continuations (sibling branches).
  await expect(nodeFor(page, QA).locator('.branch-count')).toContainText('/ 2');
});

test('UC9 send-insert — new sibling question; old siblings hang under the new answer', async ({
  page,
}) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['The insert rewrites the beat.'] });
  await openEditorOn(page, QA);
  await page.locator('.editor-actions button').filter({ hasText: 'Insert' }).click();
  await expectNodeText(page, 'The insert rewrites the beat.');
});

test('UC10 send-regenerate — delete the answer + subtree, re-stream under the question', async ({
  page,
}) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['A stronger opening.'] });
  await clickNodeActionOn(page, ANSWER, 'Regenerate');
  await acceptConfirmDialog(page);
  await expectNodeText(page, 'A stronger opening.');
  // Old answer text no longer visible.
  await expect(page.locator('.tree .node-content').filter({ hasText: ANSWER })).toHaveCount(0);
});

test('UC11 send-rewrite — replace only this answer, keep following text', async ({ page }) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['A careful rewrite.'] });
  await clickNodeActionOn(page, ANSWER, 'Rewrite in place');
  await acceptConfirmDialog(page);
  await expectNodeText(page, 'A careful rewrite.');
  // The following draft leaf is preserved (kept children).
  await expect(
    page.locator('.node-content.empty-draft.click-to-edit').filter({ hasText: 'Write the next direction…' }),
  ).toHaveCount(1);
});

test('UC12 send-prepend — director node before the current direction + streamed result', async ({
  page,
}) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['The director sets the scene first.'] });
  // Prepend is offered on an answered direction node (user, not unsent).
  await clickNodeActionOn(page, QA, 'Prepend');
  await page.locator('.prepend-dialog textarea').fill('Show the harbour at dawn first.');
  await page.locator('.prepend-dialog .prepend-actions .btn.primary').click();
  await expectNodeText(page, 'The director sets the scene first.');
});

test('UC13 send-elaborate — append an elaboration under the visible tree anchor', async ({
  page,
}) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['The hero finally explains.'] });
  await clickChatToolbarAction(page, 'Elaborate');
  const dlg = page.locator('.elaborate-dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="number"]').nth(0).fill('1');
  await dlg.locator('input[type="number"]').nth(1).fill('1');
  await dlg.locator('.elaborate-actions .btn.primary').click();
  await expectNodeText(page, 'The hero finally explains.');
});

test('UC15 structure-title — title node at root + chat title updated', async ({ page }) => {
  await freshQA(page);
  await mockLlm(page, { nonStream: true, answer: ['The Lantern Keeper'] });
  await clickChatToolbarAction(page, 'Title');
  await expect(
    page.locator('.tree .node.structural-node').filter({ hasText: 'The Lantern Keeper' }),
  ).toBeVisible();
  // The chat tab/sidebar now carries the new title.
  await expect(page.locator('.chat-title-editor .chat-title')).toContainText('The Lantern Keeper');
});

test('UC16 structure-overview — introduction placed under the title', async ({ page }) => {
  await freshQA(page);
  await mockLlm(page, { nonStream: true, answer: ['An introduction to the tale.'] });
  await clickChatToolbarAction(page, 'Introduction');
  await expect(
    page.locator('.tree .node.structural-node').filter({ hasText: 'An introduction to the tale.' }),
  ).toBeVisible();
});

test('UC17 structure-heading — heading for one chapter (wraps or patches)', async ({ page }) => {
  await freshQA(page);
  await mockLlm(page, { nonStream: true, answer: ['Chapter One: The Arrival'] });
  // The header "Heading" button on the chapter that carries our answer.
  await nodeFor(page, ANSWER)
    .locator('.node-header button')
    .filter({ hasText: 'Heading' })
    .first()
    .click();
  await expect(
    page.locator('.tree .node.structural-node').filter({ hasText: 'Chapter One: The Arrival' }),
  ).toBeVisible();
});

test('UC18 structure-headings — one heading per unheaded chapter', async ({ page }) => {
  // Two assistant chapters on the path: the starter greeting chapter and ours.
  await freshQA(page);
  await mockLlm(page, { nonStream: true, answer: ['A New Heading'] });
  await clickChatToolbarAction(page, 'Headings');
  // A heading is generated for each unheaded assistant chapter (starter C +
  // our C), both get the same mock heading text.
  await expect(
    page.locator('.tree .node.structural-node').filter({ hasText: 'A New Heading' }),
  ).toHaveCount(2);
});

test('UC19 language-check — three corrected variants returned, no mutation', async ({ page }) => {
  await freshQA(page);
  // The app expects the raw model text = a JSON array of 3 strings.
  await mockLlm(page, {
    nonStream: true,
    answer: ['["Older line.","clearer line.","full restatement."]'],
  });
  await openEditorOn(page, QA);
  await page.locator('.editor-toolbar button').filter({ hasText: 'Check my English' }).click();
  const variants = page.locator('.english-check .english-option');
  await expect(variants).toHaveCount(3);
  await expect(variants.first().locator('.english-text')).toContainText('Older line.');
});

test('UC20 rewrite-selection — marked text → streamed suggestions', async ({ page }) => {
  await freshQA(page);
  // The rewrite dialog parses the streamed answer as a JSON array of 3.
  await mockLlm(page, {
    answer: ['["cleaner sentence.","more vivid line.","fuller rewrite."]'],
  });
  // Select part of the rendered chapter text, then click Rewrite on the node.
  await selectNodeText(page, ANSWER, 'hero');
  await clickNodeActionOn(page, ANSWER, 'Rewrite');
  const dlg = page.locator('.rewrite-dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('.rewrite-actions .btn.primary').click();
  const suggestions = dlg.locator('.rewrite-suggestion');
  await expect(suggestions.first()).toBeVisible();
  await expect(suggestions).toHaveCount(3);
});

test('UC21 send-chapter-descriptions — branches a sibling question with the list', async ({
  page,
}) => {
  await freshQA(page);
  await mockLlm(page, { answer: ['1. The First Evening — opens the harbour.'] });
  await clickNodeActionOn(page, QA, 'Chapter descriptions');
  const dlg = page.locator('.cd-dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('.cd-params input[type="number"]').nth(0).fill('3');
  await dlg.locator('.cd-actions .btn.primary').click();
  await expectNodeText(page, 'The First Evening');
});

test('UC1 storyboard-direct variant — "only got X of Y" alert when the batch comes back partial', async ({
  page,
}) => {
  await freshQA(page);
  await mockLlm(page, { images: 1 }); // batch returns 1 of 3 → stops, no fallback
  const alerts = captureAlerts(page);
  await illustrateOn(page, ANSWER, { count: 3, mode: 'direct' });
  await expectImageThumbsOn(page, ANSWER, 1);
  await page.waitForTimeout(200);
  expect(alerts.some(a => a.includes('pictures were created'))).toBe(true);
});
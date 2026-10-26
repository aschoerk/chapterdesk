// ---------------------------------------------------------------------------
// READ-ONLY NAVIGATION — the chat-reader (`/read`) book view.
//
// The reader renders the chat as a read-only book (one document per story
// continuation), with navigation for documents (`.doc-pager`), pages/spreads
// (keyboard + progress bar), column count, hide-directions, and typeface/size.
// It is opened from the chat page via the nav-bar book button (chat.openReader).
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { mockLlm, mockLlmScripts } from '../support/llm-mock';
import {
  openApp,
  openChat,
  newStory,
  askQuestion,
  expectNavPathLength,
  openNavNodeMenu,
  clickNavMenuAction,
  openReader,
} from '../support/ui';
import {
  bookNode,
  docFolio,
  footerFolioNumbers,
  readerColumns,
  readerTitle,
} from '../support/ui';

test.describe('read-only navigation (chat-reader)', () => {
  test('01 opens the book from the nav bar and shows the chat as a document', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openReader(page);

    await expect(readerTitle(page)).toHaveText('Getting Started');
    await expect(
      bookNode(page, 'user').filter({ hasText: 'How should I introduce my main character?' }),
    ).toBeVisible();
    await expect(
      bookNode(page, 'assistant').filter({ hasText: 'memorable, decisive moment' }),
    ).toBeVisible();
    // A single-path story is one document.
    await expect(docFolio(page)).toContainText('Doc 1 / 1');

    // Escape returns to the (editable) tree.
    await page.keyboard.press('Escape');
    await expect(page.locator('.tree app-chat-node').first()).toBeVisible();
  });

  test('02 document pager walks forked continuations', async ({ page }) => {
    await mockLlmScripts(page, [
      { answer: ['A quiet, warm opening scene.'] },
      { answer: ['The story turns in chapter two.'] },
    ]);
    await openApp(page);
    await newStory(page, 'Demo Project');
    await askQuestion(page, 'Who is the hero?');
    // path: system, user, greeting, Q1, A1, draft → 6 nav nodes.
    await expectNavPathLength(page, 6);

    // Fork a second continuation under the first answer (nav 5 = assistant).
    await openNavNodeMenu(page, 5);
    await clickNavMenuAction(page, 'Start branch here');
    await expectNavPathLength(page, 5);
    await askQuestion(page, 'What changes in chapter two?');
    await expectNavPathLength(page, 7);

    await openReader(page);
    // The reader opens on the ACTIVE continuation (the fork we just sent).
    await expect(docFolio(page)).toContainText('Doc 2 / 2');
    await expect(
      bookNode(page, 'assistant').filter({ hasText: 'The story turns in chapter two.' }),
    ).toBeVisible();

    // Previous → the first continuation (its own full root→leaf document).
    await page.locator('.doc-pager button[title="Previous document"]').click();
    await expect(docFolio(page)).toContainText('Doc 1 / 2');
    await expect(docFolio(page).locator('small')).toContainText('continuation 1');
    await expect(
      bookNode(page, 'assistant').filter({ hasText: 'A quiet, warm opening scene.' }),
    ).toBeVisible();

    // Next → back to the second continuation.
    await page.locator('.doc-pager button[title="Next document"]').click();
    await expect(docFolio(page)).toContainText('Doc 2 / 2');

    // First / Last jump to the boundaries.
    await page.locator('.doc-pager button[title="Oldest document"]').click();
    await expect(docFolio(page)).toContainText('Doc 1 / 2');
    await page.locator('.doc-pager button[title="Newest document"]').click();
    await expect(docFolio(page)).toContainText('Doc 2 / 2');

    // At the first document the previous/oldest buttons are disabled.
    await page.locator('.doc-pager button[title="Oldest document"]').click();
    await expect(page.locator('.doc-pager button[title="Previous document"]')).toBeDisabled();
    await expect(page.locator('.doc-pager button[title="Oldest document"]')).toBeDisabled();
  });

  test('03 column count switches the reader columns and persists', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openReader(page);

    // Default is 3 columns.
    expect(await readerColumns(page)).toBe('3');

    await page.locator('.cols-pager button').filter({ hasText: '1' }).click();
    await expect.poll(() => readerColumns(page)).toBe('1');
    await expect(
      page.locator('.cols-pager button').filter({ hasText: '1' }),
    ).toHaveClass(/active/);

    await page.locator('.cols-pager button').filter({ hasText: '2' }).click();
    await expect.poll(() => readerColumns(page)).toBe('2');

    // Persisted per reader session.
    const stored = await page.evaluate(() => localStorage.getItem('chat-reader.columnCount'));
    expect(stored).toBe('2');
  });

  test('04 hiding directions collapses the user (direction) nodes in the book', async ({
    page,
  }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openReader(page);

    await expect(bookNode(page, 'user')).toHaveCount(1);
    await expect(bookNode(page, 'assistant')).toHaveCount(1);

    // The hide-directions button (also Ctrl+D).
    await page.locator('.reader-bar button[title="Hide directions (Ctrl+D)"]').click();
    await expect(bookNode(page, 'user')).toHaveCount(0);
    await expect(bookNode(page, 'assistant')).toHaveCount(1);
    await expect(page.locator('.reader-bar button[title="Show directions (Ctrl+D)"]')).toBeVisible();

    // Ctrl+D toggles them back on.
    await page.keyboard.press('Control+d');
    await expect(bookNode(page, 'user')).toHaveCount(1);
  });

  test('05 keyboard paging navigates a long book and Escape returns to the tree', async ({
    page,
  }) => {
    const longAnswer = Array.from(
      { length: 200 },
      (_, i) => `Chapter ${i + 1}. ${'The harbour was quiet before dawn. '.repeat(20).trim()}`,
    ).join('\n\n');
    await mockLlm(page, { answer: [longAnswer] });
    await openApp(page);
    const title = await newStory(page, 'Demo Project');
    await askQuestion(page, 'Tell the whole story.');
    await expect(page.locator('.tree')).toContainText('Chapter 1');

    await openReader(page);
    await expect(readerTitle(page)).toHaveText(title);

    // A long chapter paginates into multiple spreads. The footer folio is the
    // DISPLAYED page number (1-based: page()+1), so the last page shows N / N.
    const first = await footerFolioNumbers(page);
    expect(first.total).toBeGreaterThan(1);

    const beforeArrow = await footerFolioNumbers(page);
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => (await footerFolioNumbers(page)).page)
      .toBe(beforeArrow.page + 1);

    await page.keyboard.press('End');
    // End lands on the LAST page → the displayed page equals the total.
    await expect.poll(async () => {
      const n = await footerFolioNumbers(page);
      return n.page === n.total;
    }).toBe(true);

    await page.keyboard.press('Home');
    await expect.poll(async () => (await footerFolioNumbers(page)).page).toBe(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('.tree app-chat-node').first()).toBeVisible();
  });

  test('06 typeface and size modal restyles the reader and persists', async ({ page }) => {
    await openApp(page);
    await openChat(page, 'Getting Started');
    await openReader(page);

    // Open the type dialog (button title "Typeface and size (f)").
    await page.locator('.reader-bar button[title="Typeface and size (f)"]').click();
    await expect(page.locator('.type-dialog')).toBeVisible();

    // Default face is Georgia.
    await expect(page.locator('.reader')).toHaveCSS('font-family', /Georgia/);

    // Pick Palatino → the reader restyles immediately.
    await page.locator('.face-card').filter({ hasText: 'Palatino' }).click();
    await expect(page.locator('.reader')).toHaveCSS('font-family', /Palatino/);

    // Size preset buttons.
    await page.locator('.size-pager button').filter({ hasText: '20' }).click();
    await expect(page.locator('.reader')).toHaveCSS('font-size', '20px');

    // Done closes the modal; the reader keeps the chosen face and size.
    await page.locator('.type-actions .btn').click();
    await expect(page.locator('.type-dialog')).toHaveCount(0);
    await expect(page.locator('.reader')).toHaveCSS('font-family', /Palatino/);
    await expect(page.locator('.reader')).toHaveCSS('font-size', '20px');
  });
});

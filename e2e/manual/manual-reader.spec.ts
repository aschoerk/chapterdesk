// ---------------------------------------------------------------------------
// USER MANUAL — "Read your story as a book".
//
// Generates docs/manuals/manual-reader.md + screenshots. Opens the seeded
// "Getting Started" story and shows the read-only Reader view: book sections,
// document folio and returning to the edit tree. Non-destructive.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  bookNode,
  docFolio,
  openApp,
  openChat,
  openReader,
} from '../support/ui';
import { newManual } from './manual-support';

test('Read your story as a book', async ({ page }) => {
  const manual = newManual(page, 'manual-reader', 'Read your story as a book');

  await manual.step(
    'Open a story',
    'Open the seeded **Getting Started** story from the sidebar.',
    (p) => openApp(p).then(() => openChat(p, 'Getting Started')),
    { waitAfter: 500 },
  );

  await manual.step(
    'Open the Reader',
    'Click the book button in the navigation bar (**Reader view**). The story is shown as a clean, read-only document.',
    (p) => openReader(p),
    { waitAfter: 500, highlightTarget: page.locator('.reader-shell') },
  );

  await manual.step(
    'Scroll the book',
    'The Reader renders directions and chapters as book sections. The progress bar at the bottom tracks where you are.',
    async (p) => {
      await expect(bookNode(p, 'user')).toBeVisible();
      await expect(bookNode(p, 'assistant')).toBeVisible();
      await expect(docFolio(p)).toContainText('Doc 1 / 1');
    },
    { waitAfter: 300 },
  );

  await manual.step(
    'Return to editing',
    'Press **Escape** (or use the back navigation) to return to the editable tree.',
    async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('.tree app-chat-node').first()).toBeVisible();
    },
    { waitAfter: 300 },
  );

  await manual.generate();
});
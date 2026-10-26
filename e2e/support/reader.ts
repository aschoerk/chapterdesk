import { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Read-only navigation (chat-reader `/read`) helpers.
//
// The reader is the read-only book view of the current chat: one document per
// story continuation (`.doc-pager`), spread/page navigation, column count,
// hide-directions, typeface/size and search. It is reached from the chat page
// via the nav-bar book button (`openReader` in ./chat) or directly at
// `/#/read`. This module is standalone — it only touches the reader DOM.
// ---------------------------------------------------------------------------

export function readerShell(page: Page): ReturnType<Page['locator']> {
  return page.locator('.reader-shell');
}

export function readerTitle(page: Page): ReturnType<Page['locator']> {
  return page.locator('.reader-title');
}

/** A rendered book node of the given role (optionally narrowed by text). */
export function bookNode(
  page: Page,
  role: 'user' | 'assistant' | 'system',
  text?: string,
): ReturnType<Page['locator']> {
  const loc = page.locator(`.reader .book-node.book-${role}`);
  return text ? loc.filter({ hasText: text }).first() : loc;
}

/** The document folio ("Doc 1 / 2") inside the doc pager. */
export function docFolio(page: Page): ReturnType<Page['locator']> {
  return page.locator('.doc-pager .folio');
}

/** The footer page folio ("1 / 3") inside the progress bar. */
export function footerFolio(page: Page): ReturnType<Page['locator']> {
  return page.locator('.reader-progress-bar .folio');
}

/** Read the footer page folio as {page, total} numbers. */
export async function footerFolioNumbers(page: Page): Promise<{ page: number; total: number }> {
  const text = (await footerFolio(page).textContent()) ?? '';
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { page: Number(m[1]), total: Number(m[2]) } : { page: 0, total: 1 };
}

/** Read the resolved `--reader-cols` custom property (1 | 2 | 3). */
export async function readerColumns(page: Page): Promise<string> {
  return page
    .locator('.reader')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--reader-cols').trim());
}

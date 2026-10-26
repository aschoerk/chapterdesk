import { Page, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Chat-page helpers: story creation, chat navigation, tree/node cards, the
// inline editor and toolbar actions. These operate purely on the chat page DOM
// and have no dependency on the illustrate / create-image dialogs.
// ---------------------------------------------------------------------------

/**
 * Click the "New story" button of the given project.
 * Returns the auto-generated chat title shown in the title editor.
 */
export async function newStory(page: Page, projectName: string): Promise<string> {
  const block = page.locator('.project-block').filter({ hasText: projectName }).first();
  const createBtn = block.locator('.project-actions button[title="New story"]');
  await createBtn.click();
  const title = page.locator('.chat-title-editor .chat-title');
  await expect(title).toBeVisible();
  return (await title.textContent())?.trim() ?? '';
}

/**
 * Open an existing chat by its sidebar title.
 *
 * Chats only render inside an EXPANDED project (`.project-block` → `.chat-list`),
 * so first expand the block, then click the chat. The item's geometric center
 * overlaps an action icon (rename/clone/…), so click the `.chat-title` span —
 * a neutral area with no child button — rather than the item box.
 */
export async function openChat(page: Page, chatTitle: string): Promise<void> {
  const project = page
    .locator('.project-block')
    .filter({ hasText: 'Demo Project' })
    .first();
  const header = project.locator('.project-header');
  if (!(await project.evaluate((el) => el.classList.contains('expanded')))) {
    await header.click();
  }
  const title = page
    .locator('.chat-item')
    .filter({ hasText: chatTitle })
    .first()
    .locator('.chat-title');
  await title.click();
  await expect(page.locator('.tree app-chat-node').first()).toBeVisible();
}

/**
 * The active draft leaf shows a "click to edit" placeholder-only empty-draft.
 * Note: user nodes WITH content also carry the .empty-draft.click-to-edit
 * classes, so select the one that still shows the writeNext placeholder —
 * that uniquely identifies the real composer leaf.
 */
export async function askQuestion(page: Page, text: string): Promise<void> {
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

/** Assert that some node on the active path renders the given text. */
export async function expectNodeText(page: Page, text: string): Promise<void> {
  await expect(
    page.locator('.tree .node-content').filter({ hasText: text }).first()
  ).toBeVisible();
}

/** Assert the nav-path buttons (D/C/S chain) reflect an expected length. */
export async function expectNavPathLength(page: Page, n: number): Promise<void> {
  await expect(page.locator('.node-nav-bar .nav-node')).toHaveCount(n);
}

/** Navigate by clicking the k-th node in the nav path (1-based). */
export async function clickNavNode(page: Page, index: number): Promise<void> {
  await page.locator('.node-nav-bar .nav-node').nth(index - 1).click();
}

/** The k-th node card in the tree (0-based, active-path order). */
export function nodeCard(page: Page, index: number): ReturnType<Page['locator']> {
  return page.locator('.tree app-chat-node').nth(index);
}

/** Click a footer action button (`.node-actions`) of the k-th node card. */
export async function clickNodeAction(
  page: Page,
  nodeIndex: number,
  label: string,
): Promise<void> {
  const card = nodeCard(page, nodeIndex);
  await card
    .locator('.node-actions button')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()
    .click();
}

/** Click a header action button (`.node-header`) of the k-th node card. */
export async function clickNodeHeaderAction(
  page: Page,
  nodeIndex: number,
  label: string,
): Promise<void> {
  const card = nodeCard(page, nodeIndex);
  await card.locator('.node-header button').filter({ hasText: label }).first().click();
}

/** Open the in-place editor of the k-th node card. */
export async function openEditorAt(page: Page, nodeIndex: number): Promise<void> {
  await clickNodeAction(page, nodeIndex, 'Edit');
  await expect(page.locator('.editor-textarea').first()).toBeVisible();
}

/** The node card whose rendered content contains `text` (robust against the
 *  starter structure/greeting nodes a new story is pre-populated with). */
export function nodeFor(page: Page, text: string): ReturnType<Page['locator']> {
  return page
    .locator('.tree app-chat-node')
    .filter({ hasText: text })
    .first();
}

/** Click a footer action on the node whose content contains `nodeText`. */
export async function clickNodeActionOn(page: Page, nodeText: string, label: string): Promise<void> {
  await nodeFor(page, nodeText).locator('.node-actions button').filter({ has: page.getByText(label, { exact: true }) }).first().click();
}

/** Open the in-place editor of the node whose content contains `nodeText`. */
export async function openEditorOn(page: Page, nodeText: string): Promise<void> {
  await clickNodeActionOn(page, nodeText, 'Edit');
  await expect(page.locator('.editor-textarea').first()).toBeVisible();
}

/** Click a toolbar action on the chat page (params-bar row). */
export async function clickChatToolbarAction(page: Page, label: string): Promise<void> {
  await page.locator('.params-bar button').filter({ hasText: label }).first().click();
}

/** Accept the custom confirmation dialog (regenerate/rewrite/remove…). */
export async function acceptConfirmDialog(page: Page): Promise<void> {
  await page.locator('.confirm-dialog .confirm-actions .btn.primary').click();
}

/** Collect + auto-accept native `alert()` calls raised by the app. */
export function captureAlerts(page: Page): string[] {
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  return messages;
}

// ---------------------------------------------------------------------------
// Editor + text-selection helpers (rewrite, language check, image-send).
// ---------------------------------------------------------------------------

/** Fill the editor textarea and set the selection to `[start, end]`. */
export async function editSelection(
  page: Page,
  text: string,
  sel: [number, number],
): Promise<void> {
  const editor = page.locator('.editor-textarea').first();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await editor.evaluate((el, [s, e]) => {
    const ta = el as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(s, e);
  }, sel);
}

/**
 * Select a piece of text in a RENDERED (non-edit) node card so the
 * rewrite/create-image actions pick it up via window.getSelection().
 * `nodeText` anchors the node by its rendered content (robust against the
 * starter nodes), `search` is the exact substring to select.
 */
export async function selectNodeText(page: Page, nodeText: string, search: string): Promise<void> {
  await page.evaluate(
    ({ q, text }) => {
      const cards = Array.from(document.querySelectorAll('.tree app-chat-node'));
      const card = cards.find((el) => (el.textContent ?? '').includes(text));
      const root = card?.querySelector('.node-content');
      if (!root) throw new Error(`node with text "${text}" not found`);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let startNode: Node | null = null;
      let startOffset = -1;
      let length = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const at = node.textContent?.indexOf(q);
        if (at !== undefined && at >= 0) {
          startNode = node;
          startOffset = at;
          length = q.length;
          break;
        }
      }
      if (!startNode) throw new Error(`text "${q}" not found in node "${text}"`);
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(startNode, startOffset + length);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    },
    { q: search, text: nodeText },
  );
}

// ---------------------------------------------------------------------------
// Node-nav-bar helpers (active-path nav buttons, multi-select, paste, resize)
// ---------------------------------------------------------------------------

/** The k-th nav node button (1-based) in the node-nav-bar. */
export function navNode(page: Page, index: number): ReturnType<Page['locator']> {
  return page.locator('.node-nav-bar .nav-node').nth(index - 1);
}

/** Right-click the k-th nav node to open its inline context menu. */
export async function openNavNodeMenu(page: Page, index: number): Promise<void> {
  await navNode(page, index).click({ button: 'right' });
  await expect(page.locator('.nav-paste-menu.nav-node-menu')).toBeVisible();
}

/** Click an item with the given label inside the open nav-bar menu. */
export async function clickNavMenuAction(page: Page, label: string): Promise<void> {
  await page
    .locator('.nav-paste-menu .nav-paste-item')
    .filter({ hasText: label })
    .first()
    .click();
}

/** Ctrl+click the k-th nav node (toggles navbar multi-selection). */
export async function ctrlClickNavNode(page: Page, index: number): Promise<void> {
  await navNode(page, index).click({ modifiers: ['Control'] });
}

/** Assert the k-th nav node is (or is not) part of the navbar selection. */
export async function expectNavNodeSelected(
  page: Page,
  index: number,
  selected: boolean,
): Promise<void> {
  const node = navNode(page, index);
  if (selected) {
    await expect(node).toHaveClass(/selected/);
  } else {
    await expect(node).not.toHaveClass(/selected/);
  }
}

/** Assert the navbar selection toolbar shows the given selected count. */
export async function expectNavSelection(page: Page, count: number): Promise<void> {
  await expect(page.locator('.nav-tools')).toBeVisible();
  await expect(page.locator('.nav-selection-info')).toContainText(`${count} selected`);
}

/** The ⤵ paste button that follows the k-th nav node (only rendered when the
 *  clipboard has content and pasting there is allowed). */
export function navPasteButtonAfter(page: Page, index: number): ReturnType<Page['locator']> {
  return navNode(page, index).locator(
    'xpath=following-sibling::*[contains(@class,"nav-paste-after")][1]',
  );
}

/** Open the read-only reader view for the current chat via the nav-bar book
 *  button (the `.node-nav-bar` is part of the chat page, so call this while a
 *  chat is open). */
export async function openReader(page: Page): Promise<void> {
  await page.locator('.node-nav-bar button[title="Open reader view (Ctrl-B)"]').click();
  await expect(page.locator('.reader-shell')).toBeVisible();
}

/** Read the rendered node-nav-bar height (px). */
export async function navBarHeightPx(page: Page): Promise<number> {
  return page.locator('.node-nav-bar').evaluate((el) => el.getBoundingClientRect().height);
}

/** Drag the nav-bar vertical separator by `deltaY` px (a real pointer drag —
 *  the same interaction a user performs to grow the bar). */
export async function dragNavResizer(page: Page, deltaY: number): Promise<void> {
  const resizer = page.locator('.nav-resizer');
  await resizer.waitFor({ state: 'visible' });
  const box = await resizer.boundingBox();
  if (!box) throw new Error('nav-resizer has no bounding box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + deltaY, { steps: 10 });
  await page.mouse.up();
}

// ---------------------------------------------------------------------------
// Chat-node right-click (context) menu helpers
// ---------------------------------------------------------------------------

/** Right-click the node card whose rendered content contains `nodeText`. */
export async function openNodeContextMenu(page: Page, nodeText: string): Promise<void> {
  await nodeFor(page, nodeText).click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
}

/** A `.ctx-item` inside the open node context menu (matched by label). */
export function ctxMenuItem(page: Page, label: string): ReturnType<Page['locator']> {
  return page.locator('.context-menu .ctx-item').filter({ hasText: label }).first();
}

/** Click a `.ctx-item` — the menu closes and the action runs. */
export async function clickCtxAction(page: Page, label: string): Promise<void> {
  await ctxMenuItem(page, label).click();
  await expect(page.locator('.context-menu')).toHaveCount(0);
}

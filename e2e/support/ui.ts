import { Page, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Reusable UI steps for chapterdesk. Each function packages ONE step of a
// recorded usecase ("do it by hand once, then parameterize") so tests read as
// a list of named actions and stay robust against layout changes.
// ---------------------------------------------------------------------------

/**
 * The sidebar is a drag-resizable pane (`.sidebar-pane` width in px, persisted
 * to `chat-client.sidebar.width`, range 200–720). A narrow sidebar clips the
 * project-actions row ("New story" / edit / delete books) or collapses the
 * project list, so the orchestration tests widen it first. We BOTH:
 *  1. seed the persisted width before the app boots (so `ChatLayoutPrefsService`
 *     reads it in its constructor), and
 *  2. actually drag the `.sidebar-resizer` handle to the target width — a real
 *     pointer drag that exercises the same interaction a user performs.
 */
export const SIDEBAR_WIDTH_TARGET = 640;

/** Seed the persisted sidebar width before any page script runs. */
export async function seedSidebarWidth(page: Page, width = SIDEBAR_WIDTH_TARGET): Promise<void> {
  await page.addInitScript((w) => {
    try {
      localStorage.setItem('chat-client.sidebar.width', String(w));
    } catch {
      /* ignore */
    }
  }, width);
}

/** Read the current rendered sidebar width (px). */
export async function sidebarWidth(page: Page): Promise<number> {
  return page.locator('.sidebar-pane').evaluate((el) => {
    const w = parseFloat(getComputedStyle(el).width);
    return Number.isFinite(w) ? w : -1;
  });
}

/**
 * Drag the sidebar resizer handle until the pane is at least `targetPx` wide.
 * Real pointer drag on `.sidebar-resizer` (the same interaction the UI offers).
 */
export async function widenSidebar(page: Page, targetPx = SIDEBAR_WIDTH_TARGET): Promise<void> {
  const resizer = page.locator('.sidebar-resizer');
  await resizer.waitFor({ state: 'visible' });
  const pane = page.locator('.sidebar-pane');
  await pane.waitFor({ state: 'visible' });

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = Number(await sidebarWidth(page));
    if (current >= targetPx - 1) return;

    const box = await resizer.boundingBox();
    if (!box) return;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const delta = targetPx - current;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move in steps so the pointermove handler emits successive widths.
    await page.mouse.move(startX + delta, startY, { steps: 15 });
    await page.mouse.up();
  }

  // Final assertion: the pane must now be wide (bounded by 60% of the window
  // and the 720px max — on a small viewport the target may not be reachable,
  // so assert it grew instead of exact equality).
  const final = Number(await sidebarWidth(page));
  expect(final).toBeGreaterThanOrEqual(500);
}

export async function openApp(page: Page): Promise<void> {
  // Single origin (docker-compose.e2e.yml): SPA + API + proxy on the same
  // host, so the Angular client resolves the API base from window.location.
  // Make the sidebar fully visible FIRST (drag the splitter wide), so every
  // project action ("New story" etc.) is on screen for all use cases.
  await seedSidebarWidth(page);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await widenSidebar(page);
}

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

/** Number of picture thumbs on the node whose content contains `nodeText`. */
export async function expectImageThumbsOn(page: Page, nodeText: string, count: number): Promise<void> {
  await expect(nodeFor(page, nodeText).locator('.chip img.thumb')).toHaveCount(count);
}

/** Click the "Illustrate" action on the node whose content contains `nodeText`. */
export async function openIllustrateOn(page: Page, nodeText: string): Promise<void> {
  await clickNodeActionOn(page, nodeText, 'Illustrate');
  await expect(page.locator('.illustrate-dialog')).toBeVisible();
}

/** One-shot Illustrate configured, targeted at the node containing `nodeText`.
 *  See `illustrate()` for the option semantics. */
export async function illustrateOn(
  page: Page,
  nodeText: string,
  opts: Parameters<typeof illustrate>[1] = { mode: 'direct' },
): Promise<void> {
  await openIllustrateOn(page, nodeText);
  if (opts.count !== undefined) await setIllustrateCount(page, opts.count);
  if (opts.mode === 'planned') await setIllustrateUsecase(page, 'Plan descriptions first');
  if (opts.mode === 'direct') await setIllustrateUsecase(page, 'Direct to image model');
  if (opts.mode === 'pure') await setIllustrateUsecase(page, 'Pure picture mode');
  if (opts.context) await setIllustrateContextMode(page, opts.context);
  if (opts.windowCount !== undefined) await setIllustrateWindowCount(page, opts.windowCount);
  if (opts.style !== undefined) await setIllustrateStyle(page, opts.style);
  if (opts.rules !== undefined) await setIllustrateStoryRules(page, opts.rules);
  await confirmIllustrate(page);
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
// Illustrate dialog helpers
// ---------------------------------------------------------------------------

/** Click the "Illustrate" action on an assistant node, then wait for the
 *  dialog. Returns a handle for filling the dialog. */
export async function openIllustrate(page: Page, nodeIndex = 1): Promise<void> {
  await clickNodeAction(page, nodeIndex, 'Illustrate');
  await expect(page.locator('.illustrate-dialog')).toBeVisible();
}

/** Choose one of the three Use-case radios by its label text. */
export async function setIllustrateUsecase(page: Page, label: string): Promise<void> {
  await page
    .locator('.illustrate-dialog label.ill-radio')
    .filter({ hasText: label })
    .first()
    .click();
}

/** Set the Number of pictures / scenes input. */
export async function setIllustrateCount(page: Page, count: number): Promise<void> {
  const field = page
    .locator('.illustrate-dialog label.ill-field')
    .filter({ hasText: 'Number of pictures' })
    .first();
  await field.locator('input[type="number"]').fill(String(count));
}

/** Choose one of the Story-text-to-use radios by its label text. */
export async function setIllustrateContextMode(page: Page, label: string): Promise<void> {
  await page
    .locator('.illustrate-dialog label.ill-radio')
    .filter({ hasText: label })
    .first()
    .click();
}

/** Set the window width (the "Last beats" inline count). */
export async function setIllustrateWindowCount(page: Page, n: number): Promise<void> {
  await page.locator('.illustrate-dialog input.ill-window-count').fill(String(n));
}

/** Set the Style single-line input. */
export async function setIllustrateStyle(page: Page, style: string): Promise<void> {
  await page
    .locator('.illustrate-dialog label.ill-field')
    .filter({ hasText: 'Style' })
    .first()
    .locator('input[type="text"]')
    .fill(style);
}

/** Set the Additional rules textarea. */
export async function setIllustrateStoryRules(page: Page, rules: string): Promise<void> {
  const field = page
    .locator('.illustrate-dialog label.ill-field')
    .filter({ hasText: 'Additional rules' })
    .first();
  await field.locator('textarea').fill(rules);
}

/** Confirm the Illustrate dialog ("Generate" button). */
export async function confirmIllustrate(page: Page): Promise<void> {
  await page.locator('.illustrate-dialog .illustrate-actions .btn.primary').click();
}

/**
 * One-shot helper: open Illustrate and configure it. `mode`: 'planned' |
 * 'direct' | 'pure' (radio label matched by substring). `context`: the
 * story-text radio label ('Current text only' | 'Last beats up to this point'
 * | 'All story text up to this point').
 */
export async function illustrate(
  page: Page,
  opts: {
    nodeIndex?: number;
    count?: number;
    mode: 'planned' | 'direct' | 'pure';
    context?: string;
    windowCount?: number;
    style?: string;
    rules?: string;
  } = { mode: 'direct' },
): Promise<void> {
  await openIllustrate(page, opts.nodeIndex ?? 1);
  if (opts.count !== undefined) await setIllustrateCount(page, opts.count);
  if (opts.mode === 'planned') await setIllustrateUsecase(page, 'Plan descriptions first');
  if (opts.mode === 'direct') await setIllustrateUsecase(page, 'Direct to image model');
  if (opts.mode === 'pure') await setIllustrateUsecase(page, 'Pure picture mode');
  if (opts.context) await setIllustrateContextMode(page, opts.context);
  if (opts.windowCount !== undefined) await setIllustrateWindowCount(page, opts.windowCount);
  if (opts.style !== undefined) await setIllustrateStyle(page, opts.style);
  if (opts.rules !== undefined) await setIllustrateStoryRules(page, opts.rules);
  await confirmIllustrate(page);
}

/** Number of picture thumbnails currently attached to a node card. */
export async function expectImageThumbs(page: Page, count: number, nodeIndex = 1): Promise<void> {
  await expect(nodeCard(page, nodeIndex).locator('.chip img.thumb')).toHaveCount(count);
}

// ---------------------------------------------------------------------------
// Editor-based flow helpers (editor rewrite / language check)
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

/** Click the create-image dialog's "Create" button. */
export async function confirmCreateImage(page: Page): Promise<void> {
  await page.locator('.cimg-dialog .cimg-actions .btn.primary').click();
}

/** The k-th textarea of the create-image dialog (0 = constant, 1 = script). */
export async function setCreateImageText(page: Page, index: number, text: string): Promise<void> {
  await page.locator('.cimg-dialog textarea').nth(index).fill(text);
}
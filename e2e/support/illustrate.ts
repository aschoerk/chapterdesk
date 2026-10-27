import { Page, expect } from '@playwright/test';
import { clickNodeAction, clickNodeActionOn, nodeCard, nodeFor } from './chat';

// ---------------------------------------------------------------------------
// Illustrate dialog + create-image dialog helpers. These need the chat-node
// locators (nodeFor / clickNodeActionOn) to target a specific node, so they
// live separately from the pure chat-page helpers.
// ---------------------------------------------------------------------------

// ---- count assertions on node cards --------------------------------------

/** Number of picture thumbs on the node whose content contains `nodeText`. */
export async function expectImageThumbsOn(page: Page, nodeText: string, count: number): Promise<void> {
  await expect(nodeFor(page, nodeText).locator('.chip img.thumb')).toHaveCount(count);
}

/** Number of picture thumbnails currently attached to a node card. */
export async function expectImageThumbs(page: Page, count: number, nodeIndex = 1): Promise<void> {
  await expect(nodeCard(page, nodeIndex).locator('.chip img.thumb')).toHaveCount(count);
}

// ---- opening the dialog ---------------------------------------------------

/** Click the "Illustrate" action on the node whose content contains `nodeText`. */
export async function openIllustrateOn(page: Page, nodeText: string): Promise<void> {
  await clickNodeActionOn(page, nodeText, 'Illustrate');
  await expect(page.locator('.illustrate-dialog')).toBeVisible();
}

/** Click the "Illustrate" action on an assistant node, then wait for the
 *  dialog. Returns a handle for filling the dialog. */
export async function openIllustrate(page: Page, nodeIndex = 1): Promise<void> {
  await clickNodeAction(page, nodeIndex, 'Illustrate');
  await expect(page.locator('.illustrate-dialog')).toBeVisible();
}

// ---- filling the dialog ---------------------------------------------------

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

/** Set the "Scene to depict" textarea (pre-filled with a marked fragment;
 *  leave empty to use the whole chapter as the scene). */
export async function setIllustrateScene(page: Page, scene: string): Promise<void> {
  await page
    .locator('.illustrate-dialog label.ill-field')
    .filter({ hasText: 'Scene to depict' })
    .first()
    .locator('textarea')
    .fill(scene);
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
    scene?: string;
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
  if (opts.scene !== undefined) await setIllustrateScene(page, opts.scene);
  await confirmIllustrate(page);
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
  if (opts.scene !== undefined) await setIllustrateScene(page, opts.scene);
  await confirmIllustrate(page);
}

// ---- create-image dialog ---------------------------------------------------

/** Click the create-image dialog's "Create" button. */
export async function confirmCreateImage(page: Page): Promise<void> {
  await page.locator('.cimg-dialog .cimg-actions .btn.primary').click();
}

/** The k-th textarea of the create-image dialog (0 = constant, 1 = script). */
export async function setCreateImageText(page: Page, index: number, text: string): Promise<void> {
  await page.locator('.cimg-dialog textarea').nth(index).fill(text);
}

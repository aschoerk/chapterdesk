// ---------------------------------------------------------------------------
// SETTINGS — Prompt defaults.
//
// Prompt versions/selections live in the shared API database (like providers),
// so every test uses unique version names and deletes what it created. Data is
// loaded/reactive, so the UI updates in place without reloads.
//
// The "Story title" template (structure.title) is used as the canonical card.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  createTopic,
  deletePromptVersion,
  deleteTopic,
  gotoPromptDefaults,
  promptCard,
  promptSourceLabel,
  promptTextarea,
  renamePromptVersion,
  saveAsVersion,
  setCurrentTopic,
  uniqueName,
} from '../support/ui';

const TEMPLATE = 'Story title';

function revertBtn(page: import('@playwright/test').Page) {
  return promptCard(page, TEMPLATE).locator('.prompt-head .btn');
}

test.describe('settings: prompt defaults', () => {
  test('01 customize a template: save as version becomes the active your-version', async ({ page }) => {
    await gotoPromptDefaults(page);
    const version = uniqueName('Version');

    // Default state: built-in default active, no customisations yet.
    await expect(promptSourceLabel(page, TEMPLATE)).toContainText('built-in default');
    await expect(revertBtn(page)).toBeDisabled();
    await expect(page.locator('.count-badge')).toHaveText('all defaults');

    // Save a new version from the current built-in text.
    await saveAsVersion(page, TEMPLATE, version);
    await expect(promptCard(page, TEMPLATE)).toHaveClass(/custom/);
    await expect(promptSourceLabel(page, TEMPLATE)).toContainText(`your version “${version}”`);
    await expect(page.locator('.count-badge')).toHaveText('1 customized');
    await expect(revertBtn(page)).toBeEnabled();

    // Cleanup.
    await deletePromptVersion(page, TEMPLATE, version);
  });

  test('02 edit the active version (Save changes persist across reload)', async ({ page }) => {
    await gotoPromptDefaults(page);
    const version = uniqueName('Version');
    await saveAsVersion(page, TEMPLATE, version);
    await expect(promptSourceLabel(page, TEMPLATE)).toContainText(`your version “${version}”`);

    // Edit the textarea → a draft bar with "Save changes" appears.
    const edited = `E2E edited body — ${version}`;
    await promptTextarea(page, TEMPLATE).fill(edited);
    const draftBar = promptCard(page, TEMPLATE).locator('.prompt-draft-bar');
    await expect(draftBar).toBeVisible();
    await draftBar.locator('button.btn.primary').filter({ hasText: 'Save changes' }).click();

    // The save completes when the draft bar closes again.
    await expect(promptCard(page, TEMPLATE).locator('.prompt-draft-bar')).toHaveCount(0);

    // Persisted to the active version → survives a reload.
    await page.reload();
    await expect(page.locator('.config-shell')).toBeVisible();
    await expect(promptSourceLabel(page, TEMPLATE)).toContainText(`your version “${version}”`);
    await expect(promptTextarea(page, TEMPLATE)).toHaveValue(edited);

    await deletePromptVersion(page, TEMPLATE, version);
  });

  test('03 rename a version in the All-versions list', async ({ page }) => {
    await gotoPromptDefaults(page);
    const version = uniqueName('Version');
    const renamed = `${version} (renamed)`;
    await saveAsVersion(page, TEMPLATE, version);

    await renamePromptVersion(page, TEMPLATE, version, renamed);
    await expect(promptSourceLabel(page, TEMPLATE)).toContainText(`your version “${renamed}”`);

    await deletePromptVersion(page, TEMPLATE, renamed);
  });

  test('04 delete the version → back to default; unknown-token warning + discard', async ({ page }) => {
    await gotoPromptDefaults(page);
    const version = uniqueName('Version');
    await saveAsVersion(page, TEMPLATE, version);
    await expect(promptCard(page, TEMPLATE)).toHaveClass(/custom/);

    // Typing an unknown {{token}} surfaces the warning.
    await promptTextarea(page, TEMPLATE).fill('Use {{bogusToken}} here.');
    await expect(promptCard(page, TEMPLATE).locator('.prompt-warn')).toContainText('{{bogusToken}}');

    // Discard clears the draft (warning disappears, text returns to the source).
    const discard = promptCard(page, TEMPLATE).getByRole('button', { name: 'Discard' });
    await expect(discard).toBeVisible();
    // force: the draft bar re-renders aggressively; skip the stability wait.
    await discard.click({ force: true });
    await expect(promptCard(page, TEMPLATE).locator('.prompt-warn')).toHaveCount(0);

    // Deleting the active version reverts the card to the built-in default.
    await deletePromptVersion(page, TEMPLATE, version);
    await expect(promptCard(page, TEMPLATE)).not.toHaveClass(/custom/);
    await expect(promptSourceLabel(page, TEMPLATE)).toContainText('built-in default');
    await expect(revertBtn(page)).toBeDisabled();
  });

  test('05 create a topic-scoped version for the current topic', async ({ page }) => {
    const topic = uniqueName('Topic');
    await createTopic(page, topic);
    await setCurrentTopic(page, topic);

    await gotoPromptDefaults(page);
    await expect(page.locator('.config-content')).toContainText(`Topic scope: “${topic}”`);

    const version = uniqueName('TopicVersion');
    await saveAsVersion(page, TEMPLATE, version, 'topic');

    await expect(promptSourceLabel(page, TEMPLATE)).toContainText(
      `topic “${topic}” version “${version}”`,
    );
    await expect(promptCard(page, TEMPLATE)).toHaveClass(/custom/);

    await deletePromptVersion(page, TEMPLATE, version);
    await deleteTopic(page, topic);
  });

  test('06 Reset all restores every template to the built-in default', async ({ page }) => {
    await gotoPromptDefaults(page);
    const version = uniqueName('Version');
    await saveAsVersion(page, TEMPLATE, version);
    await expect(page.locator('.count-badge')).toHaveText('1 customized');

    await page.locator('.page-header .actions .btn.danger').click();
    await expect(page.locator('.count-badge')).toHaveText('all defaults');
    await expect(promptCard(page, TEMPLATE)).not.toHaveClass(/custom/);
    await expect(promptSourceLabel(page, TEMPLATE)).toContainText('built-in default');

    // Reset-all only drops selections — the stored version survives until
    // deleted explicitly, so clean up the one this test created.
    await deletePromptVersion(page, TEMPLATE, version);
    await expect(page.locator('.prompt-version-item').filter({ hasText: version })).toHaveCount(0);
  });
});

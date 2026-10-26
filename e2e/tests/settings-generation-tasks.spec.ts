// ---------------------------------------------------------------------------
// SETTINGS — Generation tasks.
//
// Per-task provider/model/prompt choices are localStorage-backed (fresh per
// browser context). In the E2E Docker environment the demo-data bootstrap
// ("Mock (no key)" writer defaults) pre-fills the authoring tasks, so tests
// start from a known, pre-set state and Reset brings a task back to
// inherit/empty.
//
// Task card labels (config.generation.tasks.*): "Default model", "Titles",
// "Headings", "Overviews", "Image creation", "Image interpretation",
// "Language correction".
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  gotoGenerationTasks,
  resetTask,
  setTask,
  taskModelInput,
  taskPromptTextarea,
  taskProviderSelect,
} from '../support/ui';

test.describe('settings: generation tasks', () => {
  test('01 docker bootstrap pre-fills the authoring tasks with the mock writer', async ({ page }) => {
    await gotoGenerationTasks(page);

    // The "Default model" task is pre-configured onto the key-free mock.
    const provider = taskProviderSelect(page, 'Default model');
    await expect(provider.locator('option:checked')).toHaveText('Mock (no key)');
    await expect(taskModelInput(page, 'Default model')).toHaveValue('mock-writer');

    // "Image creation" gets the mock image model (image output).
    await expect(taskProviderSelect(page, 'Image creation').locator('option:checked')).toHaveText('Mock (no key)');
    await expect(taskModelInput(page, 'Image creation')).toHaveValue('mock-image');
  });

  test('02 configure a task (provider/model/prompt) and it persists across reload', async ({ page }) => {
    await gotoGenerationTasks(page);
    await resetTask(page, 'Titles');

    await setTask(page, 'Titles', {
      providerName: 'Mock LLM',
      modelId: 'mock-model',
      prompt: 'Suggest a punchy title.',
    });

    await expect(taskProviderSelect(page, 'Titles').locator('option:checked')).toHaveText('Mock LLM');
    await expect(taskModelInput(page, 'Titles')).toHaveValue('mock-model');
    await expect(taskPromptTextarea(page, 'Titles')).toHaveValue('Suggest a punchy title.');

    // Persisted in localStorage → survives a reload.
    await page.reload();
    await expect(page.locator('.config-shell')).toBeVisible();
    await expect(taskProviderSelect(page, 'Titles').locator('option:checked')).toHaveText('Mock LLM');
    await expect(taskModelInput(page, 'Titles')).toHaveValue('mock-model');
    await expect(taskPromptTextarea(page, 'Titles')).toHaveValue('Suggest a punchy title.');
  });

  test('03 Reset clears a task back to inherit / empty', async ({ page }) => {
    await gotoGenerationTasks(page);
    await resetTask(page, 'Headings');
    await expect(taskModelInput(page, 'Headings')).toHaveValue('');
    await expect(taskPromptTextarea(page, 'Headings')).toHaveValue('');

    // Re-configure and reset again.
    await setTask(page, 'Headings', { providerName: 'Mock LLM', modelId: 'mock-model', prompt: 'H2' });
    await expect(taskModelInput(page, 'Headings')).toHaveValue('mock-model');
    await resetTask(page, 'Headings');
    await expect(taskProviderSelect(page, 'Headings')).toHaveValue('');
    await expect(taskModelInput(page, 'Headings')).toHaveValue('');
    await expect(taskPromptTextarea(page, 'Headings')).toHaveValue('');
  });
});

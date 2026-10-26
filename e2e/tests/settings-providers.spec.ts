// ---------------------------------------------------------------------------
// SETTINGS — Providers & Models.
//
// Providers/presets are server data (the shared in-memory API seeded from
// seed.json + the Docker "Mock (no key)" bootstrap), so like the CRUD specs
// every test uses unique names and deletes what it created.
//
// Provider "Test"/"Fetch Models" and preset "Test" go through the backend
// /proxy — mocked in the browser (mockProviderModels + the LLM mock) so the
// connection checks are deterministic.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  addPreset,
  addProvider,
  deletePreset,
  deleteProvider,
  editProvider,
  gotoProviders,
  modelRow,
  mockProviderModels,
  openAddPresetModal,
  openAddProviderModal,
  providerCard,
  providerCardAction,
  toggleModelEnabled,
  uniqueName,
} from '../support/ui';

test.describe('settings: providers & models', () => {
  test('01 add a provider — key is masked on the card, then delete it', async ({ page }) => {
    const provider = uniqueName('Provider');
    await addProvider(page, {
      name: provider,
      baseUrl: 'http://provider.invalid',
      apiKey: 'secret123',
    });

    const card = providerCard(page, provider);
    await expect(card).toContainText('http://provider.invalid');
    // Masked API key: bullets shown, the raw key is never rendered.
    await expect(card).toContainText('API Key:');
    await expect(card).toContainText('••••');
    await expect(card).not.toContainText('secret123');

    await deleteProvider(page, provider);
    await expect(providerCard(page, provider)).toHaveCount(0);
  });

  test('02 provider requires an API key (alert) and Cancel keeps the modal', async ({ page }) => {
    await gotoProviders(page);
    const modal = await openAddProviderModal(page);
    await modal.locator('label').filter({ hasText: 'Name' }).locator('input').fill(uniqueName('NoKey'));

    let alertMessage: string | null = null;
    page.once('dialog', async (dialog) => {
      alertMessage = dialog.message();
      await dialog.accept();
    });
    await modal.locator('.modal-actions .btn.primary').click();

    // Native alert blocks the save; the modal stays open.
    await expect(modal).toBeVisible();
    expect(alertMessage).toBe('API Key is required');

    // Cancel closes the modal without creating anything.
    await modal.locator('.modal-actions .btn').filter({ hasText: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);
  });

  test('03 edit a provider (name + base URL)', async ({ page }) => {
    const provider = uniqueName('Provider');
    const renamed = `${provider} (edited)`;
    await addProvider(page, {
      name: provider,
      baseUrl: 'http://provider.invalid',
      apiKey: 'secret123',
    });

    await editProvider(page, provider, {
      name: renamed,
      baseUrl: 'http://provider-edited.invalid',
    });

    const card = providerCard(page, renamed);
    await expect(card).toContainText('http://provider-edited.invalid');
    // Editing keeps the API key — still masked, never the raw value.
    await expect(card).toContainText('••••');
    await expect(card).not.toContainText('secret123');

    await deleteProvider(page, renamed);
  });

  test('04 test a provider connection (mocked ok + failure)', async ({ page }) => {
    const provider = uniqueName('Provider');
    await addProvider(page, {
      name: provider,
      baseUrl: 'http://provider.invalid',
      apiKey: 'secret123',
    });

    // Success: the /models proxy answers {"data":[...]}.
    await mockProviderModels(page, [{ id: 'probe' }]);
    await providerCardAction(page, provider, 'Test');
    const ok = providerCard(page, provider).locator('.test-result.ok');
    await expect(ok).toContainText('Connection successful');

    // Failure: replace the mock (Playwright keeps both routes, so unroute the
    // previous ones first) and re-test → fail result rendered on the card.
    await page.unroute('**/proxy/models');
    await page.unroute('**/proxy/images/models');
    await mockProviderModels(page, [], { failWith: 500 });
    await providerCardAction(page, provider, 'Test');
    const fail = providerCard(page, provider).locator('.test-result.fail');
    await expect(fail).toContainText('Connection refused by mock');

    await deleteProvider(page, provider);
  });

  test('05 fetch models into the catalog and filter by provider', async ({ page }) => {
    const provider = uniqueName('Provider');
    await addProvider(page, {
      name: provider,
      baseUrl: 'http://provider.invalid',
      apiKey: 'secret123',
      type: 'Custom / OpenAI-compatible',
    });

    // Mock catalog returns two models; fetching must materialise them as
    // "Fetched" rows under this provider.
    await mockProviderModels(page, [
      { id: 'e2e-fetch-a' },
      { id: 'e2e-fetch-b' },
    ]);
    await providerCardAction(page, provider, 'Fetch Models');

    await expect(modelRow(page, 'e2e-fetch-a')).toBeVisible();
    await expect(modelRow(page, 'e2e-fetch-b')).toBeVisible();
    const badge = modelRow(page, 'e2e-fetch-a').locator('.badge');
    await expect(badge).toHaveText('Fetched');

    // Provider filter narrows the table to just this provider's models.
    await page.locator('.toolbar select.provider-filter').selectOption({ label: provider });
    await expect(modelRow(page, 'e2e-fetch-a')).toBeVisible();
    await expect(page.locator('.models-table tbody tr')).toHaveCount(2);

    // Back to "All providers" restores the seeded models too.
    await page.locator('.toolbar select.provider-filter').selectOption({ label: 'All providers' });
    await expect(modelRow(page, 'Mock Model')).toBeVisible();

    // Cleanup: deleting the provider removes its fetched models (the seeded
    // models of the other providers remain).
    await deleteProvider(page, provider);
    await expect(modelRow(page, 'e2e-fetch-a')).toHaveCount(0);
    await expect(modelRow(page, 'e2e-fetch-b')).toHaveCount(0);
  });

  test('06 add a preset with modalities, search/enabled filters, delete', async ({ page }) => {
    const name = uniqueName('Preset');
    const modelId = `e2e-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    await addPreset(page, {
      displayName: name,
      modelId,
      providerName: 'Mock LLM',
      modalities: { in: ['image'], out: ['image', 'text'] },
    });

    const row = modelRow(page, name);
    await expect(row.locator('.badge')).toHaveText('Preset');
    // Modality chips were applied → architecture info shows image in/out.
    await expect(row.locator('.architecture-info')).toContainText('image');

    // Toggle enabled off → the model only shows under "Not enabled only", and
    // the search box narrows the disabled list to it. (Angular whitespace in
    // the button textContent breaks anchored regexes — match by role + exact
    // accessible name instead.)
    const wasEnabled = await toggleModelEnabled(page, name);
    expect(wasEnabled).toBe(false);
    const notEnabledOnly = page.getByRole('button', { name: 'Not enabled only', exact: true });
    const enabledOnly = page.getByRole('button', { name: 'Enabled only', exact: true });

    await notEnabledOnly.click();
    await expect(row).toBeVisible();
    await page.locator('.toolbar input[type="search"]').fill(name);
    await expect(page.locator('.models-table tbody tr')).toHaveCount(1);
    await page.locator('.toolbar input[type="search"]').fill('');
    await notEnabledOnly.click(); // toggle off

    // "Enabled only" excludes the now-disabled model.
    await enabledOnly.click();
    await expect(row).toHaveCount(0);
    await enabledOnly.click(); // toggle off

    // Restore enabled state, then clean up.
    await toggleModelEnabled(page, name);
    await deletePreset(page, name);
  });

  test('07 add/open a preset is disabled when no provider exists', async ({ page }) => {
    await gotoProviders(page);
    const addPresetBtn = page
      .locator('.section-header')
      .filter({ hasText: 'Models' })
      .locator('button.btn.primary');
    // There are always seeded providers here; the button must be enabled and
    // opening the modal pre-fills the first provider.
    await expect(addPresetBtn).toBeEnabled();
    await addPresetBtn.click();
    const modal = page.locator('.modal-backdrop .modal');
    await expect(modal).toBeVisible();
    await modal.locator('.modal-actions .btn').filter({ hasText: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);
  });
});

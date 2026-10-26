// ---------------------------------------------------------------------------
// PERSONA — Create / Use / Edit / Delete (separated usecases).
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import {
  createPersona,
  createTopic,
  deletePersona,
  deleteTopic,
  editPersona,
  gotoPersonas,
  personaCard,
  personaMenuAction,
  setCurrentPersona,
  uniqueName,
} from '../support/ui';

test.describe('persona: create / use / edit / delete', () => {
  test('01 create a persona in a topic and find it via search', async ({ page }) => {
    const topic = uniqueName('Topic');
    const persona = uniqueName('Persona');
    await createTopic(page, topic);
    await createPersona(page, persona, topic, {
      shortName: persona.slice(0, 2),
      description: 'A persona created by the e2e suite',
    });

    const card = personaCard(page, persona);
    await expect(card.locator('.card-body .name')).toHaveText(persona);
    await expect(card).toContainText('A persona created by the e2e suite');

    // Search narrows to it.
    const search = page.locator('.personas-page .toolbar input[type="search"]');
    await search.fill(persona);
    await expect(personaCard(page, persona)).toBeVisible();
    await search.fill('zzz-no-such-persona');
    await expect(personaCard(page, persona)).toHaveCount(0);

    await deletePersona(page, persona);
    await deleteTopic(page, topic);
  });

  test('02 set a persona as the current persona', async ({ page }) => {
    const topic = uniqueName('Topic');
    const persona = uniqueName('Persona');
    await createTopic(page, topic);
    await createPersona(page, persona, topic);

    // "Use": mark it as the current persona via the card menu; the card then
    // shows the "Current" badge.
    await setCurrentPersona(page, persona);
    await expect(personaCard(page, persona).locator('.current-badge').first()).toBeVisible();

    // Cleanup: deselect as current (client-side) and delete the persona.
    await gotoPersonas(page);
    await personaMenuAction(page, persona, 'Set as current'); // toggles nothing, but ensures a usable state
    await deletePersona(page, persona);
    await deleteTopic(page, topic);
  });

  test('03 edit a persona (name + description)', async ({ page }) => {
    const topic = uniqueName('Topic');
    const persona = uniqueName('Persona');
    const renamed = `${persona} (edited)`;
    await createTopic(page, topic);
    await createPersona(page, persona, topic, { description: 'before' });

    await editPersona(page, persona, { name: renamed, description: 'after' });
    await expect(personaCard(page, renamed)).toBeVisible();
    await expect(personaCard(page, renamed)).toContainText('after');

    await deletePersona(page, renamed);
    await deleteTopic(page, topic);
  });

  test('04 delete a persona', async ({ page }) => {
    const topic = uniqueName('Topic');
    const persona = uniqueName('Persona');
    await createTopic(page, topic);
    await createPersona(page, persona, topic);
    await deletePersona(page, persona); // asserts the card is gone afterwards
    await deleteTopic(page, topic);
  });
});

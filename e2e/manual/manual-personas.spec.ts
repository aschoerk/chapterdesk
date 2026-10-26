// ---------------------------------------------------------------------------
// USER MANUAL — "Personas".
//
// Generates docs/manuals/manual-personas.md + screenshots. Shows the Personas
// page (create a persona and set it as the current persona). Self-contained:
// creates a uniquely named persona inside the seeded "Demo Topic" and cleans
// it up.
// ---------------------------------------------------------------------------

import { test, expect } from '../support/coverage';
import { createPersona, personaCard, gotoPersonas } from '../support/ui';
import { deletePersonaViaApi, newManual } from './manual-support';

test('Personas', async ({ page }) => {
  const manual = newManual(page, 'manual-personas', 'Personas');
  const persona = `Manual Persona ${Date.now().toString(36)}`;

  await manual.step(
    'Open the Personas page',
    'Use the **Personas** link in the top navigation. Personas are writing voices / narrators you can attach to environments.',
    (p) => gotoPersonas(p),
    { waitAfter: 400 },
  );

  await manual.step(
    'Create a persona',
    'Click **+ New persona**, enter a name, short name and choose its main topic, then save.',
    async (p) => {
      await createPersona(p, persona, 'Demo Topic', {
        shortName: 'MP',
        description: 'A persona created for the user manual.',
      });
      await expect(personaCard(p, persona)).toBeVisible();
    },
    { waitAfter: 400, highlightTarget: personaCard(page, persona) },
  );

  await manual.step(
    'Review the persona',
    'The persona card shows its name and description. The card menu lets you edit, delete or set it as the current persona.',
    async (p) => {
      await personaCard(p, persona).locator('.card-image .menu-btn').click();
      await expect(
        personaCard(p, persona).locator('.card-menu button').filter({ hasText: 'Set as current' }),
      ).toBeVisible();
    },
    { waitAfter: 300 },
  );

  await manual.generate();

  await deletePersonaViaApi(page, persona);
});
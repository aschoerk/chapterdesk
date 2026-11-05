import { describe, it, expect } from 'vitest';
import { BUILTIN_NAMES } from './builtin-names';
import { findNames } from './name-replace';
import type { NameEntry, NameCategory } from '../../models/name-entry';

function toEntry(n: { name: string; language: string; kind: string }): NameEntry {
  const category: NameCategory | null =
    n.kind === 'surname' ? 'surname' : n.kind === 'female' ? 'female' : 'male';
  return {
    id: n.name + '-id',
    language: n.language,
    name: n.name,
    category,
    gender: category === 'male' || category === 'female' ? category : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('repro: gender identification for capital-letter names', () => {
  it('shows gender/surname for names found in the dictionary', () => {
    const entries = BUILTIN_NAMES.map(toEntry);
    const units = [
      { key: 'n1', text: 'Elizabeth met Darcy. Bennet smiled. Elizabeth danced with Darcy.' },
    ];
    const rows = findNames(units, entries, { includeUnknown: true, unknownMinCount: 1 });
    for (const r of rows) {
      console.log(
        'ROW',
        JSON.stringify({
          form: r.form,
          entry: r.entry?.name,
          category: r.entry?.category,
          filters: r.filters,
          candidates: r.candidates,
        }),
      );
    }
    const el = rows.find((r) => r.form === 'Elizabeth');
    console.log('Elizabeth entry category:', el?.entry?.category, 'filters:', el?.filters);
    const darcy = rows.find((r) => r.form === 'Darcy');
    console.log('Darcy entry category:', darcy?.entry?.category, 'filters:', darcy?.filters);
    const bennet = rows.find((r) => r.form === 'Bennet');
    console.log('Bennet entry category:', bennet?.entry?.category, 'filters:', bennet?.filters);
    expect(rows.length).toBeGreaterThan(0);
  });
});
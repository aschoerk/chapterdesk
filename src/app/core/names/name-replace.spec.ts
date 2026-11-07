import { describe, it, expect } from 'vitest';
import { EXCLUDED_WORD_LANGUAGE, type NameEntry } from '../../models/name-entry';
import {
  countOccurrences,
  countOccurrencesPerUnit,
  findOccurrences,
  buildNameIndex,
  exactOccurrences,
  firstLetter,
  entryForms,
  entryCandidates,
  sameLetterCandidates,
  keepsFirstLetter,
  proposeReplacement,
  titleCaseName,
  findUnknownCapitalized,
  findNames,
  applyNameReplacements,
  filterCandidates,
  classifyCandidate,
  initializeNameFilters,
  nameKey,
  isSurnameRow,
  mightBeSurnameRow,
  type NameReplaceRow,
  type NamedCandidate,
} from './name-replace';

function entry(partial: Partial<NameEntry> & { name: string }): NameEntry {
  const category = partial.category ?? partial.gender ?? null;
  return {
    id: partial.id ?? 'e1',
    language: partial.language ?? null,
    name: partial.name,
    category: (category as NameEntry['category']) ?? null,
    gender: category === 'male' || category === 'female' ? category : null,
    prename: partial.prename ?? null,
    surname: partial.surname ?? null,
    shortName: partial.shortName ?? null,
    capitalized: partial.capitalized ?? null,
    initials: partial.initials ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const UNITS = [
  { key: 'n1', text: 'Elizabeth met Liz at the ball. ELIZABETH smiled.' },
  { key: 'n2', text: 'Mr. Bennet and Elizabeth danced.' },
];

describe('name-replace pure engine', () => {
  describe('countOccurrences', () => {
    it('counts whole-word case-insensitive occurrences', () => {
      expect(countOccurrences('Liz and liz and LIZ', 'Liz')).toBe(3);
    });
    it('does not match inside a larger word', () => {
      expect(countOccurrences('Elizabeth and Lizzie', 'Liz')).toBe(0);
    });
    it('ignores empty form/text', () => {
      expect(countOccurrences('', 'Liz')).toBe(0);
      expect(countOccurrences('Liz', '')).toBe(0);
    });
  });

  describe('countOccurrencesPerUnit', () => {
    it('returns only the units that contain the exact-case form, with per-unit counts', () => {
      const units = [
        { key: 'a', text: 'Liz and liz' },
        { key: 'b', text: 'no names here' },
        { key: 'c', text: 'Liz!' },
      ];
      // CASE-SENSITIVE: only the exact "Liz" words count.
      expect(countOccurrencesPerUnit(units, 'Liz')).toEqual([
        { key: 'a', count: 1 },
        { key: 'c', count: 1 },
      ]);
    });
    it('returns [] when the form is absent', () => {
      expect(countOccurrencesPerUnit([{ key: 'a', text: 'nothing' }], 'Liz')).toEqual([]);
    });
  });

  describe('findOccurrences (case-sensitive, whole-word)', () => {
    it('matches only the exact case', () => {
      const units = [
        { key: 'n1', text: 'Elizabeth met elizabeth. ELIZABETH left.' },
      ];
      const found = findOccurrences(units, 'Elizabeth');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ key: 'n1', localNth: 0, start: 0, length: 9, text: 'Elizabeth' });
    });

    it('matches whole words only (per word)', () => {
      const units = [{ key: 'n1', text: 'Liz and Lizzie and liz.' }];
      const found = findOccurrences(units, 'Liz');
      expect(found).toHaveLength(1); // not "Lizzie", not lowercase "liz"
      expect(found[0].start).toBe(0);
    });

    it('flattens occurrences in unit order with per-unit localNth', () => {
      const units = [
        { key: 'a', text: 'Liz. Lizzie.' },
        { key: 'b', text: 'Liz!' },
      ];
      const found = findOccurrences(units, 'Liz');
      expect(found.map((o) => ({ key: o.key, localNth: o.localNth }))).toEqual([
        { key: 'a', localNth: 0 },
        { key: 'b', localNth: 0 },
      ]);
    });

    it('returns [] for an empty form', () => {
      expect(findOccurrences([{ key: 'a', text: 'Liz' }], '')).toEqual([]);
    });
  });

  describe('Unicode letters, possessives and double names', () => {
    it('matches umlauts and ß as whole words', () => {
      expect(countOccurrences('Müller traf Müller.', 'Müller')).toBe(2);
      expect(countOccurrences('Müller', 'Müll')).toBe(0);
      // ß is not a \w character — the old ASCII \b never matched it.
      expect(countOccurrences('Weiß und Weiß', 'Weiß')).toBe(2);
      expect(countOccurrences('Weißes Kleid', 'Weiß')).toBe(0);
    });

    it('never lets a possessive \u2019s join the name', () => {
      expect(countOccurrences("Elizabeth's hat", 'Elizabeth')).toBe(1);
      expect(countOccurrences('Elizabeth\u2019s hat', 'Elizabeth')).toBe(1);
      expect(findOccurrences([{ key: 'n', text: "Elizabeth's hat" }], 'Elizabeth')).toEqual([
        { key: 'n', localNth: 0, start: 0, length: 9, text: 'Elizabeth' },
      ]);
      // The word index splits at the apostrophe: the possessive tail "s" is a
      // separate token and "Elizabeth's" is never a word of its own.
      const index = buildNameIndex([{ key: 'n', text: "Elizabeth's hat" }]);
      expect(index.words.has("elizabeth's")).toBe(false);
      expect(index.words.has('elizabeth')).toBe(true);
      expect(index.words.has('s')).toBe(true);
    });

    it('splits a double name at the hyphen into two names', () => {
      const units = [{ key: 'n', text: 'Anna-Lena lachte. Lena und Anna auch.' }];
      // Discovery treats the halves as independent names ...
      expect(findOccurrences(units, 'Anna')).toHaveLength(2);
      expect(findOccurrences(units, 'Lena')).toHaveLength(2);
      // ... while an EXPLICIT hyphenated dictionary form still matches literally.
      expect(findOccurrences(units, 'Anna-Lena')).toHaveLength(1);
    });

    it('counts the SS spelling of a ß name as its all-caps form', () => {
      const units = [{ key: 'n', text: 'Weiß kam. WEISS ging.' }];
      const index = buildNameIndex(units);
      expect(exactOccurrences(index, 'Weiß', /* matchAllCaps */ true).map((o) => o.text)).toEqual([
        'Weiß',
        'WEISS',
      ]);
      // Without matchAllCaps only the exact case counts.
      expect(exactOccurrences(index, 'Weiß').map((o) => o.text)).toEqual(['Weiß']);
      // The ASCII spelling meets the ß spelling in the same bucket.
      expect(exactOccurrences(index, 'Weiss', true).map((o) => o.text)).toEqual(['Weiß', 'WEISS']);
    });

    it('never starts a word with ß (it is lowercase-only)', () => {
      const index = buildNameIndex([{ key: 'n', text: '\u00bb\u00df\u00ab und Straße' }]);
      // The leading sharp s is not indexed as a word of its own.
      expect(index.words.has('\u00df')).toBe(false);
      expect(exactOccurrences(index, '\u00df')).toEqual([]);
      // ...but it is a perfectly normal letter INSIDE a word.
      expect(exactOccurrences(index, 'Straße').map((o) => o.text)).toEqual(['Straße']);
      // A form beginning with ß reports no usable first letter.
      expect(firstLetter('\u00dfx')).toBe('');
      expect(firstLetter('Müller')).toBe('m');
    });

    it('keeps a leading umlaut when title-casing', () => {
      expect(titleCaseName('M\u00dcLLER')).toBe('Müller');
      expect(titleCaseName('wei\u00df')).toBe('Wei\u00df');
    });
  });

  describe('findNames occurrences', () => {
    it('populates per-unit occurrences on each row', () => {
      const e = entry({ name: 'Elizabeth', shortName: 'Liz', language: 'en' });
      const units = [
        { key: 'n1', text: 'Elizabeth met Liz.' },
        { key: 'n2', text: 'Elizabeth smiled.' },
      ];
      const rows = findNames(units, [e], {});
      const elizabeth = rows.find((r) => r.form === 'Elizabeth');
      expect(elizabeth?.occurrences).toEqual([
        { key: 'n1', count: 1 },
        { key: 'n2', count: 1 },
      ]);
    });
  });

  describe('entryForms', () => {
    it('lists the single name form (one entry = one name word)', () => {
      const e = entry({ name: 'Elizabeth' });
      const forms = entryForms(e).map((f) => f.form);
      expect(forms).toEqual(['Elizabeth']);
    });
    it('skips empty names', () => {
      const e = entry({ name: 'Bennet' });
      expect(entryForms(e)).toEqual([{ form: 'Bennet', kind: 'full' }]);
    });
  });

  describe('keepsFirstLetter / proposeReplacement', () => {
    it('keeps first letter (case-insensitive)', () => {
      expect(keepsFirstLetter('Liz', 'Lizzie')).toBe(true);
      expect(keepsFirstLetter('Liz', 'Elizabeth')).toBe(false);
      expect(keepsFirstLetter('elizabeth', 'Elizabeth')).toBe(true);
    });
    it('proposes the first candidate keeping the first letter', () => {
      const e = entry({ name: 'Elizabeth' });
      // With only the canonical name as a candidate (which does not keep the L)
      // the proposal falls back to the entry name.
      expect(proposeReplacement('Liz', e)).toBe('Elizabeth');
      expect(proposeReplacement('Liz', e, ['Liz', 'Liam', 'Lucy'])).toBe('Liz');
    });
    it('falls back to the canonical name when nothing keeps the letter', () => {
      const e = entry({ name: 'Elizabeth' });
      expect(proposeReplacement('Elisabet', e)).toBe('Elizabeth');
    });
    it('returns the form itself when there is no entry', () => {
      expect(proposeReplacement('Liz', null)).toBe('Liz');
    });
    it('honours an explicit candidate list for the first-letter pick', () => {
      const e = entry({ name: 'Elizabeth' });
      expect(proposeReplacement('Liz', e, ['Liz', 'Liam', 'Lucy'])).toBe('Liz');
      expect(proposeReplacement('Liz', e, ['Liam', 'Lucy'])).toBe('Liam');
    });
  });

  describe('sameLetterCandidates', () => {
    const dict = [
      entry({ id: 'e1', name: 'Elizabeth', language: 'en' }),
      entry({ id: 'e2', name: 'Edward', language: 'en' }),
      entry({ id: 'e3', name: 'Emma', language: 'en' }),
      entry({ id: 'e4', name: 'Liam', language: 'en' }),
      entry({ id: 'e5', name: 'Elisabeth', language: 'de' }),
    ];

    it('offers same-initial forms from the whole dictionary, sorted alphabetically', () => {
      expect(sameLetterCandidates(dict, 'Elizabeth').map((c) => c.form)).toEqual([
        'Edward', 'Elisabeth', 'Elizabeth', 'Emma',
      ]);
    });

    it('resolves the found form by its first letter (capital-letter match)', () => {
      // Only the L-initial name from the whole dictionary is offered (Liz is
      // NOT in this dict, so no exact-first special case).
      expect(sameLetterCandidates(dict, 'Liz').map((c) => c.form)).toEqual(['Liam']);
    });

    it('is language-scoped when a filter is given', () => {
      // 'Elisabeth' is German → excluded when filtering to 'en'.
      expect(sameLetterCandidates(dict, 'Elisabeth', 'de').map((c) => c.form)).toEqual(['Elisabeth']);
      expect(sameLetterCandidates(dict, 'Elizabeth', 'en').map((c) => c.form)).toEqual([
        'Edward', 'Elizabeth', 'Emma',
      ]);
    });

    it('classifies each candidate (female / male / surname)', () => {
      const dict2 = [
        entry({ id: 'a', name: 'Elizabeth', category: 'female', language: 'en' }),
        entry({ id: 'b', name: 'Edward', category: 'male', language: 'en' }),
        entry({ id: 'c', name: 'Ellis', category: 'surname', language: 'en' }),
      ];
      expect(sameLetterCandidates(dict2, 'Elisabeth')).toEqual([
        { form: 'Edward', gender: 'male', category: 'given' },
        { form: 'Elizabeth', gender: 'female', category: 'given' },
        { form: 'Ellis', gender: null, category: 'surname' },
      ]);
    });

    it('sorts alphabetically without pulling the exact found form to the front', () => {
      const dict2 = [
        entry({ id: 'e', name: 'Liz', category: 'female', language: 'en' }),
        entry({ id: 'a', name: 'Elizabeth', category: 'female', language: 'en' }),
        entry({ id: 'b', name: 'Lucy', category: 'female', language: 'en' }),
        entry({ id: 'c', name: 'Liam', category: 'male', language: 'en' }),
      ];
      const forms = sameLetterCandidates(dict2, 'Liz').map((c) => c.form);
      // L-initial forms only, alphabetically (Elizabeth starts with E).
      expect(forms).toEqual(['Liam', 'Liz', 'Lucy']);
      expect(forms).toContain('Liz');
    });

    it('never suggests a word that was excluded forever, even if it is also a name', () => {
      const dict2 = [
        entry({ id: 'a', name: 'Liz', category: 'female', language: 'en' }),
        entry({ id: 'b', name: 'Lucy', category: 'female', language: 'en' }),
        // The user marked "Liz" as "not a name" forever.
        entry({ id: 'x', name: 'Liz', language: EXCLUDED_WORD_LANGUAGE }),
      ];
      expect(sameLetterCandidates(dict2, 'Lucy').map((c) => c.form)).toEqual(['Lucy']);
    });

    it('returns [] for an empty form', () => {
      expect(sameLetterCandidates(dict, '')).toEqual([]);
    });
  });

  describe('filterCandidates / initializeNameFilters', () => {
    const all: NamedCandidate[] = [
      { form: 'Edward', gender: 'male', category: 'given' },
      { form: 'Emma', gender: 'female', category: 'given' },
      { form: 'Eli', gender: null, category: 'given' },
      { form: 'Ellis', gender: null, category: 'surname' },
    ];

    it('shows only the checked kinds; unisex given names fit both M and F', () => {
      expect(filterCandidates(all, { male: true, female: false, surname: false })).toEqual(['Edward', 'Eli']);
      expect(filterCandidates(all, { male: false, female: true, surname: false })).toEqual(['Emma', 'Eli']);
      expect(filterCandidates(all, { male: false, female: false, surname: true })).toEqual(['Ellis']);
      expect(filterCandidates(all, { male: true, female: true, surname: true })).toEqual([
        'Edward', 'Emma', 'Eli', 'Ellis',
      ]);
    });

    it('defaults from the name list: PRENAMES activate their own gender; surnames only S', () => {
      const female = entry({ name: 'Elizabeth', category: 'female' });
      const male = entry({ name: 'Edward', category: 'male' });
      expect(initializeNameFilters(female, 'full')).toEqual({ male: false, female: true, surname: false });
      expect(initializeNameFilters(male, 'full')).toEqual({ male: true, female: false, surname: false });
      expect(initializeNameFilters(entry({ name: 'Ellis', category: 'surname' }), 'full')).toEqual({
        male: false, female: false, surname: true,
      });
      expect(initializeNameFilters(entry({ name: 'Berlin', category: 'place' }), 'full')).toEqual({
        male: false, female: false, surname: true,
      });
    });

    it('defaults unknown names to all-on and never returns all-off', () => {
      expect(initializeNameFilters(null, 'full')).toEqual({ male: true, female: true, surname: true });
      expect(initializeNameFilters(entry({ name: 'Alex' }), 'short')).toEqual({ male: true, female: true, surname: true });
    });

    it('classifies a LEGACY gender-only entry as that prename (no category)', () => {
      // Old server builds / pre-category data only carry `gender`.
      const female = entry({ id: 'f', name: 'Elizabeth', gender: 'female' });
      const male = entry({ id: 'm', name: 'Edward', gender: 'male' });
      expect(initializeNameFilters(female, 'full')).toEqual({ male: false, female: true, surname: false });
      expect(initializeNameFilters(male, 'full')).toEqual({ male: true, female: false, surname: false });
      expect(classifyCandidate(female, 'Elizabeth', 'full')).toEqual({
        form: 'Elizabeth', gender: 'female', category: 'given',
      });
      expect(classifyCandidate(male, 'Edward', 'full')).toEqual({
        form: 'Edward', gender: 'male', category: 'given',
      });
    });

    it('classifies LEGACY surname-only / prename-only entries', () => {
      const surname = entry({ id: 's', name: 'Ellis', surname: 'Ellis' });
      expect(initializeNameFilters(surname, 'full')).toEqual({ male: false, female: false, surname: true });
      expect(classifyCandidate(surname, 'Ellis', 'full')).toEqual({
        form: 'Ellis', gender: null, category: 'surname',
      });
      // A legacy given-name marker with unknown gender → unisex prename.
      const given = entry({ id: 'g', name: 'Alex', prename: 'Alex' });
      expect(initializeNameFilters(given, 'full')).toEqual({ male: true, female: true, surname: false });
      expect(classifyCandidate(given, 'Alex', 'full')).toEqual({
        form: 'Alex', gender: null, category: 'given',
      });
    });
  });

  describe('titleCaseName', () => {
    it('capitalizes the first letter and lowercases the rest', () => {
      expect(titleCaseName('lIZ')).toBe('Liz');
      expect(titleCaseName('')).toBe('');
    });
  });

  describe('findUnknownCapitalized', () => {
    it('finds capitalized words not in the known set, above the min count', () => {
      const units = [{ key: 'n', text: 'Darcy met Darcy again. Darcy left.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).toContain('Darcy');
    });
    it('excludes known forms', () => {
      const units = [{ key: 'n', text: 'Darcy met Darcy.' }];
      const found = findUnknownCapitalized(units, new Set(['darcy']), 2);
      expect(found).toEqual([]);
    });
    it('excludes a capitalized word that also occurs lowercase', () => {
      // "Hunter" is capitalized but "hunter" appears as a common noun.
      const units = [{ key: 'n', text: 'Hunter met the hunter. Hunter left.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).not.toContain('Hunter');
    });
    it('keeps a name that never occurs lowercase', () => {
      // "Darcy" is always capitalized → still a candidate.
      const units = [{ key: 'n', text: 'Darcy spoke. Later, Darcy smiled.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).toContain('Darcy');
    });
    it('excludes months and weekdays even when always capitalized', () => {
      const units = [
        { key: 'n', text: 'Monday came. Monday passed. January followed.' },
      ];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).not.toContain('Monday');
      expect(found.map((f) => f.form)).not.toContain('January');
    });
    it('excludes the pronoun I', () => {
      const units = [{ key: 'n', text: 'I went. I saw. I left.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).not.toContain('I');
    });
    it('excludes each capitalized word whose exact lowercase form appears', () => {
      // "new" and "deal" appear lowercase in "the new deal", so neither
      // capitalized form is a name.
      const units = [{ key: 'n', text: 'The New Deal passed. Everyone loved the new deal.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).not.toContain('New');
      expect(found.map((f) => f.form)).not.toContain('Deal');
    });
    it('keeps capitalized words that never appear in lowercase (single words only)', () => {
      // Names are SINGLE words: no spaces, so "Deal" is the unit, not "New Deal".
      const units = [{ key: 'n', text: 'The New Deal was big. The New Deal passed.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).toContain('Deal');
      expect(found.map((f) => f.form)).not.toContain('New Deal');
    });
    it('excludes a single capitalized word whose lowercase form appears anywhere', () => {
      const units = [{ key: 'n', text: 'Baker came first. The baker laughed.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).not.toContain('Baker');
    });
    it('mentions when the candidate also appears completely capitalized', () => {
      // "Wall" also appears mid-sentence (so it is not just sentence-initial).
      const units = [{ key: 'n', text: 'Wall stood tall. The WALL towered above all. A Wall smiled.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      const wall = found.find((f) => f.form === 'Wall');
      expect(wall?.allCapsForm).toBe('WALL');
    });
    it('excludes a word capitalized only at sentence beginnings', () => {
      // "Meanwhile" is only ever capitalized because it starts a sentence.
      const units = [{ key: 'n', text: 'Meanwhile the rain fell. Meanwhile the wind rose.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).not.toContain('Meanwhile');
    });
    it('excludes a single sentence-initial word (start of the text)', () => {
      const units = [{ key: 'n', text: 'Surely it was fine.' }];
      const found = findUnknownCapitalized(units, new Set(), 1);
      expect(found.map((f) => f.form)).not.toContain('Surely');
    });
    it('keeps a word that also occurs mid-sentence', () => {
      const units = [{ key: 'n', text: 'Later the rain fell. Then, Later came back.' }];
      const found = findUnknownCapitalized(units, new Set(), 2);
      expect(found.map((f) => f.form)).toContain('Later');
    });

    it('detects umlaut names and merges ß/SS spellings into one row', () => {
      const units = [
        {
          key: 'n',
          text: 'Müller kam. Dann ging Müller. Gestern traf Weiß ihn. Später sah ich Weiß. WEISS lachte.',
        },
      ];
      const found = findUnknownCapitalized(units, new Set(), 2);
      const byForm = new Map(found.map((f) => [f.form, f]));
      expect(byForm.get('Müller')?.count).toBe(2);
      // The title spelling "Weiß" occurs mid-sentence twice; its SS all-caps
      // spelling is reported as allCapsForm on the SAME row (no extra row).
      expect(byForm.get('Weiß')?.count).toBe(2);
      expect(byForm.get('Weiß')?.allCapsForm).toBe('WEISS');
      expect(found.map((f) => f.form)).not.toContain('WEISS');
    });
  });

  describe('findNames', () => {
    it('finds dictionary forms with counts and proposals (case-sensitive + all-caps)', () => {
      // One entry per name word: Elizabeth + Liz are SEPARATE entries.
      const e = entry({ id: 'e1', name: 'Elizabeth', language: 'en' });
      const liz = entry({ id: 'e2', name: 'Liz', language: 'en' });
      const rows = findNames(UNITS, [e, liz], {});
      const byForm = new Map(rows.map((r) => [r.form, r]));
      // "Elizabeth" exact (n1+n2) = 2, plus the ALL-CAPS "ELIZABETH" (n1)
      // counts as the same name → 3, and the all-caps form is mentioned.
      expect(byForm.get('Elizabeth')?.count).toBe(3);
      expect(byForm.get('Elizabeth')?.allCapsForm).toBe('ELIZABETH');
      expect(byForm.get('Liz')?.count).toBe(1); // "Liz" exact-case only
      expect(byForm.get('Elizabeth')?.proposed).toBe('Elizabeth');
    });

    it('does not match a diamond word that only appears lowercase', () => {
      // Dictionary has "Wall" but the text only ever has lowercase "wall".
      const e = entry({ name: 'Wall', language: 'en' });
      const rows = findNames([{ key: 'n', text: 'the wall is high' }], [e], {});
      expect(rows).toEqual([]);
    });

    it('finds umlaut names and their SS all-caps spelling', () => {
      const e = entry({ name: 'Weiß', language: 'de' });
      const rows = findNames([{ key: 'n', text: 'Weiß kam. WEISS ging. Weißes Kleid.' }], [e], {
        language: 'de',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ form: 'Weiß', count: 2, allCapsForm: 'WEISS' });
      // "Weißes" is a different word — never counted or replaced.
      expect(rows[0].occurrences).toEqual([{ key: 'n', count: 2 }]);
    });

    it('matches the ASCII spelling "Weiss" against text written "Weiß"', () => {
      const e = entry({ name: 'Weiss', language: 'de' });
      const rows = findNames([{ key: 'n', text: 'Weiß und Weiss.' }], [e], { language: 'de' });
      expect(rows[0]).toMatchObject({ form: 'Weiss', count: 2 });
    });

    it('offers same-initial suggestions from the whole dictionary as candidates', () => {
      const e = entry({ id: 'e1', name: 'Elizabeth', language: 'en' });
      const edward = entry({ id: 'e2', name: 'Edward', language: 'en' });
      const emma = entry({ id: 'e3', name: 'Emma', language: 'en' });
      const liz = entry({ id: 'e4', name: 'Liz', language: 'en' });
      const rows = findNames(UNITS, [e, edward, emma, liz], {});
      const elizabeth = rows.find((r) => r.form === 'Elizabeth')!;
      // The "Replace with" listbox offers every E-form, not just the entry's,
      // sorted alphabetically.
      expect(elizabeth.candidates).toEqual(['Edward', 'Elizabeth', 'Emma']);
      // The L-form row only offers L-initial candidates.
      const lizRow = rows.find((r) => r.form === 'Liz')!;
      expect(lizRow.candidates).toEqual(['Liz']);
    });

    it('filters by language', () => {
      const en = entry({ name: 'Elizabeth', language: 'en' });
      const de = entry({ name: 'Elisabeth', language: 'de' });
      const units = [
        { key: 'n1', text: 'Elizabeth met Elisabeth. Elisabeth smiled.' },
      ];
      const rowsDe = findNames(units, [en, de], { language: 'de' });
      expect(rowsDe.map((r) => r.form)).toEqual(['Elisabeth']);
      const rowsEn = findNames(units, [en, de], { language: 'en' });
      expect(rowsEn.map((r) => r.form)).toEqual(['Elizabeth']);
    });

    it('includes unknown capitalized names when asked', () => {
      const units = [{ key: 'n', text: 'Darcy and Darcy and Darcy.' }];
      const rows = findNames(units, [], { includeUnknown: true, unknownMinCount: 2 });
      expect(rows.map((r) => r.form)).toContain('Darcy');
      expect(rows.find((r) => r.form === 'Darcy')?.entry).toBeNull();
    });

    it('does not add a word capitalized only at sentence beginnings', () => {
      const units = [
        { key: 'n', text: 'Meanwhile the rain fell. Meanwhile the wind rose.' },
      ];
      const rows = findNames(units, [], { includeUnknown: true, unknownMinCount: 2 });
      expect(rows.map((r) => r.form)).not.toContain('Meanwhile');
    });

    it('merges the same form found via two entries', () => {
      const a = entry({ name: 'Alex', id: 'a' });
      const b = entry({ name: 'Alexandra', shortName: 'Alex', id: 'b' });
      const units = [{ key: 'n', text: 'Alex and Alex.' }];
      const rows = findNames(units, [a, b], {});
      const alex = rows.find((r) => r.form === 'Alex');
      expect(alex?.count).toBe(2);
    });

    it('suppresses a word excluded via the special language', () => {
      // "Hunter" is marked excluded-forever (language = EXCLUDED_WORD_LANGUAGE).
      const excluded = entry({ name: 'Hunter', language: EXCLUDED_WORD_LANGUAGE });
      const units = [
        { key: 'n', text: 'Hunter came. Then Hunter left again.' },
      ];
      // It must NOT appear as a name row…
      const rows = findNames(units, [excluded], {});
      expect(rows.map((r) => r.form)).not.toContain('Hunter');
      // …and it must NOT be re-surfaced by the capital-letter detection either.
      const withUnknown = findNames(units, [excluded], {
        includeUnknown: true,
        unknownMinCount: 1,
      });
      expect(withUnknown.map((r) => r.form)).not.toContain('Hunter');
    });
  });

  describe('applyNameReplacements', () => {
    it('replaces approved whole-word occurrences (exact case)', () => {
      const rows: NameReplaceRow[] = [
        {
          form: 'Liz',
          kind: 'short',
          entry: null,
          count: 1,
          proposed: 'Elizabeth',
          allCandidates: [{ form: 'Elizabeth', gender: null, category: 'given' }],
          candidates: ['Elizabeth'],
          filters: { male: true, female: true, surname: false },
          approved: true,
          excluded: false,
        },
      ];
      const updated = applyNameReplacements(
        [{ key: 'n', text: 'Liz went home. Lizzy stayed. liz paused.' }],
        rows,
      );
      // Whole-word + exact case: "Liz" replaced, "Lizzy"/"liz" untouched.
      expect(updated[0].text).toBe('Elizabeth went home. Lizzy stayed. liz paused.');
    });

    it('never lets a later proposal re-match a form inserted earlier', () => {
      const rows: NameReplaceRow[] = [
        {
          form: 'Ann',
          kind: 'full',
          entry: null,
          count: 1,
          proposed: 'Anna',
          allCandidates: [{ form: 'Anna', gender: null, category: 'given' }],
          candidates: ['Anna'],
          filters: { male: true, female: true, surname: false },
          approved: true,
          excluded: false,
        },
        {
          form: 'Anna',
          kind: 'full',
          entry: null,
          count: 1,
          proposed: 'Hannah',
          allCandidates: [{ form: 'Hannah', gender: null, category: 'given' }],
          candidates: ['Hannah'],
          filters: { male: true, female: true, surname: false },
          approved: true,
          excluded: false,
        },
      ];
      const updated = applyNameReplacements([{ key: 'n', text: 'Anna and Ann.' }], rows);
      // Both replacements are computed from the ORIGINAL positions: the
      // inserted "Anna" (from "Ann"→"Anna") must NOT be re-replaced.
      expect(updated[0].text).toBe('Hannah and Anna.');
    });

    it('returns the units unchanged when nothing is approved', () => {
      const rows: NameReplaceRow[] = [
        {
          form: 'Liz',
          kind: 'short',
          entry: null,
          count: 1,
          proposed: 'Elizabeth',
          allCandidates: [{ form: 'Elizabeth', gender: null, category: 'given' }],
          candidates: ['Elizabeth'],
          filters: { male: true, female: true, surname: false },
          approved: false,
          excluded: false,
        },
      ];
      const updated = applyNameReplacements([{ key: 'n', text: 'Liz.' }], rows);
      expect(updated[0].text).toBe('Liz.');
    });
  });

  describe('nameKey / isSurnameRow', () => {
    it('folds case and ß into one name identity', () => {
      expect(nameKey('Weiß')).toBe(nameKey('WEISS'));
      expect(nameKey('  Liz ')).toBe('liz');
      expect(nameKey('Liz')).not.toBe(nameKey('Elizabeth'));
    });

    it('detects surname rows from the entry category (places too)', () => {
      const row = (entryValue: NameEntry | null): NameReplaceRow => ({
        form: 'Rivers',
        kind: 'full',
        entry: entryValue,
        count: 1,
        proposed: 'Rivers',
        allCandidates: [],
        candidates: [],
        filters: { male: true, female: true, surname: true },
        approved: false,
        excluded: false,
      });
      expect(isSurnameRow(row(entry({ name: 'Rivers', category: 'surname' })))).toBe(true);
      expect(isSurnameRow(row(entry({ name: 'Rivers', category: 'place' })))).toBe(true);
      expect(isSurnameRow(row(entry({ name: 'Liz', category: 'female' })))).toBe(false);
      expect(isSurnameRow(row(null))).toBe(false);
    });

    it('"might be a surname" includes unclassified names, excludes known given names', () => {
      const row = (entryValue: NameEntry | null): NameReplaceRow => ({
        form: 'Rivers',
        kind: 'full',
        entry: entryValue,
        count: 1,
        proposed: 'Rivers',
        allCandidates: [],
        candidates: [],
        filters: { male: true, female: true, surname: true },
        approved: false,
        excluded: false,
      });
      // Positively classified surnames / places / brands.
      expect(mightBeSurnameRow(row(entry({ name: 'Rivers', category: 'surname' })))).toBe(true);
      expect(mightBeSurnameRow(row(entry({ name: 'Riverton', category: 'place' })))).toBe(true);
      expect(mightBeSurnameRow(row(entry({ name: 'Rivercorp', category: 'brand' })))).toBe(true);
      // UNKNOWN kind of name → might be a surname.
      expect(mightBeSurnameRow(row(null))).toBe(true);
      expect(mightBeSurnameRow(row(entry({ name: 'Rutherford' })))).toBe(true);
      // Positively known given names are not surname candidates.
      expect(mightBeSurnameRow(row(entry({ name: 'Liz', category: 'female' })))).toBe(false);
      expect(mightBeSurnameRow(row(entry({ name: 'Ed', category: 'male' })))).toBe(false);
      // Legacy prename marker (given, gender unknown).
      expect(mightBeSurnameRow(row(entry({ name: 'Leslie', prename: 'Leslie' })))).toBe(false);
    });
  });
});
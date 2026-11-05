import { describe, it, expect } from 'vitest';
import { BUILTIN_NAMES } from './builtin-names';

describe('BUILTIN_NAMES (zxcvbn seed data)', () => {
  it('parses into a non-empty array of well-formed entries', () => {
    expect(BUILTIN_NAMES.length).toBeGreaterThan(1000);
    const sample = BUILTIN_NAMES[0];
    expect(sample.name).toBeTruthy();
    expect(sample.language).toBe('en');
    expect(['female', 'male', 'surname']).toContain(sample.kind);
  });

  it('contains no duplicate names (case-insensitive)', () => {
    const seen = new Set<string>();
    for (const n of BUILTIN_NAMES) {
      const key = n.name.toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('contains given names and surnames, title-cased, with gender', () => {
    expect(BUILTIN_NAMES.some((n) => n.kind === 'female')).toBe(true);
    expect(BUILTIN_NAMES.some((n) => n.kind === 'male')).toBe(true);
    expect(BUILTIN_NAMES.some((n) => n.kind === 'surname')).toBe(true);
    expect(BUILTIN_NAMES[0].name[0]).toBe(BUILTIN_NAMES[0].name[0].toUpperCase());
  });
});
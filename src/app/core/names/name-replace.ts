/**
 * name-replace.ts
 *
 * Pure engine for the "Replace names" dialog — no Angular, no DOM.
 *
 * RULES for names in the text (per product decision):
 *   - A name is ALWAYS a complete word — a single run of ENGLISH letters
 *     `[A-Za-z]+`. No spaces, no apostrophes, no commas, no digits.
 *   - It always starts with a capital letter (`[A-Z][a-z]+` for the counted
 *     form). It is matched CASE-SENSITIVELY and whole-word.
 *   - A capitalized word is only a name if the SAME word never appears
 *     anywhere starting with a lower-case letter (so "Wall" is never a name
 *     while "wall" is present anywhere in the document).
 *   - When the name additionally appears COMPLETELY CAPITALIZED (e.g. "WALL")
 *     that is surfaced on the row (`allCapsForm`).
 *   - There is NO overlap: every name is an independent whole word, so
 *     replacements can never clash.
 *
 * The engine builds a single HASHMAP of every letter-only word →
 * document positions (plus its casing facts) ONCE, then matches names
 * against it in O(1) per form instead of rescanning the document.
 */

import type { NameEntry, NameGender, NameFilterCategory, NameKind } from '../../models/name-entry';
import { NAME_FORM_FIELDS, EXCLUDED_WORD_LANGUAGE } from '../../models/name-entry';
import type { NodeRole } from '../../models/chat';

/** One searchable text unit (typically a chat node). */
export interface NameTextUnit {
  key: string;
  text: string;
  /**
   * The role of the message this unit came from (chat nodes only). The
   * dialog's "only assistant messages" scope uses it; units WITHOUT a role
   * are always included (non-chat callers, tests).
   */
  role?: NodeRole;
}

/**
 * A replacement suggestion for a found name: the form text plus its intrinsic
 * classification (male/female given name, or surname/place/brand) so the
 * dialog's m/f/s checkboxes can filter the listbox.
 */
export interface NamedCandidate {
  form: string;
  gender: NameGender;
  category: NameFilterCategory;
}

/** The per-row m/f/s checkbox filter state. `true` = include that kind. */
export interface NameFilters {
  male: boolean;
  female: boolean;
  surname: boolean;
}

/** One row of the "Replace names" dialog. */
export interface NameReplaceRow {
  /** The exact (case-sensitive) form found in the text, e.g. "Liz". */
  form: string;
  /** Which kind of form it is (full / prename / surname / short / …). */
  kind: NameKind;
  /** The dictionary entry this form belongs to (null for unknown names). */
  entry: NameEntry | null;
  /** Number of exact-case, whole-word occurrences across the visible units. */
  count: number;
  /** Per-unit occurrence breakdown (for the "jump to" UI). */
  occurrences?: { key: string; count: number }[];
  /**
   * When the name also appears COMPLETELY CAPITALIZED somewhere in the text
   * (e.g. "WALL"), this holds that all-caps form so the dialog can mention it.
   */
  allCapsForm?: string;
  /**
   * 0-based index of the CURRENT occurrence (into the flattened occurrence
   *  list in unit order) — drives the per-name ◀/▶ navigation.
   */
  currentNth?: number;
  /** Proposed replacement (editable by the user). */
  proposed: string;
  /** ALL candidate replacements (same initial) with their classification. */
  allCandidates: NamedCandidate[];
  /**
   * Candidate replacements currently shown in the listbox — the subset of
   * `allCandidates` matching the row's m/f/s `filters`.
   */
  candidates: string[];
  /** User-editable m/f/s filter — which kinds the listbox shows. */
  filters: NameFilters;
  /** Whether the user approved replacing this name. */
  approved: boolean;
  /**
   * Whether the user ticked "exclude forever" — this capitalised form is a
   * normal word, not a name. Only meaningful for unknown rows (entry === null).
   * Mutually exclusive with `approved`. The row is greyed while true; the
   * dictionary write is only persisted on apply.
   */
  excluded: boolean;
}

export interface FindNamesOptions {
  /** Restrict dictionary matches to entries of this language (null = any). */
  language?: string | null;
  /** Also surface capitalized words that are NOT in the dictionary. */
  includeUnknown?: boolean;
  /** Minimum occurrence count for unknown (capitalized) names. */
  unknownMinCount?: number;
}

/** Whole-word, case-INsensitive occurrence count of `form` in `text`
 *  (a general-purpose helper; name detection uses `exactOccurrences`). */
export function countOccurrences(text: string, form: string): number {
  if (!form || !text) return 0;
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'gi');
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Word index — a hashmap of every ENGLISH-letter word → document positions.
//
// Built ONCE over the joined text, then queried in O(1) per name form so
// "find names by capital letter" and dictionary matching never rescan the
// document. Names are single words: runs of `[A-Za-z]` only (no spaces,
// apostrophes, commas or digits).
// ---------------------------------------------------------------------------

/** One occurrence of a word in the combined text (offset into `combined`). */
export interface WordOccurrence {
  start: number;
  length: number;
  text: string;
}

/** Per-word facts gathered while building the index. */
export interface WordInfo {
  /** Lowercased word (map key). */
  key: string;
  /** All positions of this word (any casing) in the combined text. */
  positions: WordOccurrence[];
  /** True if the word ever appears starting with a lower-case letter. */
  startsLower: boolean;
  /** The all-caps form (e.g. "WALL") if it appears anywhere. */
  allCapsForm?: string;
  /** Capitalized forms (`[A-Z][a-z]+`) that appeared, with occurrence counts. */
  titleForms: Map<string, number>;
  /**
   * Per capitalized form, how many occurrences are NOT sentence-initial.
   * A word capitalized only because it always starts a sentence (`0` here) is
   * not a name candidate.
   */
  titleFormsMid: Map<string, number>;
}

/** The whole-document hashmap plus the unit→offset mapping to resolve back. */
export interface NameIndex {
  units: NameTextUnit[];
  /** All unit texts joined by '\n' (words never cross it). */
  combined: string;
  /** Start offset of each unit inside `combined`. */
  unitStarts: number[];
  /** lowercase word → info (the hashmap). */
  words: Map<string, WordInfo>;
}

/** A letter-only word (a name can only be such a word). */
const CLEAN_WORD = /^[A-Za-z]+$/;

/** Closing quotes/brackets that may sit between a sentence end and a word. */
const CLOSER = /["'”’»)\]]/;

/**
 * True when the word at `start` is the first word of a sentence: only
 * whitespace/closing quotes precede it, and the last significant character is
 * a sentence terminator (`. ! ? …`), a line break, or the start of the text.
 */
function isSentenceInitial(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '\n') return true;
    if (/\s/.test(ch) || CLOSER.test(ch)) {
      i--;
      continue;
    }
    return /[.!?…]/.test(ch);
  }
  return true;
}

/** Build the word-position hashmap in ONE pass. */
export function buildNameIndex(units: NameTextUnit[]): NameIndex {
  const unitStarts: number[] = [];
  let combined = '';
  for (const unit of units) {
    unitStarts.push(combined.length);
    combined += unit.text;
    combined += '\n';
  }
  const words = new Map<string, WordInfo>();
  const re = /[A-Za-z]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(combined)) !== null) {
    const token = m[0];
    const key = token.toLowerCase();
    let info = words.get(key);
    if (!info) {
      info = {
        key,
        positions: [],
        startsLower: false,
        titleForms: new Map(),
        titleFormsMid: new Map(),
      };
      words.set(key, info);
    }
    info.positions.push({ start: m.index, length: token.length, text: token });
    if (/^[a-z]/.test(token)) info.startsLower = true;
    if (/^[A-Z]+$/.test(token) && token.length >= 2) {
      if (!info.allCapsForm) info.allCapsForm = token;
    } else if (/^[A-Z][a-z]+$/.test(token)) {
      info.titleForms.set(token, (info.titleForms.get(token) ?? 0) + 1);
      if (!isSentenceInitial(combined, m.index)) {
        info.titleFormsMid.set(token, (info.titleFormsMid.get(token) ?? 0) + 1);
      }
    }
  }
  return { units, combined, unitStarts, words };
}

/** Map a combined-text offset back to the unit + local offset (binary search). */
export function unitAt(
  index: NameIndex,
  pos: number,
): { unitIndex: number; local: number } {
  const starts = index.unitStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { unitIndex: lo, local: pos - starts[lo] };
}

/**
 * One concrete, exact-case occurrence of a name in the text.
 */
export interface NameOccurrence {
  /** Unit (chat node) the occurrence lives in. */
  key: string;
  /** 0-based index of this match within its unit (for DOM highlighting). */
  localNth: number;
  /** Start offset of the match in the unit text. */
  start: number;
  /** Length of the matched text. */
  length: number;
  /** The matched text exactly as it appears in the document. */
  text: string;
}

/**
 * Exact-case, whole-word occurrences of `form` via the word index. When
 * `matchAllCaps` is true the all-caps variant of the same letters
 * (e.g. "ELIZABETH") also counts as the name — that is the same name, only
 * typeset uppercase ("mention when the name can be found completely
 * capitalized"). Non-letter forms (initials with dots, …) fall back to a
 * literal whole-word search (those can only be dictionary forms).
 */
export function exactOccurrences(
  index: NameIndex,
  form: string,
  matchAllCaps = false,
): NameOccurrence[] {
  if (!form) return [];
  if (CLEAN_WORD.test(form)) {
    const info = index.words.get(form.toLowerCase());
    if (!info) return [];
    const caps = matchAllCaps && form.length > 1 ? form.toUpperCase() : '';
    const out: NameOccurrence[] = [];
    const perUnitNth = new Map<string, number>();
    for (const p of info.positions) {
      if (p.text !== form && (caps ? p.text !== caps : true)) continue;
      const { unitIndex, local } = unitAt(index, p.start);
      const key = index.units[unitIndex].key;
      const nth = perUnitNth.get(key) ?? 0;
      perUnitNth.set(key, nth + 1);
      out.push({ key, localNth: nth, start: local, length: p.length, text: p.text });
    }
    return out;
  }
  // Fallback for non-clean-word forms (initials, etc.).
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const out: NameOccurrence[] = [];
  for (const unit of index.units) {
    let m: RegExpExecArray | null;
    let localNth = 0;
    re.lastIndex = 0;
    while ((m = re.exec(unit.text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({ key: unit.key, localNth, start: m.index, length: m[0].length, text: m[0] });
      localNth++;
    }
  }
  return out;
}

/**
 * All exact-case, whole-word occurrences of `form` across the units, in unit
 * order (the per-name ◀/▶ navigation cycles through this list).
 */
export function findOccurrences(
  units: NameTextUnit[],
  form: string,
  index?: NameIndex,
): NameOccurrence[] {
  const idx = index ?? buildNameIndex(units);
  return exactOccurrences(idx, form);
}

/** Per-unit exact occurrence counts (for the "jump to" UI). */
export function countOccurrencesPerUnit(
  units: NameTextUnit[],
  form: string,
): { key: string; count: number }[] {
  const index = buildNameIndex(units);
  const per = new Map<string, number>();
  for (const o of exactOccurrences(index, form)) {
    per.set(o.key, (per.get(o.key) ?? 0) + 1);
  }
  return [...per.entries()].map(([key, count]) => ({ key, count }));
}

/** All searchable forms of an entry (deduped, non-empty). */
export function entryForms(entry: NameEntry): { form: string; kind: NameKind }[] {
  const seen = new Set<string>();
  const out: { form: string; kind: NameKind }[] = [];
  for (const { field, kind } of NAME_FORM_FIELDS) {
    const value = (entry[field] ?? '').toString().trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ form: value, kind });
  }
  return out;
}

/** Whether `candidate` keeps the first letter of `form` (case-insensitive). */
export function keepsFirstLetter(form: string, candidate: string): boolean {
  const f = form.trim();
  const c = candidate.trim();
  if (!f || !c) return false;
  return f[0].toLowerCase() === c[0].toLowerCase();
}

/** All candidate replacement strings for an entry (deduped, non-empty). */
export function entryCandidates(entry: NameEntry): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { field } of NAME_FORM_FIELDS) {
    const value = (entry[field] ?? '').toString().trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

/**
 * Pick the default proposed replacement for a found form:
 *  1. the candidate that IS the found form (keep as-is),
 *  2. else the first dictionary candidate that KEEPS THE FIRST LETTER,
 *  3. else the entry's canonical `name`,
 *  4. else the form itself (unchanged).
 * `candidates` (when given) is honored for the "keep as-is" and
 * "keeps first letter" picks; otherwise the entry's own forms are used.
 */
export function proposeReplacement(
  form: string,
  entry: NameEntry | null,
  candidates?: string[],
): string {
  if (entry) {
    const list = candidates && candidates.length > 0 ? candidates : entryCandidates(entry);
    const exact = form.trim().toLowerCase();
    const same = list.find((c) => c.trim().toLowerCase() === exact);
    if (same) return same;
    const keeping = list.find((c) => keepsFirstLetter(form, c));
    if (keeping) return keeping;
    if (entry.name.trim()) return entry.name;
  }
  return form.trim();
}

/**
 * Candidate replacement forms for a found name, drawn from the WHOLE name
 * dictionary: every form (full/prename/surname/short/capitalized/initials)
 * that starts with the same capital letter as `form` — so the "Replace with"
 * listbox offers consistent, same-initial suggestions from the name list.
 *
 * - skips excluded-word entries (never suggested),
 * - honours the language filter (when given),
 * - dedupes case-insensitively,
 * - sorts alphabetically (the found form is NOT pulled to the front — the
 *   dialog positions the dropdown at the current entry when it opens).
 */
export function sameLetterCandidates(
  entries: NameEntry[],
  form: string,
  language: string | null = null,
): NamedCandidate[] {
  const letter = form.trim().charAt(0).toLowerCase();
  if (!letter) return [];
  const out: NamedCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if ((entry.language ?? '').toLowerCase() === EXCLUDED_WORD_LANGUAGE) continue;
    if (
      language &&
      entry.language &&
      entry.language.toLowerCase() !== language.toLowerCase()
    ) {
      continue;
    }
    for (const { form: candidate, kind } of entryForms(entry)) {
      const c = candidate.trim();
      if (!c || seen.has(c.toLowerCase())) continue;
      if (c[0].toLowerCase() !== letter) continue;
      seen.add(c.toLowerCase());
      out.push(classifyCandidate(entry, c, kind));
    }
  }
  out.sort((a, b) => a.form.toLowerCase().localeCompare(b.form.toLowerCase()));
  return out;
}

/**
 * Resolve an entry's effective classification, preferring the explicit
 * `category`, then the legacy `gender` / `prename` / `surname` markers (old
 * server builds and pre-category data only carry those), then the matched
 * form's `kind`.
 */
export function entryCategoryOf(
  entry: NameEntry,
  kind: NameKind,
): 'male' | 'female' | 'surname' | 'given' | null {
  if (entry.category === 'male') return 'male';
  if (entry.category === 'female') return 'female';
  if (entry.category === 'surname' || entry.category === 'place' || entry.category === 'brand') {
    return 'surname';
  }
  // Legacy / category-less entries:
  if (entry.gender === 'male' || entry.gender === 'female') return entry.gender;
  if (entry.surname) return 'surname';
  if (kind === 'surname') return 'surname';
  if (entry.prename) return 'given'; // legacy given-name marker, gender unknown
  return null;
}

/**
 * Classify one form of an entry into the M/F/S candidate buckets. Female
 * entries → female given, male entries → male given, surnames/places/brands →
 * the S bucket, a legacy `prename` (unknown gender) → unisex given (shows
 * under M or F). A fully unknown entry falls into the S bucket (the only safe
 * non-empty choice).
 */
export function classifyCandidate(
  entry: NameEntry,
  form: string,
  kind: NameKind,
): NamedCandidate {
  const cat = entryCategoryOf(entry, kind);
  if (cat === 'male') return { form, gender: 'male', category: 'given' };
  if (cat === 'female') return { form, gender: 'female', category: 'given' };
  if (cat === 'given') return { form, gender: null, category: 'given' };
  // surname/place/brand/unknown → non-given → the "S" bucket.
  return { form, gender: null, category: 'surname' };
}

/**
 * The visible candidate list for the listbox: the `allCandidates` subset that
 * matches the m/f/s filter. A gender-null given name shows under BOTH male and
 * female; surnames/places/brands only under the surname checkbox.
 */
export function filterCandidates(
  all: NamedCandidate[],
  filters: NameFilters,
): string[] {
  return all
    .filter((c) => {
      if (c.category === 'surname') return filters.surname;
      if (c.gender === 'female') return filters.female;
      if (c.gender === 'male') return filters.male;
      // unisex / unknown given name → shown when either male or female is on
      return filters.male || filters.female;
    })
    .map((c) => c.form);
}

/**
 * Initial m/f/s checkboxes for a found name:
 *   - For a male PRENAME only "M" is active; for a female prename only "F" —
 *     the listbox starts with the suggestions matching the entry's gender.
 *   - A legacy prename WITHOUT a known gender (category-less `prename`
 *     marker) activates BOTH "M" and "F" — the gender is unclear, so both
 *     kinds of given-name suggestions are offered.
 *   - For a surname (or place/brand) only "S" is active.
 *   - Unknown names default to ALL on so every same-initial suggestion is
 *     offered. Never returns all-false (falls back to all-on).
 */
export function initializeNameFilters(
  entry: NameEntry | null,
  kind: NameKind,
): NameFilters {
  if (!entry) return { male: true, female: true, surname: true };
  const cat = entryCategoryOf(entry, kind);
  if (cat === 'male') return { male: true, female: false, surname: false };
  if (cat === 'female') return { male: false, female: true, surname: false };
  // Legacy prename with unknown gender → show both given-name kinds.
  if (cat === 'given') return { male: true, female: true, surname: false };
  if (cat === 'surname') return { male: false, female: false, surname: true };
  // Unknown category → all-on (never an empty listbox).
  return { male: true, female: true, surname: true };
}

/** Title-case a name (first letter upper, rest lower). */
export function titleCaseName(form: string): string {
  const trimmed = form.trim();
  if (!trimmed) return '';
  return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Words that are capitalized by standard English grammar rather than being
 * names — months, weekdays, languages / demonyms, the pronoun "I". These are
 * always capitalized when they appear, so the "occurs lowercase elsewhere"
 * rule alone cannot filter them out; they are excluded explicitly.
 */
export const STANDARD_CAPITALIZED_WORDS = new Set<string>([
  // months
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  // weekdays
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // personal pronoun
  'i',
  // languages / demonyms (capitalized in English)
  'english', 'german', 'french', 'spanish', 'italian', 'russian', 'portuguese',
  'dutch', 'chinese', 'japanese', 'korean', 'arabic', 'hebrew', 'greek', 'latin',
  // common always-capitalized markers
  'chapter', 'introduction', 'conclusion', 'appendix',
]);

/**
 * Find capitalized words in the text that are NOT already covered by the
 * dictionary — the "find names by starting upper character" heuristic.
 * Returns `{ form, count, allCapsForm? }` for words appearing at least
 * `minCount` times. `form` is the exact capitalized spelling found in the text.
 *
 * A capitalized word is only a name candidate when ALL of these hold:
 *   - it is a single letter-only word (`[A-Z][a-z]+` — no spaces/apostrophes/
 *     commas/digits), always starting with a capital letter;
 *   - the SAME word never appears anywhere starting with a lower-case letter
 *     (the "Wall"/"wall" rule — "I do not want to see the word Wall when
 *     anywhere in the text the word wall can be found");
 *   - it is not capitalized ONLY because it starts sentences (e.g. "Meanwhile
 *     the rain fell. Meanwhile the wind rose." → "Meanwhile" is not a name);
 *   - it is not a standard grammar-capitalized word (months, weekdays, …).
 *
 * When the candidate also appears COMPLETELY CAPITALIZED (e.g. "WALL") that
 * form is returned as `allCapsForm` so the dialog can mention it.
 */
export function findUnknownCapitalized(
  units: NameTextUnit[],
  knownForms: Set<string>,
  minCount = 2,
  prebuilt?: NameIndex,
): { form: string; count: number; allCapsForm?: string }[] {
  const index: NameIndex = prebuilt ?? buildNameIndex(units);
  const out: { form: string; count: number; allCapsForm?: string }[] = [];
  for (const info of index.words.values()) {
    if (info.startsLower) continue; // "wall" is somewhere → "Wall" is not a name
    if (knownForms.has(info.key)) continue;
    if (STANDARD_CAPITALIZED_WORDS.has(info.key)) continue;
    for (const [form, count] of info.titleForms) {
      if (count < minCount) continue;
      // Capitalized ONLY at sentence beginnings → an ordinary word, not a name.
      if ((info.titleFormsMid.get(form) ?? 0) === 0) continue;
      out.push({ form, count, allCapsForm: info.allCapsForm });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Find all name rows for the given units + dictionary.
 *
 * Dictionary forms are matched exact-case, whole-word (their all-caps variant
 * also counts as the name and is surfaced via `allCapsForm`). When
 * `includeUnknown` is set, capitalized words not in the dictionary are
 * appended as unknown rows (subject to the "never lowercase" rule).
 */
export function findNames(
  units: NameTextUnit[],
  entries: NameEntry[],
  opts: FindNamesOptions = {},
  index?: NameIndex,
): NameReplaceRow[] {
  const language = opts.language ?? null;
  // Build the word→position hashmap ONCE and reuse it for every form.
  const idx: NameIndex = index ?? buildNameIndex(units);
  const rows = new Map<string, NameReplaceRow>();
  const knownForms = new Set<string>();

  for (const entry of entries) {
    // Excluded words are never names: they only feed the "skip these" set so
    // the capital-letter detection cannot re-surface them — regardless of the
    // currently selected language filter.
    if ((entry.language ?? '').toLowerCase() === EXCLUDED_WORD_LANGUAGE) {
      for (const { form } of entryForms(entry)) knownForms.add(form.toLowerCase());
      continue;
    }
    if (language && entry.language && entry.language.toLowerCase() !== language.toLowerCase()) {
      continue;
    }
    for (const { form, kind } of entryForms(entry)) {
      knownForms.add(form.toLowerCase());
      const occList = exactOccurrences(idx, form, /* matchAllCaps */ true);
      if (occList.length === 0) continue;
      const existing = rows.get(form.toLowerCase());
      if (existing) {
        // Same form shared by two entries — keep the FIRST entry (its
        // proposals + candidates) and do NOT double-count the occurrences.
        continue;
      }
      const wordInfo = CLEAN_WORD.test(form) ? idx.words.get(form.toLowerCase()) : undefined;
      const allCandidates = sameLetterCandidates(entries, form, language);
      const filters = initializeNameFilters(entry, kind);
      rows.set(form.toLowerCase(), {
        form,
        kind,
        entry,
        count: occList.length,
        occurrences: perUnitFrom(units, occList),
        ...(wordInfo?.allCapsForm ? { allCapsForm: wordInfo.allCapsForm } : {}),
        proposed: proposeReplacement(form, entry, filterCandidates(allCandidates, filters)),
        allCandidates,
        candidates: filterCandidates(allCandidates, filters),
        filters,
        approved: false,
        excluded: false,
      });
    }
  }

  if (opts.includeUnknown) {
    const unknown = findUnknownCapitalized(
      units,
      knownForms,
      opts.unknownMinCount ?? 2,
      idx,
    );
    for (const u of unknown) {
      if (rows.has(u.form.toLowerCase())) continue;
      const occList = exactOccurrences(idx, u.form, /* matchAllCaps */ false);
      const allCandidates = sameLetterCandidates(entries, u.form, language);
      const filters = initializeNameFilters(null, 'full');
      rows.set(u.form.toLowerCase(), {
        form: u.form,
        kind: 'full',
        entry: null,
        count: u.count,
        occurrences: perUnitFrom(units, occList),
        ...(u.allCapsForm ? { allCapsForm: u.allCapsForm } : {}),
        proposed: proposeReplacement(u.form, null, filterCandidates(allCandidates, filters)),
        allCandidates,
        candidates: filterCandidates(allCandidates, filters),
        filters,
        approved: false,
        excluded: false,
      });
    }
  }

  return [...rows.values()].sort((a, b) => b.count - a.count);
}

/** Collapse an occurrence list into per-unit counts (units = unit order). */
function perUnitFrom(
  units: NameTextUnit[],
  occs: NameOccurrence[],
): { key: string; count: number }[] {
  const per = new Map<string, number>();
  for (const o of occs) per.set(o.key, (per.get(o.key) ?? 0) + 1);
  return units
    .map((u) => ({ key: u.key, count: per.get(u.key) ?? 0 }))
    .filter((o) => o.count > 0);
}

/**
 * Apply the approved replacements to the units. Returns the updated units.
 * Replacements are computed from the ORIGINAL positions (exact whole-word
 * matches), so a later proposal can never re-match a form inserted earlier
 * (no cascade) and there is no overlap between names.
 */
export function applyNameReplacements(
  units: NameTextUnit[],
  rows: NameReplaceRow[],
): NameTextUnit[] {
  const approved = rows.filter(
    (r) => r.approved && r.form.trim() && r.proposed.trim(),
  );
  if (approved.length === 0) return units;

  return units.map((unit) => {
    const hits: { start: number; length: number; to: string }[] = [];
    for (const row of approved) {
      const escaped = row.form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'g'); // exact case + whole word
      let m: RegExpExecArray | null;
      while ((m = re.exec(unit.text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        hits.push({ start: m.index, length: m[0].length, to: row.proposed });
      }
    }
    if (hits.length === 0) return unit;
    hits.sort((a, b) => a.start - b.start);
    let out = '';
    let last = 0;
    for (const hit of hits) {
      out += unit.text.slice(last, hit.start) + hit.to;
      last = hit.start + hit.length;
    }
    out += unit.text.slice(last);
    return { key: unit.key, text: out };
  });
}
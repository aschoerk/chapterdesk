/**
 * Name dictionary — the "list of names loaded into the database" that the
 * "Replace names" dialog proposes replacements from.
 *
 * Each entry is ONE known name form classified by CATEGORY:
 *   – `category`  male prename | female prename | surname | place | brand
 *                 (more kinds may come later, e.g. per-language categories)
 *   – `name`      the exact name text (as it is matched in the text)
 *   – `language`  ISO 639-1 style code (`de`, `en`, `it`, `us`, `ru`, …) or
 *                 null = language-neutral.
 */

/**
 * Special `language` value marking a dictionary entry as an EXCLUDED WORD —
 * a word a user confirmed is NOT a name (e.g. a capitalized common noun or a
 * month). Such entries are never proposed as replacements / names; their
 * `name` is only added to the "known forms → skip" set so the capital-letter
 * name detection never re-surfaces them. Stored forever, but editable/deletable
 * in the Name lists dialog to undo an accidental exclusion.
 */
export const EXCLUDED_WORD_LANGUAGE = '!excluded';

/** The form a NameEntry records / that can be found in text. */
export type NameKind = 'full' | 'prename' | 'surname' | 'short' | 'capitalized' | 'initials';

/** The gender of a given-name entry; `null` for surnames / unknown / neutral. */
export type NameGender = 'male' | 'female' | null;

/**
 * What kind of name an entry is. This is the ONLY classification the app
 * needs: male prename, female prename, surname, geographical place, brand.
 * More categories may be added later (e.g. when per-language lists arrive).
 */
export type NameCategory = 'male' | 'female' | 'surname' | 'place' | 'brand';

/** The intrinsic category of a replacement suggestion (for the M/F/S filter). */
export type NameFilterCategory = 'given' | 'surname';

export interface NameEntry {
  id: string;
  language: string | null;
  /** The exact name text as matched in the text. */
  name: string;
  /** The classification of this name (see NameCategory). */
  category: NameCategory | null;
  /** Legacy gender (derived from category); kept for backward compatibility. */
  gender: NameGender;
  /** Legacy form fields — NOT used by the UI or matching anymore (kept so old
   *  data / tests still type). Only `name` is searchable. */
  prename?: string | null;
  surname?: string | null;
  shortName?: string | null;
  capitalized?: string | null;
  initials?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNameEntryRequest {
  name: string;
  language?: string | null;
  category?: NameCategory | null;
  gender?: NameGender;
}

/**
 * A PERSISTED name replacement learned by the "Replace names" dialog: the form
 * found in the text (`from`) and the name the user confirmed (`to`). Stored in
 * the database (not per chat), so the decision can be offered as a PROPOSAL in
 * any document — see the dialog's "Use saved replacements" button.
 */
export interface NameReplacement {
  id: string;
  /** The name as found in the text. */
  from: string;
  /** The name to use instead. */
  to: string;
  /** Optional language scope (ISO 639-1 code); null = applies to any language. */
  language: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Upsert a persisted replacement (same `from` + language overwrites `to`). */
export interface CreateNameReplacementRequest {
  from: string;
  to: string;
  language?: string | null;
}

export type UpdateNameEntryRequest = Partial<{
  name: string;
  language: string | null;
  category: NameCategory | null;
  gender: NameGender;
}>;

/** All searchable forms of an entry, in priority order (single name words). */
export const NAME_FORM_FIELDS: { field: keyof NameEntry; kind: NameKind }[] = [
  { field: 'name', kind: 'full' },
];

/** Common language codes offered in the settings dialog (ISO 639-1 style). */
export const NAME_LANGUAGES = [
  'en',
  'de',
  'it',
  'us',
  'ru',
  'fr',
  'es',
  'pt',
  'nl',
  'pl',
  'sv',
  'no',
  'da',
  'fi',
  'cs',
  'hu',
  'el',
  'tr',
  'ja',
  'zh',
  'ar',
  'he',
] as const;
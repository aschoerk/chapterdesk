import { Injectable, computed, inject, signal } from '@angular/core';
import { NameApiService } from './name-api.service';
import type {
  CreateNameEntryRequest,
  CreateNameReplacementRequest,
  NameEntry,
  NameReplacement,
  UpdateNameEntryRequest,
} from '../../models/name-entry';
import { nameKey } from './name-replace';

/**
 * Holds the name dictionary (the "list of names loaded into the database")
 * as a reactive signal. Loaded lazily on first use and refreshed after every
 * mutation so the "Replace names" dialog always proposes from the current
 * list. Language-scoped queries are done client-side via `entriesForLanguage`.
 */
@Injectable({ providedIn: 'root' })
export class NameDictionaryService {
  private readonly api = inject(NameApiService);

  /** All name entries, in insertion order. */
  readonly entries = signal<NameEntry[]>([]);
  /**
   * Replacements the user confirmed in the "Replace names" dialog, persisted
   * in the database (not per chat). They can be re-applied as proposals in any
   * document.
   */
  readonly replacements = signal<NameReplacement[]>([]);
  /** Whether the dictionary has been loaded at least once. */
  readonly loaded = signal(false);
  /** True while a load/refresh is in flight. */
  readonly loading = signal(false);

  /** Folded `from` key → remembered replacement (first one wins). */
  private readonly replacementsByKey = computed(() => {
    const map = new Map<string, NameReplacement>();
    for (const r of this.replacements()) {
      const key = nameKey(r.from);
      if (!map.has(key)) map.set(key, r);
    }
    return map;
  });

  /**
   * The persisted replacement for a found form, matching case- and
   * ß-insensitively. `language` narrows to that language (a replacement stored
   * without a language applies to all of them).
   */
  savedReplacementFor(form: string, language: string | null = null): NameReplacement | null {
    const match = this.replacementsByKey().get(nameKey(form)) ?? null;
    if (!match) return null;
    if (!language || !match.language) return match;
    return match.language.toLowerCase() === language.toLowerCase() ? match : null;
  }

  /** Entries for a given language (null = language-neutral only). */
  entriesForLanguage(language: string | null): NameEntry[] {
    const all = this.entries();
    if (!language) return all;
    return all.filter((e) => !e.language || e.language.toLowerCase() === language.toLowerCase());
  }

  async load(force = false): Promise<NameEntry[]> {
    if (this.loaded() && !force) {
      await this.loadReplacements();
      return this.entries();
    }
    this.loading.set(true);
    try {
      const list = await this.api.getNames();
      this.entries.set(list);
      this.loaded.set(true);
      await this.loadReplacements(force);
      return list;
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<NameEntry[]> {
    return this.load(true);
  }

  // -------------------- persisted replacements (from → to)

  /**
   * Load the remembered replacements. Best-effort: an older backend that does
   * not know the endpoint must not break the dialog, so failures only warn.
   */
  async loadReplacements(force = false): Promise<NameReplacement[]> {
    if (this.replacementsLoaded && !force) return this.replacements();
    try {
      const list = await this.api.getReplacements();
      this.replacements.set(Array.isArray(list) ? list : []);
      this.replacementsLoaded = true;
    } catch (err) {
      console.warn('[names] could not load the saved name replacements', err);
    }
    return this.replacements();
  }

  /** Remember a confirmed replacement (upsert by `from` + language). */
  async saveReplacement(data: CreateNameReplacementRequest): Promise<NameReplacement | null> {
    try {
      const saved = await this.api.saveReplacement(data);
      this.replacements.update((list) => {
        const key = nameKey(saved.from);
        const language = saved.language ?? null;
        const rest = list.filter(
          (r) => !(nameKey(r.from) === key && (r.language ?? null) === language),
        );
        return [...rest, saved].sort((a, b) => a.from.localeCompare(b.from));
      });
      return saved;
    } catch (err) {
      console.warn('[names] could not save the name replacement', err);
      return null;
    }
  }

  /** Forget a persisted replacement. */
  async deleteReplacement(id: string): Promise<void> {
    try {
      await this.api.deleteReplacement(id);
      this.replacements.update((list) => list.filter((r) => r.id !== id));
    } catch (err) {
      console.warn('[names] could not delete the name replacement', err);
    }
  }

  private replacementsLoaded = false;

  async create(data: CreateNameEntryRequest): Promise<NameEntry> {
    const entry = await this.api.createNameEntry(data);
    this.entries.update((list) => [...list, entry]);
    return entry;
  }

  async update(id: string, data: UpdateNameEntryRequest): Promise<NameEntry> {
    const entry = await this.api.updateNameEntry(id, data);
    this.entries.update((list) => list.map((e) => (e.id === id ? entry : e)));
    return entry;
  }

  async delete(id: string): Promise<void> {
    await this.api.deleteNameEntry(id);
    this.entries.update((list) => list.filter((e) => e.id !== id));
  }

  /** Bulk-load a line-oriented list of names (dedup server-side). */
  async importNames(text: string): Promise<NameEntry[]> {
    const list = await this.api.importNames(text);
    this.entries.set(list);
    return list;
  }

  /** Bulk-insert structured entries (e.g. the bundled zxcvbn name lists). */
  async importBuiltin(entries: CreateNameEntryRequest[]): Promise<NameEntry[]> {
    const list = await this.api.importBuiltin(entries);
    this.entries.set(list);
    return list;
  }
}
import { Injectable, inject, signal } from '@angular/core';
import { NameApiService } from './name-api.service';
import type {
  CreateNameEntryRequest,
  NameEntry,
  UpdateNameEntryRequest,
} from '../../models/name-entry';

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
  /** Whether the dictionary has been loaded at least once. */
  readonly loaded = signal(false);
  /** True while a load/refresh is in flight. */
  readonly loading = signal(false);

  /** Entries for a given language (null = language-neutral only). */
  entriesForLanguage(language: string | null): NameEntry[] {
    const all = this.entries();
    if (!language) return all;
    return all.filter((e) => !e.language || e.language.toLowerCase() === language.toLowerCase());
  }

  async load(force = false): Promise<NameEntry[]> {
    if (this.loaded() && !force) return this.entries();
    this.loading.set(true);
    try {
      const list = await this.api.getNames();
      this.entries.set(list);
      this.loaded.set(true);
      return list;
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<NameEntry[]> {
    return this.load(true);
  }

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
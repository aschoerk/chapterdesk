import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getServerConfig } from '../util/server-config';
import type {
  CreateNameEntryRequest,
  CreateNameReplacementRequest,
  NameEntry,
  NameReplacement,
  UpdateNameEntryRequest,
} from '../../models/name-entry';

/**
 * Thin HTTP client for the name-dictionary endpoints (`/api/names`).
 *
 * Kept as a SEPARATE service from `ChatApiService` (like PromptApiService)
 * because the name dictionary is a global, database-stored list with its own
 * CRUD + import shape. The server (chapterdesk-api-server) stores it in
 * SQLite.
 */
@Injectable({ providedIn: 'root' })
export class NameApiService {
  private readonly http = inject(HttpClient);
  private readonly config = getServerConfig();

  private api(path: string): string {
    return `${this.config.apiBase}${path}`;
  }

  getNames(): Promise<NameEntry[]> {
    return firstValueFrom(this.http.get<NameEntry[]>(this.api('/names')));
  }

  createNameEntry(data: CreateNameEntryRequest): Promise<NameEntry> {
    return firstValueFrom(this.http.post<NameEntry>(this.api('/names'), data));
  }

  updateNameEntry(id: string, data: UpdateNameEntryRequest): Promise<NameEntry> {
    return firstValueFrom(this.http.put<NameEntry>(this.api(`/names/${id}`), data));
  }

  deleteNameEntry(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(this.api(`/names/${id}`)));
  }

  /** Bulk-load a line-oriented list of names (dedup server-side by name). */
  importNames(text: string): Promise<NameEntry[]> {
    return firstValueFrom(this.http.post<NameEntry[]>(this.api('/names/import'), { text }));
  }

  /** Bulk-insert structured name entries in a single server transaction. */
  importBuiltin(entries: CreateNameEntryRequest[]): Promise<NameEntry[]> {
    return firstValueFrom(this.http.post<NameEntry[]>(this.api('/names/bulk'), { entries }));
  }

  // -------------------- persisted replacements (from → to)

  /** All replacements remembered in the database. */
  getReplacements(): Promise<NameReplacement[]> {
    return firstValueFrom(this.http.get<NameReplacement[]>(this.api('/name-replacements')));
  }

  /** Upsert a replacement — an existing entry with the same `from` is updated. */
  saveReplacement(data: CreateNameReplacementRequest): Promise<NameReplacement> {
    return firstValueFrom(
      this.http.post<NameReplacement>(this.api('/name-replacements'), data),
    );
  }

  /** Forget a persisted replacement. */
  deleteReplacement(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(this.api(`/name-replacements/${id}`)));
  }
}
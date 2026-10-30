import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getServerConfig } from '../util/server-config';
import type {
  RestoreTextVersionResult,
  TextVersion,
  TextVersionAttribute,
  TextVersionEntityType,
} from '../../models/text-version';

/**
 * Thin HTTP client for the versioned general-texts endpoints
 * (`/api/text-versions`). New versions are appended automatically by the
 * server whenever a tracked attribute (topic.defaultSystemPrompt,
 * project.systemPrompt/greeting, persona.description) actually changes;
 * this service lists them and lets the UI restore / delete entries.
 */
@Injectable({ providedIn: 'root' })
export class TextVersionApiService {
  private readonly http = inject(HttpClient);
  private readonly config = getServerConfig();

  private api(path: string): string {
    return `${this.config.apiBase}${path}`;
  }

  /** All recorded versions for an entity (optionally one attribute), newest first. */
  getTextVersions(
    entityType: TextVersionEntityType,
    entityId: string,
    attribute?: TextVersionAttribute,
  ): Promise<TextVersion[]> {
    const params: Record<string, string> = { entityType, entityId };
    if (attribute) params['attribute'] = attribute;
    return firstValueFrom(
      this.http.get<TextVersion[]>(this.api('/text-versions'), { params }),
    );
  }

  /** Restore an attribute to the content captured by a version (reversible). */
  restoreTextVersion(id: string): Promise<RestoreTextVersionResult> {
    return firstValueFrom(
      this.http.post<RestoreTextVersionResult>(this.api(`/text-versions/${id}/restore`), {}),
    );
  }

  /** Remove a single recorded version entry. */
  deleteTextVersion(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(this.api(`/text-versions/${id}`)));
  }
}

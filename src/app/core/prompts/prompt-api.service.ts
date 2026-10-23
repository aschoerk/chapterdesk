import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getServerConfig } from '../util/server-config';
import type {
  CreatePromptVersionRequest,
  PromptScope,
  PromptSelection,
  PromptVersion,
  SetPromptSelectionRequest,
  UpdatePromptVersionRequest,
} from '../../models/prompt-version';

/**
 * Thin HTTP client for the editable prompt-template endpoints
 * (`/api/prompt-versions`, `/api/prompt-selections`).
 *
 * Kept as a SEPARATE service from `ChatApiService` because prompts are
 * versioned, named and topic-scoped — a different shape than the rest of the
 * chat-api port. The server (chapterdesk-api-server) stores them in SQLite.
 */
@Injectable({ providedIn: 'root' })
export class PromptApiService {
  private readonly http = inject(HttpClient);
  private readonly config = getServerConfig();

  private api(path: string): string {
    return `${this.config.apiBase}${path}`;
  }

  getPromptVersions(): Promise<PromptVersion[]> {
    return firstValueFrom(this.http.get<PromptVersion[]>(this.api('/prompt-versions')));
  }

  createPromptVersion(data: CreatePromptVersionRequest): Promise<PromptVersion> {
    return firstValueFrom(this.http.post<PromptVersion>(this.api('/prompt-versions'), data));
  }

  updatePromptVersion(id: string, data: UpdatePromptVersionRequest): Promise<PromptVersion> {
    return firstValueFrom(this.http.put<PromptVersion>(this.api(`/prompt-versions/${id}`), data));
  }

  deletePromptVersion(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(this.api(`/prompt-versions/${id}`)));
  }

  getPromptSelections(): Promise<PromptSelection[]> {
    return firstValueFrom(this.http.get<PromptSelection[]>(this.api('/prompt-selections')));
  }

  setPromptSelection(data: SetPromptSelectionRequest): Promise<PromptSelection> {
    return firstValueFrom(this.http.put<PromptSelection>(this.api('/prompt-selections'), data));
  }

  deletePromptSelection(
    promptId: string,
    scope: PromptScope,
    topicId?: string | null,
  ): Promise<void> {
    const params: Record<string, string> = { promptId, scope };
    if (topicId) params['topicId'] = topicId;
    return firstValueFrom(
      this.http.delete<void>(this.api('/prompt-selections'), { params }),
    );
  }
}
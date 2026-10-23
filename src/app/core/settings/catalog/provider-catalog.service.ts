import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ProviderConfig } from '../../../models/chat-config';
import { getServerConfig } from '../../util/server-config';
import { normalizeProviderBaseUrl, isGoogleGeminiUrl } from '../../util/provider-url';

/**
 * PROVIDER-CATALOG I/O: every call the app makes to a provider THROUGH the
 * backend proxy — building the per-provider request headers, testing a
 * provider connection / model, and fetching the model catalog (with the
 * OpenRouter "/images/models" merge). Extracted from `SettingsService` (which
 * keeps the `fetchModels` orchestration that needs the state signals) so the
 * proxy HTTP layer is isolated, injectable and independently testable.
 *
 * Pure transport: returns raw catalog JSON / ok-messages. No state, no
 * persistence — it does not touch the settings store or the CHAT_API.
 */
@Injectable({ providedIn: 'root' })
export class ProviderCatalogService {
  private readonly http = inject(HttpClient);
  private readonly serverConfig = getServerConfig();

  private get PROXY_BASE(): string {
    return this.serverConfig.proxyBase;
  }

  /** Headers sent to the backend /proxy for a provider, per connection kind.
   *  The proxy forwards x-target-base + the auth header(s) to the upstream.
   *  The base URL is normalized defensively (e.g. an AI Studio console URL),
   *  and the AUTH scheme follows the EFFECTIVE kind — a Google base URL always
   *  gets `x-goog-api-key`, even when the stored type predates the Gemini kind. */
  private providerHeaders(provider: ProviderConfig): Record<string, string> {
    const effectiveType = provider.type === 'gemini' || isGoogleGeminiUrl(provider.baseUrl)
      ? 'gemini'
      : provider.type;
    const base = { 'x-target-base': normalizeProviderBaseUrl(effectiveType, provider.baseUrl) };
    switch (effectiveType) {
      case 'gemini':
        // Google Generative Language API: API-key header, not Bearer.
        return { ...base, 'x-goog-api-key': provider.apiKey };
      case 'anthropic':
        // Anthropic: x-api-key + pinned API version.
        return { ...base, 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' };
      default:
        return { ...base, Authorization: `Bearer ${provider.apiKey}` };
    }
  }

  /** Test that the provider's /models endpoint answers (connection check). */
  async testProvider(provider: ProviderConfig): Promise<{ ok: boolean; message: string }> {
    try {
      await firstValueFrom(
        this.http.get(`${this.PROXY_BASE}/models`, {
          headers: this.providerHeaders(provider)
        })
      );
      return { ok: true, message: 'Connection successful' };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.error?.error?.message || err?.message || 'Connection failed'
      };
    }
  }

  /** Test that a model answers a tiny chat completion (model check). */
  async testModel(provider: ProviderConfig, modelId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const response: any = await firstValueFrom(
        this.http.post(
          `${this.PROXY_BASE}/chat/completions`,
          {
            model: modelId,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5
          },
          {
            headers: {
              ...this.providerHeaders(provider),
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://chat-client.local',
              'X-Title': 'ChapterDesk'
            }
          }
        )
      );

      if (response?.choices?.length > 0) {
        return { ok: true, message: `Model "${modelId}" works` };
      }
      return { ok: false, message: 'Unexpected response from model' };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.error?.error?.message || err?.message || 'Test failed'
      };
    }
  }

  /**
   * Fetch every model a provider advertises, through the backend proxy.
   *
   * OpenRouter keeps image-generation models (e.g. `x-ai/grok-imagine-image-2.0`)
   * in a separate catalog served at `GET {baseUrl}/images/models`; they are NOT
   * included in `GET {baseUrl}/models` (that list only contains chat-capable
   * models). Without this merge those image-only models would never be fetched.
   *
   * Envelopes: OpenRouter/OpenAI/Anthropic return `{ data: [...] }`; Google's
   * Gemini returns `{ models: [...] }`.
   */
  async loadProviderCatalog(provider: ProviderConfig): Promise<any[]> {
    const headers = this.providerHeaders(provider);

    const load = async (path: string): Promise<any[]> => {
      try {
        const response: any = await firstValueFrom(
          this.http.get(`${this.PROXY_BASE}${path}`, { headers })
        );
        return response?.data ?? response?.models ?? response ?? [];
      } catch (err: any) {
        // Providers that don't expose an image catalog respond 404 — not fatal,
        // just skip that catalog.
        if (err?.status === 404) return [];
        throw err;
      }
    };

    const chatModels = await load('/models');
    if (provider.type !== 'openrouter') {
      return chatModels;
    }

    const imageModels = await load('/images/models');
    if (imageModels.length === 0) {
      return chatModels;
    }

    // Merge, deduplicated by model id. The chat catalog entry wins on a clash
    // because it carries richer metadata (top_provider, pricing, reasoning, …).
    const byId = new Map<string, any>();
    for (const m of imageModels) {
      if (m?.id && !byId.has(m.id)) byId.set(m.id, m);
    }
    for (const m of chatModels) {
      if (m?.id) byId.set(m.id, m);
    }
    return [...byId.values()];
  }
}
import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ProviderConfig, ModelEntry, ModelArchitecture } from '../models/chat-config';
import { getServerConfig } from './common/server-config';
import { localPricing } from './model-pricing';
import { normalizeProviderBaseUrl, isGoogleGeminiUrl } from './provider-url';
import { CHAT_API } from '../api/chat-api.token';
import { ChatApiPort } from '../api/chat-api.port';
import {
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateModelRequest,
  UpdateModelRequest
} from '../api/chat-api.types';

const VALID_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'file']);

/** Gemini catalog entries use `name: "models/gemini-2.5-flash"`; strip the prefix. */
function geminiModelId(name: string | undefined): string {
  return (name ?? '').replace(/^models\//, '');
}

/** Lowercase + filter the modality lists Gemini reports (e.g. ['TEXT','IMAGE']). */
function lowerModalities(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return (list as unknown[])
    .map(m => String(m).toLowerCase())
    .filter(m => VALID_MODALITIES.has(m));
}

/** Fallback modality derivation when Gemini omits input/outputModalities. */
function geminiFallbackModalities(raw: any): { input: string[]; output: string[] } {
  const methods: string[] = Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
  const input: string[] = [];
  const output: string[] = [];
  if (methods.includes('generateContent')) {
    // Text in/out is the baseline; most generateContent models are also
    // multimodal, but without declared modalities we stay conservative.
    input.push('text');
    output.push('text');
  }
  if (methods.includes('generateImages')) output.push('image');
  if (methods.includes('generateAudio')) output.push('audio');
  return { input, output };
}

function mapProviderModel(
  raw: any,
  providerId: string,
  providerType: ProviderConfig['type']
): Omit<ModelEntry, 'id' | 'enabled'> & { enabled?: boolean } {
  const isGemini = providerType === 'gemini';
  const rawId = isGemini ? geminiModelId(raw.name) : (raw.id ?? raw.name ?? '');
  const displayName = raw.display_name || raw.displayName || raw.name || rawId;

  let architecture: ModelArchitecture | undefined;
  if (isGemini) {
    const inputModalities = lowerModalities(raw.inputModalities);
    const outputModalities = lowerModalities(raw.outputModalities);
    const fallback = geminiFallbackModalities(raw);
    const input = inputModalities.length ? inputModalities : fallback.input;
    const output = outputModalities.length ? outputModalities : fallback.output;
    if (input.length || output.length) {
      architecture = {
        modality: `${input.length ? input.join('+') : 'none'}->${output.length ? output.join('+') : 'none'}`,
        input_modalities: input,
        output_modalities: output
      };
    }
  } else if (raw.architecture) {
    architecture = {
      modality: raw.architecture.modality,
      input_modalities: raw.architecture.input_modalities ?? [],
      output_modalities: raw.architecture.output_modalities ?? []
    };
  }

  const rawPricing = raw.pricing;
  const pricing = rawPricing
    ? {
      prompt: rawPricing.prompt,
      completion: rawPricing.completion,
      request: rawPricing.request,
      image: rawPricing.image,
      web_search: rawPricing.web_search,
      internal_reasoning: rawPricing.internal_reasoning,
      input_cache_read: rawPricing.input_cache_read,
      input_cache_write: rawPricing.input_cache_write
    }
    : localPricing(rawId);

  return {
    displayName,
    modelId: rawId,
    providerId,
    type: 'fetched',
    contextLength: raw.inputTokenLimit ?? raw.context_length ?? raw.top_provider?.context_length ?? undefined,
    description: raw.description ?? '',
    architecture,
    pricing,
    topProvider: raw.top_provider
      ? {
        context_length: raw.top_provider.context_length,
        max_completion_tokens: raw.top_provider.max_completion_tokens ?? null,
        is_moderated: raw.top_provider.is_moderated
      }
      : undefined,
    supportedParameters: raw.supported_parameters ?? [],
    supported_parameters: raw.supported_parameters ?? [],
    reasoning: raw.reasoning,
    created: raw.created ?? raw.created_at,
    ownedBy: raw.owned_by,
    shutdownDate: raw.shutdown_date ?? null,
    canonicalSlug: raw.canonical_slug,
    knowledgeCutoff: raw.knowledge_cutoff ?? null,
    expirationDate: raw.expiration_date ?? null,
    perRequestLimits: raw.per_request_limits ?? null,
    pricing_prompt: pricing?.prompt,
    pricing_completion: pricing?.completion,
    pricing_input_cache_read: pricing?.input_cache_read
  };
}

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly http = inject(HttpClient);
  private readonly serverConfig = getServerConfig();
  private readonly api = inject(CHAT_API);

  private readonly _providers = signal<ProviderConfig[]>([]);
  private readonly _models = signal<ModelEntry[]>([]);

  readonly providers = computed(() => this._providers());
  readonly models = computed(() => this._models());
  /** Enabled models, sorted alphabetically by display name. */
  readonly enabledModels = computed(() =>
    [...this._models().filter(m => m.enabled)].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    )
  );

  constructor() {
    this.loadAll();
  }

  private get API_BASE(): string {
    return this.serverConfig.apiBase;
  }

  private get PROXY_BASE(): string {
    return this.serverConfig.proxyBase;
  }

  async loadAll(): Promise<void> {
    try {
      const [providers, models] = await Promise.all([
        this.api.getProviders(),
        this.api.getModels()
      ]);
      const normalized = await this.upgradeGoogleProviders(providers);
      this._providers.set(normalized);
      this._models.set(models);
    } catch (err) {
      console.error('Failed to load settings from server', err);
    }
  }

  /**
   * A provider saved BEFORE the Gemini kind existed (or typed as custom) with
   * an AI Studio / generativelanguage base URL is upgraded in place: the base
   * URL is normalized to the real Gemini endpoint AND the type is coerced to
   * `gemini` so auth is sent as `x-goog-api-key` (Google ignores Bearer). The
   * change is persisted so the backend `x-provider-id` path uses it too.
   */
  private async upgradeGoogleProviders(list: ProviderConfig[]): Promise<ProviderConfig[]> {
    let changed = false;
    const upgraded = list.map(p => {
      if (!p.baseUrl || !isGoogleGeminiUrl(p.baseUrl)) return p;
      const baseUrl = normalizeProviderBaseUrl('gemini', p.baseUrl);
      if (p.type === 'gemini' && baseUrl === p.baseUrl) return p;
      changed = true;
      return { ...p, type: 'gemini' as const, baseUrl };
    });
    if (!changed) return list;
    // Persist each upgrade; the returned records win over our local snapshot.
    await Promise.all(
      upgraded
        .filter((p, i) => p !== list[i])
        .map(p => this.api.updateProvider(p.id, {
          type: p.type,
          baseUrl: p.baseUrl
        } as UpdateProviderRequest))
    );
    return upgraded;
  }

  async addProvider(provider: Omit<ProviderConfig, 'id'>): Promise<ProviderConfig> {
    const effectiveType = provider.type === 'gemini' || isGoogleGeminiUrl(provider.baseUrl)
      ? 'gemini'
      : provider.type;
    const created = await this.api.createProvider({
      ...provider,
      type: effectiveType,
      baseUrl: normalizeProviderBaseUrl(effectiveType, provider.baseUrl)
    } as CreateProviderRequest);
    this._providers.update(list => [...list, created]);
    return created;
  }

  async updateProvider(id: string, changes: Partial<ProviderConfig>): Promise<void> {
    const existing = this._providers().find(p => p.id === id);
    const type = changes.type ?? existing?.type ?? 'custom';
    const baseUrl = changes.baseUrl ?? existing?.baseUrl ?? '';
    const effectiveType = type === 'gemini' || isGoogleGeminiUrl(baseUrl) ? 'gemini' : type;
    const next: Partial<ProviderConfig> = changes.baseUrl !== undefined
      ? {
        ...changes,
        type: effectiveType,
        baseUrl: normalizeProviderBaseUrl(effectiveType, baseUrl)
      }
      : { ...changes, type: effectiveType };
    const updated = await this.api.updateProvider(id, next as UpdateProviderRequest);
    this._providers.update(list => list.map(p => (p.id === id ? updated : p)));
  }

  async deleteProvider(id: string): Promise<void> {
    await this.api.deleteProvider(id);
    this._providers.update(list => list.filter(p => p.id !== id));
    this._models.update(list => list.filter(m => m.providerId !== id));
  }

  async addPreset(
    displayName: string,
    modelId: string,
    providerId: string,
    architecture?: ModelArchitecture,
    chatParametersId?: string | null
  ): Promise<ModelEntry> {
    const created = await this.api.createModel({
      displayName,
      modelId,
      providerId,
      type: 'preset',
      enabled: true,
      architecture,
      chatParametersId: chatParametersId ?? null
    } as CreateModelRequest);
    this._models.update(list => [...list, created]);
    return created;
  }

  async updateModel(id: string, changes: UpdateModelRequest): Promise<ModelEntry> {
    const updated = await this.api.updateModel(id, changes);
    this._models.update(list => list.map(m => (m.id === id ? updated : m)));
    return updated;
  }

  async deleteModel(id: string): Promise<void> {
    await this.api.deleteModel(id);
    this._models.update(list => list.filter(m => m.id !== id));
  }

  async toggleModelEnabled(id: string): Promise<void> {
    const result = await this.api.toggleModelEnabled(id);
    this._models.update(list =>
      list.map(m => (m.id === id ? { ...m, enabled: result.enabled } : m))
    );
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
  private async loadProviderCatalog(provider: ProviderConfig): Promise<any[]> {
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

  async fetchModels(provider: ProviderConfig): Promise<void> {
    try {
      const currentModels = this._models().filter(m => m.providerId === provider.id);

      const rawModels = await this.loadProviderCatalog(provider);
      const freshList = rawModels.map((m: any) => mapProviderModel(m, provider.id, provider.type));
      const freshById = new Map<string, ReturnType<typeof mapProviderModel>>(
        freshList.map((m: ReturnType<typeof mapProviderModel>) => [m.modelId, m])
      );

      for (const existing of currentModels) {
        if (existing.type === 'preset') {
          continue;
        }

        const fresh = freshById.get(existing.modelId);
        if (!fresh) {
          if (existing.enabled) {
            await this.api.updateModel(existing.id, { type: 'discontinued' } as UpdateModelRequest);
          } else {
            await this.api.deleteModel(existing.id);
          }
          continue;
        }

        await this.api.updateModel(existing.id, {
          ...fresh,
          type: existing.type === 'discontinued' ? 'fetched' : existing.type
        } as UpdateModelRequest);
      }

      const existingIds = new Set(currentModels.map(m => m.modelId));
      for (const model of freshList) {
        if (existingIds.has(model.modelId)) {
          continue;
        }
        await this.api.createModel({
          ...model,
          enabled: false
        } as CreateModelRequest);
      }

      await this.loadAll();
    } catch (err: any) {
      console.error('Failed to fetch models', err);
      throw err;
    }
  }
}

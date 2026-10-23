import { Injectable, signal, computed, inject } from '@angular/core';
import { ProviderConfig, ModelEntry, ModelArchitecture } from '../../models/chat-config';
import { normalizeProviderBaseUrl, isGoogleGeminiUrl } from '../util/provider-url';
import { CHAT_API } from '../../api/chat-api.token';
import {
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateModelRequest,
  UpdateModelRequest
} from '../../api/chat-api.types';
import { mapProviderModel } from './catalog/model-catalog';
import { ProviderCatalogService } from './catalog/provider-catalog.service';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly api = inject(CHAT_API);
  private readonly catalog = inject(ProviderCatalogService);

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

  /** Test that the provider's /models endpoint answers (connection check). */
  testProvider(provider: ProviderConfig): Promise<{ ok: boolean; message: string }> {
    return this.catalog.testProvider(provider);
  }

  /** Test that a model answers a tiny chat completion (model check). */
  testModel(provider: ProviderConfig, modelId: string): Promise<{ ok: boolean; message: string }> {
    return this.catalog.testModel(provider, modelId);
  }

  async fetchModels(provider: ProviderConfig): Promise<void> {
    try {
      const currentModels = this._models().filter(m => m.providerId === provider.id);

      const rawModels = await this.catalog.loadProviderCatalog(provider);
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

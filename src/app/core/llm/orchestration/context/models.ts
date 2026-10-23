import { Injectable, inject } from '@angular/core';
import { Chat, ChatNode } from '../../../../models/chat';
import { ModelEntry, ProviderConfig } from '../../../../models/chat-config';
import { ResolvedChatParameters } from '../../../../models/chat-parameters';
import { ChatParametersService } from '../../../chat/chat-parameters.service';
import { GenerationSettingsService } from '../../../settings/generation-settings.service';
import { ProjectService } from '../../../settings/project.service';
import { SettingsService } from '../../../settings/settings.service';
import { canInterpretImages, canGenerateImages } from '../../../../models/chat-config';
import type { ModelRef } from './types';

/**
 * MODEL / PROVIDER resolution + request-extras for a use case: which
 * rendering / writing / planning / interpret model a request should use, and
 * what parameters (temperature / thinking / stream) it runs with in the
 * current chat. Pure resolution — it never builds messages or prompts (that
 * is `messages.ts` / `prompts.ts`), and it has no request-topic dependency.
 */
@Injectable({ providedIn: 'root' })
export class ContextModelResolverService {
  private readonly projectService = inject(ProjectService);
  private readonly parameters = inject(ChatParametersService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);

  /** Enabled image-capable models, sorted by display name. */
  private enabledImageModels(): ModelEntry[] {
    return this.settings.enabledModels().filter(canGenerateImages);
  }

  /** Enabled image-INTERPRET models (planner fallback), if any. */
  private enabledInterpretModels(): ModelEntry[] {
    return this.settings.enabledModels().filter(canInterpretImages);
  }

  /** Provider of a model, or null. */
  providerFor(model: ModelEntry | null | undefined): ProviderConfig | null {
    if (!model) return null;
    return this.settings.providers().find(p => p.id === model.providerId) ?? null;
  }

  /**
   * Resolve the RENDERING (image) model: prefers an explicit dialog choice
   * (`modelId`/`providerId`, e.g. from the Illustrate dialog), falling back
   * to the configured image-create task / first enabled image-capable model.
   *
   * The explicitly chosen model ALWAYS wins once it is enabled — even when
   * the accompanying `providerId` is stale/empty (a remembered dialog choice
   * whose provider was renamed/removed): in that case the model's OWN
   * provider is used. Silently dropping the chosen model for a stale provider
   * id would swap it for the settings default, which users experience as
   * "the model I selected is ignored".
   */
  resolveImageModel(modelId?: string | null, providerId?: string | null): ModelRef | null {
    if (modelId) {
      const m = this.settings.enabledModels().find(
        mm => mm.modelId === modelId || mm.id === modelId
      );
      if (m) {
        // Prefer the caller's provider when it still resolves; otherwise use
        // the model's own provider. Only when neither exists (model enabled
        // but provider gone) do we fall through to the task default.
        const p = (providerId && this.settings.providers().some(pp => pp.id === providerId))
          ? this.settings.providers().find(pp => pp.id === providerId)!
          : this.providerFor(m);
        if (p) return { model: m, provider: p };
      }
    }
    return this.resolveRenderModel();
  }

  /**
   * Resolve the WRITING model for a plain text send (`append`, structural
   * flows): an explicit override (e.g. a model chosen in a dialog) wins;
   * otherwise the current node's own model when resolvable, else the first
   * enabled model.
   */
  resolveWriteModel(node: ChatNode | null, modelId?: string | null, providerId?: string | null): ModelRef | null {
    if (modelId) {
      const explicit = this.settings.enabledModels().find(m => m.modelId === modelId || m.id === modelId);
      if (explicit) {
        const provider = providerId
          ? this.settings.providers().find(p => p.id === providerId)
          : this.providerFor(explicit);
        if (provider) return { model: explicit, provider };
      }
    }
    const nodeModelId = node?.modelId;
    let model = nodeModelId
      ? this.settings.enabledModels().find(m => m.modelId === nodeModelId || m.id === nodeModelId)
      : null;
    if (!model) model = this.generation.modelFor('default');
    if (!model) model = this.settings.enabledModels()[0] ?? null;
    if (!model) return null;
    const provider = this.providerFor(model);
    return provider ? { model, provider } : null;
  }

  /**
   * Resolve the RENDERING model: the configured "image-create" task model,
   * falling back to the first enabled image-capable model.
   */
  resolveRenderModel(): ModelRef | null {
    let model = this.generation.modelFor('image-create');
    let provider = this.generation.providerFor('image-create');
    if (!model || !provider) {
      const fallback = this.enabledImageModels()[0] ?? null;
      model = fallback;
      provider = fallback ? this.providerFor(fallback) : null;
    }
    return model && provider ? { model, provider } : null;
  }

  /**
   * Resolve the PLANNING model (text model that derives picture
   * descriptions): 1. the node's own writing model if still resolvable;
   * 2. the image-interpret / language-check task; 3. the rendering model.
   */
  resolvePlanModel(render: ModelRef, node: ChatNode | null): ModelRef {
    const nodeModelId = node?.modelId;
    const nodeModel = nodeModelId
      ? this.settings.enabledModels().find(m => m.modelId === nodeModelId || m.id === nodeModelId)
      : null;
    if (nodeModel && nodeModel.id !== render.model.id) {
      const provider = this.providerFor(nodeModel);
      if (provider) return { model: nodeModel, provider };
    }
    for (const kind of ['image-interpret', 'language-check'] as const) {
      const model = this.generation.modelFor(kind);
      const provider = this.generation.providerFor(kind);
      if (model && provider) return { model, provider };
    }
    return render;
  }

  /**
   * Resolve the IMAGE-INTERPRET model (describes attached images before a
   * send): the configured "image-interpret" task model, falling back to the
   * first enabled model that can take image input. Null when none exists.
   */
  resolveInterpretModel(): ModelRef | null {
    let model = this.generation.modelFor('image-interpret');
    let provider = this.generation.providerFor('image-interpret');
    if (!model || !provider) {
      const fallback = this.settings.enabledModels().find(canInterpretImages) ?? null;
      model = fallback;
      provider = fallback ? this.providerFor(fallback) : null;
    }
    return model && provider ? { model, provider } : null;
  }

  /**
   * Resolve the parameters (temperature/thinking/…) + request extras for a
   * model in the CURRENT chat, mirroring the legacy resolution. Image
   * generation is non-streaming, single completion.
   */
  async resolveExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    const resolved = await this.resolveForChat(model, chat);
    const extras = this.toLlmExtras(resolved);
    delete extras['temperature'];
    delete extras['top_k'];
    delete extras['top_p'];
    delete extras['include_reasoning'];
    delete extras['reasoning'];
    return extras;
  }

  /**
   * Resolve FULL text extras (temperature, thinking, stream) for a plain
   * text send (`append`). Keeps everything the legacy text path sends.
   */
  async resolveTextExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    const resolved = await this.resolveForChat(model, chat);
    return this.toLlmExtras(resolved);
  }

  private async resolveForChat(model: ModelEntry, chat: Chat | null): Promise<ResolvedChatParameters> {
    const project = chat?.projectId ? this.projectService.getProject(chat.projectId) ?? null : null;
    const topic = this.projectService.topicForProject(project?.id, this.projectService.topics()) ?? null;
    await this.parameters.loadMany([
      model.chatParametersId,
      topic?.chatParametersId,
      project?.chatParametersId,
      chat?.chatParametersId
    ]);
    return this.parameters.resolveForChat({ model, topic, project, chat });
  }

  /** Port of the legacy toLlmExtras(). */
  private toLlmExtras(resolved: ResolvedChatParameters): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    if (resolved.temperature != null) extras['temperature'] = resolved.temperature;
    if (resolved.topK != null) extras['top_k'] = resolved.topK;
    if (resolved.topM != null) extras['top_p'] = resolved.topM;
    extras['stream'] = resolved.stream ?? true;
    if (resolved.thinking === false) {
      extras['include_reasoning'] = false;
      return extras;
    }
    if (resolved.thinking === true || resolved.thinkingLevel) {
      extras['include_reasoning'] = true;
      if (resolved.thinkingLevel && resolved.thinkingLevel !== 'none') {
        extras['reasoning'] = { effort: resolved.thinkingLevel };
      } else if (resolved.thinkingLevel === 'none') {
        extras['include_reasoning'] = false;
      } else {
        extras['reasoning'] = { enabled: true };
      }
    }
    return extras;
  }
}
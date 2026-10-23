import { ProviderConfig, ModelEntry, ModelArchitecture } from '../../../models/chat-config';
import { localPricing } from '../../prompts/model-pricing';

/**
 * PURE model-catalog mapping: turns the raw provider model-catalog entries
 * (OpenRouter / OpenAI / Anthropic / Gemini list responses) into the app's
 * normalized `ModelEntry` shape. No DI, no I/O — the exact same normalization
 * logic that used to live at the top of `settings.service.ts`, extracted so it
 * is unit-testable and independent of the service's state/signals.
 */

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

/**
 * Gemini modalities, derived by UNIONING all available signals instead of
 * trusting one alone:
 *   - declared `inputModalities`/`outputModalities` (lowercased), AND
 *   - `supportedGenerationMethods` (authoritative when present), AND
 *   - the model id / display name: Google's image models (Nano Banana family,
 *     `gemini-*-image`) frequently do NOT list `generateImages` in the list
 *     endpoint's `supportedGenerationMethods` (and modern `models.list` no
 *     longer exposes `inputModalities`/`outputModalities` at all), so the
 *     stable `-image` / `nano-banana` naming is used as the fallback signal.
 */
const GEMINI_IMAGE_MODEL_RE = /(^|[.-])(image)(\b)|nano[\s-]?banana/i;

function isGeminiImageModel(name: string): boolean {
  return GEMINI_IMAGE_MODEL_RE.test(name || '');
}

function geminiModalities(raw: any): { input: string[]; output: string[] } {
  const methods: string[] = Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
  const input = new Set<string>(lowerModalities(raw.inputModalities));
  const output = new Set<string>(lowerModalities(raw.outputModalities));
  const has = (m: string) => methods.includes(m);

  if (has('generateContent')) {
    // Text in/out is the chat baseline.
    input.add('text');
    output.add('text');
  }
  if (has('generateImages')) output.add('image');
  if (has('generateAudio')) output.add('audio');

  // Name-based fallback: image-generation models signal image capability even
  // when the list response omits `generateImages`.
  const name = `${raw.name ?? ''} ${raw.displayName ?? ''}`;
  if (isGeminiImageModel(name)) {
    // These models accept image inputs (editing) and produce text + images.
    input.add('image');
    output.add('image');
  }

  return { input: [...input], output: [...output] };
}

export function mapProviderModel(
  raw: any,
  providerId: string,
  providerType: ProviderConfig['type']
): Omit<ModelEntry, 'id' | 'enabled'> & { enabled?: boolean } {
  const isGemini = providerType === 'gemini';
  const rawId = isGemini ? geminiModelId(raw.name) : (raw.id ?? raw.name ?? '');
  const displayName = raw.display_name || raw.displayName || raw.name || rawId;

  let architecture: ModelArchitecture | undefined;
  if (isGemini) {
    const { input, output } = geminiModalities(raw);
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

export type FetchedModelPartial = ReturnType<typeof mapProviderModel>;
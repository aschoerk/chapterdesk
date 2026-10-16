import type { ModelPricing } from '../models/chat-config';

/**
 * Local per-model pricing for providers whose catalog API does NOT expose
 * prices (Gemini, OpenAI, Anthropic). The values here are approximate list
 * prices in USD per 1M tokens (input / output), maintained by hand because
 * none of these providers return pricing from their `/models` endpoints.
 *
 * NOTE: OpenRouter exposes real `pricing.*` per-token values from its catalog,
 * so entries below are only used as a FALLBACK when the fetched catalog does
 * not carry a `pricing` block. Multiply by 1e6 at the call site to produce the
 * per-token decimal strings ChapterDesk stores (see `pricingPerMillionToPerToken`).
 */
const PRICES_PER_MILLION: Record<string, { prompt: number; completion: number }> = {
  // ---- Google Gemini (USD / 1M tokens) ----
  'gemini-1.5-flash': { prompt: 0.075, completion: 0.30 },
  'gemini-1.5-flash-8b': { prompt: 0.0375, completion: 0.15 },
  'gemini-1.5-pro': { prompt: 1.25, completion: 5.00 },
  'gemini-2.0-flash': { prompt: 0.10, completion: 0.40 },
  'gemini-2.0-flash-lite': { prompt: 0.075, completion: 0.30 },
  'gemini-2.0-flash-lite-preview': { prompt: 0.075, completion: 0.30 },
  'gemini-2.5-flash': { prompt: 0.30, completion: 2.50 },
  'gemini-2.5-flash-preview': { prompt: 0.30, completion: 2.50 },
  'gemini-2.5-flash-image': { prompt: 0.30, completion: 2.50 },
  'gemini-2.5-pro': { prompt: 1.25, completion: 10.00 },
  'gemini-2.5-pro-preview': { prompt: 1.25, completion: 10.00 },

  // ---- OpenAI (USD / 1M tokens) ----
  'gpt-3.5-turbo': { prompt: 0.50, completion: 1.50 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.60 },
  'gpt-4o': { prompt: 2.50, completion: 10.00 },
  'gpt-4.1-mini': { prompt: 0.40, completion: 1.60 },
  'gpt-4.1': { prompt: 2.00, completion: 8.00 },
  'gpt-4.1-nano': { prompt: 0.10, completion: 0.40 },
  'o3-mini': { prompt: 1.10, completion: 4.40 },

  // ---- Anthropic (USD / 1M tokens) ----
  'claude-3-haiku': { prompt: 0.25, completion: 1.25 },
  'claude-3-5-haiku': { prompt: 0.80, completion: 4.00 },
  'claude-3-sonnet': { prompt: 3.00, completion: 15.00 },
  'claude-3-5-sonnet': { prompt: 3.00, completion: 15.00 },
  'claude-3-7-sonnet': { prompt: 3.00, completion: 15.00 },
  'claude-3-opus': { prompt: 15.00, completion: 75.00 },
  'claude-sonnet-4': { prompt: 3.00, completion: 15.00 },
  'claude-sonnet-4-5': { prompt: 3.00, completion: 15.00 },
  'claude-opus-4': { prompt: 15.00, completion: 75.00 },
  'claude-opus-4-1': { prompt: 15.00, completion: 75.00 },
};

/**
 * Lookup with longest-prefix support: an exact key wins, otherwise the longest
 * key that is a prefix of `modelId` (so families like `gemini-2.5-flash-*`
 * inherit the base price).
 */
function lookup(modelId: string): { prompt: number; completion: number } | undefined {
  const exact = PRICES_PER_MILLION[modelId];
  if (exact) return exact;
  let best: { prompt: number; completion: number } | undefined;
  let bestLen = -1;
  for (const [key, row] of Object.entries(PRICES_PER_MILLION)) {
    if (modelId.startsWith(key) && key.length > bestLen) {
      best = row;
      bestLen = key.length;
    }
  }
  return best;
}

/** Convert a per-1M-token price to the per-token decimal string ChapterDesk stores. */
function perTokenString(perMillion: number): string {
  const perToken = perMillion / 1_000_000;
  // Use a plain decimal (no scientific notation) so the string reads naturally,
  // e.g. $0.30 / 1M → "0.0000003".
  return perToken
    .toFixed(10)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/**
 * Local list-price fallback for a model id. Returns `undefined` (→ the UI shows
 * no price) when the model is not in the table.
 */
export function localPricing(modelId: string): ModelPricing | undefined {
  const row = lookup(modelId);
  if (!row) return undefined;
  return {
    prompt: perTokenString(row.prompt),
    completion: perTokenString(row.completion)
  };
}
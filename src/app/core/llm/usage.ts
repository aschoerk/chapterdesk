/**
 * Pure helpers to normalize provider-reported token usage / cost.
 *
 * The same provider conventions appear everywhere (the /logs page, the
 * per-node header in the chat view and the sidebar's per-chat cost total):
 * OpenAI-style `usage.prompt_tokens` / `completion_tokens` / `total_tokens`
 * (plus `prompt_tokens_details.cached_tokens` and `total_cost`), Anthropic
 * `usage.input_tokens` / `output_tokens`, and the Gemini SDK
 * `usageMetadata.promptTokenCount` / `candidatesTokenCount` /
 * `totalTokenCount`. Parsing here keeps every consumer consistent.
 */

/** Normalized, provider-agnostic usage figures of one LLM call. */
export interface ParsedUsage {
  /** Prompt / input tokens. */
  input?: number;
  /** Completion / output tokens. */
  output?: number;
  /** Cached (prompt-cache hit) input tokens, when the provider reports them. */
  cached?: number;
  /** Total tokens, when the provider reports them. */
  total?: number;
  /** Total USD cost of the call, when the provider reports it. */
  cost?: number;
}

/**
 * Extract the normalized usage figures from a provider `usage` block (or
 * `usageMetadata`), or null when there is nothing usable. Numbers may arrive
 * as JSON numbers or strings; NaN/negative values are discarded.
 */
export function parseProviderUsage(usage: unknown): ParsedUsage | null {
  if (usage == null || typeof usage !== 'object') return null;
  const o = usage as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
  };
  // Cost is a small USD fraction — keep full decimal precision.
  const decimal = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const details = o['prompt_tokens_details'];
  const out: ParsedUsage = {
    input: num(o['prompt_tokens']) ?? num(o['input_tokens']) ?? num(o['promptTokenCount']),
    output: num(o['completion_tokens']) ?? num(o['output_tokens']) ?? num(o['candidatesTokenCount']),
    total: num(o['total_tokens']) ?? num(o['totalTokenCount']),
    cached: (details && typeof details === 'object')
      ? num((details as Record<string, unknown>)['cached_tokens'])
      : undefined,
    cost: decimal(o['total_cost']) ?? decimal(o['cost'])
  };
  return Object.values(out).some(v => v !== undefined) ? out : null;
}

/** Sum two usage figures element-wise (undefined stays undefined). */
export function addUsage(a: ParsedUsage | null | undefined, b: ParsedUsage | null | undefined): ParsedUsage | null {
  if (!a && !b) return null;
  const sum = (x?: number, y?: number): number | undefined =>
    (x === undefined && y === undefined) ? undefined : (x ?? 0) + (y ?? 0);
  return {
    input: sum(a?.input, b?.input),
    output: sum(a?.output, b?.output),
    cached: sum(a?.cached, b?.cached),
    total: sum(a?.total, b?.total),
    cost: sum(a?.cost, b?.cost)
  };
}

/** Sum the parsed usage of several calls (skips nulls). */
export function sumUsage(list: (ParsedUsage | null | undefined)[]): ParsedUsage | null {
  let acc: ParsedUsage | null = null;
  for (const u of list) acc = addUsage(acc, u);
  return acc;
}
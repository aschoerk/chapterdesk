import { describe, expect, it } from 'vitest';
import { addUsage, parseProviderUsage, sumUsage } from './usage';

describe('parseProviderUsage', () => {
  it('returns null for missing / non-object usage', () => {
    expect(parseProviderUsage(null)).toBeNull();
    expect(parseProviderUsage(undefined)).toBeNull();
    expect(parseProviderUsage('tokens')).toBeNull();
  });

  it('parses OpenAI-style usage (prompt/completion/total)', () => {
    const u = parseProviderUsage({
      prompt_tokens: 128,
      completion_tokens: 342,
      total_tokens: 470
    });
    expect(u?.input).toBe(128);
    expect(u?.output).toBe(342);
    expect(u?.total).toBe(470);
    expect(u?.cached).toBeUndefined();
  });

  it('parses Anthropic-style usage (input/output)', () => {
    const u = parseProviderUsage({ input_tokens: 25, output_tokens: 30 });
    expect(u?.input).toBe(25);
    expect(u?.output).toBe(30);
  });

  it('parses Gemini-style usageMetadata token counts', () => {
    const u = parseProviderUsage({
      promptTokenCount: 10,
      candidatesTokenCount: 42,
      totalTokenCount: 52
    });
    expect(u?.input).toBe(10);
    expect(u?.output).toBe(42);
    expect(u?.total).toBe(52);
  });

  it('extracts cached tokens from prompt_tokens_details', () => {
    const u = parseProviderUsage({
      prompt_tokens: 200,
      prompt_tokens_details: { cached_tokens: 80 }
    });
    expect(u?.input).toBe(200);
    expect(u?.cached).toBe(80);
  });

  it('keeps full cost precision and accepts string numbers', () => {
    const u = parseProviderUsage({ prompt_tokens: '5', total_cost: '0.0004185' });
    expect(u?.input).toBe(5);
    expect(u?.cost).toBe(0.0004185);
  });

  it('discards negative / NaN values', () => {
    const u = parseProviderUsage({ prompt_tokens: -4, completion_tokens: NaN });
    expect(u?.input).toBeUndefined();
    expect(u?.output).toBeUndefined();
  });
});

describe('addUsage / sumUsage', () => {
  it('adds element-wise and treats undefined as 0', () => {
    const sum = addUsage(
      { input: 10, output: 20, cost: 0.001 },
      { input: 5, output: 2, cached: 3, cost: 0.0005 }
    );
    expect(sum).toEqual({ input: 15, output: 22, cached: 3, cost: 0.0015, total: undefined });
  });

  it('returns null when both sides are null', () => {
    expect(addUsage(null, undefined)).toBeNull();
    expect(addUsage(null, { cost: 1 })?.cost).toBe(1);
  });

  it('sums a list, skipping nulls', () => {
    const s = sumUsage([
      null,
      { input: 100, output: 1 },
      undefined,
      { output: 2, cost: 0.01 }
    ]);
    expect(s?.input).toBe(100);
    expect(s?.output).toBe(3);
    expect(s?.cost).toBe(0.01);
  });
});
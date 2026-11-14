import { describe, expect, it, vi, afterEach } from 'vitest';
import { newId, isSentenceComplete } from './helpers';

/**
 * newId() has three code paths: crypto.randomUUID (Node/jsdom), a manual
 * UUIDv4 built from crypto.getRandomValues, and a Math.random fallback.
 * We cover the randomUUID path normally and exercise the two fallbacks by
 * temporarily removing the higher-priority APIs.
 */

describe('newId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a UUID-shaped string with the default crypto.randomUUID path', () => {
    const id = newId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(newId()).not.toBe(id);
  });

  it('falls back to crypto.getRandomValues when randomUUID is missing', () => {
    const cryptoObj = globalThis.crypto as Crypto;
    const originalRandomUUID = (cryptoObj as unknown as { randomUUID?: () => string })
      .randomUUID;
    const getRandomValuesSpy = vi.spyOn(cryptoObj, 'getRandomValues');

    try {
      Object.defineProperty(cryptoObj, 'randomUUID', {
        configurable: true,
        value: undefined,
      });
      const id = newId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(getRandomValuesSpy).toHaveBeenCalled();
      // The manual path fills a version/variant nibble.
      expect(id[14]).toBe('4');
    } finally {
      Object.defineProperty(cryptoObj, 'randomUUID', {
        configurable: true,
        value: originalRandomUUID,
      });
    }
  });

  it('falls back to Math.random when the crypto API is completely unavailable', () => {
    const originalCrypto = globalThis.crypto;
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      const id = newId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(randomSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});

describe('isSentenceComplete', () => {
  it('treats terminal punctuation as a finished sentence', () => {
    expect(isSentenceComplete('She left the room.')).toBe(true);
    expect(isSentenceComplete('Did she?')).toBe(true);
    expect(isSentenceComplete('No!')).toBe(true);
    expect(isSentenceComplete('And then…')).toBe(true);
    expect(isSentenceComplete('  padded with spaces.  ')).toBe(true);
  });

  it('treats a TRAILING EMOJI as a finished sentence', () => {
    // \u{1F60A} = grinning face with smiling eyes; \u{1F680} = rocket.
    expect(isSentenceComplete('She just smiled \u{1F60A}')).toBe(true);
    expect(isSentenceComplete('He walked away \u{1F680}')).toBe(true);
    // \u2705 = white heavy check mark.
    expect(isSentenceComplete('Report written \u2705')).toBe(true);
    // Punctuation followed by an emoji (\u{1F389} = party popper).
    expect(isSentenceComplete('The end! \u{1F389}')).toBe(true);
    // \u{1F914} = thinking face.
    expect(isSentenceComplete('Really? \u{1F914}')).toBe(true);
  });

  it('handles emoji with variation selectors, modifiers, ZWJ joins and flags', () => {
    // Heart + VARIATION SELECTOR-16.
    expect(isSentenceComplete('Love it \u2764\uFE0F')).toBe(true);
    // Emoji + skin-tone modifier.
    expect(isSentenceComplete('Great job \u{1F44D}\u{1F3FD}')).toBe(true);
    // ZWJ-joined family sequence.
    expect(isSentenceComplete(
      'My family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'
    )).toBe(true);
    // Two regional indicators (a country flag).
    expect(isSentenceComplete('Greetings from \u{1F1E9}\u{1F1EA}')).toBe(true);
    // Emoji followed by a closing curly quote.
    expect(isSentenceComplete('\u201CShe smiled \u{1F60A}\u201D')).toBe(true);
  });

  it('reports unfinished text as incomplete', () => {
    expect(isSentenceComplete('')).toBe(false);
    expect(isSentenceComplete('   ')).toBe(false);
    expect(isSentenceComplete('The chapter was cut off mid')).toBe(false);
    expect(isSentenceComplete('trailing comma,')).toBe(false);
    // A closing quote alone is not a sentence end.
    expect(isSentenceComplete('“unfinished text”')).toBe(false);
    // A bare ellipsis-free dash ending is not a sentence end.
    expect(isSentenceComplete('he said —')).toBe(false);
  });

  it('does not mistake ordinary trailing characters for a sentence end', () => {
    expect(isSentenceComplete('ends with a number 42')).toBe(false);
    expect(isSentenceComplete('ends with a letter')).toBe(false);
    expect(isSentenceComplete('ends with a bold marker **')).toBe(false);
  });
});
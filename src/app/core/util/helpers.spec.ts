import { describe, expect, it, vi, afterEach } from 'vitest';
import { newId } from './helpers';

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
import type { ProviderType } from '../../models/chat-config';

/**
 * Google's Generative Language API hosts:
 *   https://generativelanguage.googleapis.com  (the real API)
 *   https://aistudio.google.com                (the web console — NOT an API!)
 *
 * AI Studio's console endpoints reject API-key callers with
 * "Method doesn't allow unregistered callers… Please use API Key…", so any
 * request that ends up there MUST be rewritten to the real API.
 */

const GEMINI_HOSTS = new Set([
  'aistudio.google.com',
  'generativelanguage.googleapis.com'
]);

/** True when the base URL points at a Google Gemini surface (console or API). */
export function isGoogleGeminiUrl(baseUrl: string): boolean {
  const raw = (baseUrl || '').trim().toLowerCase();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
    return GEMINI_HOSTS.has(host);
  } catch {
    return GEMINI_HOSTS.has(raw);
  }
}

/**
 * Rewrite provider base URLs that are "wrong but common" to the real Gemini
 * endpoint. Google-URL detection is TYPE-INDEPENDENT — a provider saved as
 * `custom`/`openrouter` with an AI Studio base URL is normalized the same way
 * (in `isGoogleGeminiUrl` callers the connection type is then coerced to
 * `gemini` so the auth header is `x-goog-api-key` as well).
 */
export function normalizeProviderBaseUrl(type: ProviderType, baseUrl: string): string {
  const raw = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return raw;

  if (type === 'gemini' || isGoogleGeminiUrl(raw)) {
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'aistudio.google.com') {
        // Any AI Studio console URL → the real API endpoint.
        return 'https://generativelanguage.googleapis.com/v1beta';
      }
      if (host === 'generativelanguage.googleapis.com') {
        // Keep a versioned path; default missing/unversioned to v1beta.
        if (/^\/(v1|v1beta)(\/|$)/.test(u.pathname)) return raw;
        return 'https://generativelanguage.googleapis.com/v1beta';
      }
    } catch {
      /* non-parseable: fall through, return trimmed */
    }
  }

  return raw;
}
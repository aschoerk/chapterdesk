import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, NextFunction, Request, Response } from 'express';
import type { PersistencePort } from '../domain/chat-api.port.js';
import type { ProviderConfig } from '../domain/models.js';
import { badRequest, HttpError } from './http-error.js';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

export function normalizeBase(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function proxySuffix(req: Request): string {
  const original = req.originalUrl || req.url;
  const url = new URL(original, 'http://127.0.0.1');
  const path = url.pathname.replace(/^\/proxy/, '') || '/';
  return `${path}${url.search}`;
}

/** Auth headers forwarded verbatim when the client addresses the upstream by
 *  `x-target-base` (provider not persisted yet — e.g. a prospective-provider
 *  test from the settings dialog). The client sets the right scheme per kind. */
const FORWARD_AUTH_HEADERS = ['authorization', 'x-goog-api-key', 'x-api-key', 'anthropic-version'] as const;

/** True when a base URL points at Google's Gemini surface (AI Studio console
 *  or the real API). Used so a provider saved before the `gemini` kind existed
 *  (e.g. typed `custom`) still authenticates with `x-goog-api-key`. */
function isGoogleGeminiUrl(baseUrl: string): boolean {
  const raw = (baseUrl || '').trim().toLowerCase();
  if (!raw) return false;
  return raw.includes('aistudio.google.com') || raw.includes('generativelanguage.googleapis.com');
}

/** Rewrite a Google Gemini base URL to the real API endpoint (host-specific;
 *  any other host — e.g. a local OpenAI-compatible server typed gemini — is
 *  left untouched). */
function normalizeGeminiBase(url: string): string {
  const raw = (url || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'aistudio.google.com') {
      // AI Studio console → the real API.
      return 'https://generativelanguage.googleapis.com/v1beta';
    }
    if (host === 'generativelanguage.googleapis.com') {
      // Keep a versioned path; default missing/unversioned to v1beta.
      if (/^\/(v1|v1beta)(\/|$)/.test(u.pathname)) return raw;
      return 'https://generativelanguage.googleapis.com/v1beta';
    }
  } catch {
    /* non-parseable: return trimmed */
  }
  return raw;
}

/** Auth headers built from a persisted provider record, by connection kind.
 *  The kind is derived from the URL when it is clearly Google — a legacy
 *  `custom` provider pointing at AI Studio would otherwise get a Bearer header
 *  that Google ignores (→ "Method doesn't allow unregistered callers"). */
function providerAuthHeaders(provider: ProviderConfig): Record<string, string> {
  const kind = provider.type === 'gemini' || isGoogleGeminiUrl(provider.baseUrl)
    ? 'gemini'
    : provider.type;
  switch (kind) {
    case 'gemini':
      // Google's Generative Language API authenticates with an API-key header.
      return { 'x-goog-api-key': provider.apiKey };
    case 'anthropic':
      // Anthropic requires x-api-key plus a pinned API version header.
      return { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' };
    default:
      return { Authorization: `Bearer ${provider.apiKey}` };
  }
}

async function resolveUpstream(
  req: Request,
  store: PersistencePort
): Promise<{ baseUrl: string; authHeaders: Record<string, string>; providerId?: string }> {
  const providerId = header(req, 'x-provider-id');
  const targetBase = header(req, 'x-target-base');

  if (providerId) {
    const providers = await store.getProviders();
    const provider = providers.find((row) => row.id === providerId);
    if (!provider) {
      throw new HttpError(403, 'provider is not in this store');
    }
    if (!provider.enabled) {
      throw new HttpError(403, 'provider is disabled');
    }
    return {
      // normalizeGeminiBase rewrites only actual Google hosts (AI Studio
      // console / unversioned API) — every other host passes through.
      baseUrl: normalizeBase(normalizeGeminiBase(provider.baseUrl)),
      authHeaders: providerAuthHeaders(provider),
      providerId: provider.id
    };
  }

  if (!targetBase) {
    throw badRequest('Missing x-target-base or x-provider-id header');
  }

  const authHeaders: Record<string, string> = {};
  for (const name of FORWARD_AUTH_HEADERS) {
    const value = header(req, name);
    if (value) authHeaders[name] = value;
  }
  return { baseUrl: normalizeBase(targetBase), authHeaders };
}

async function handleProxy(req: Request, res: Response, store: PersistencePort): Promise<void> {
  const upstream = await resolveUpstream(req, store);
  const target = `${upstream.baseUrl}${proxySuffix(req)}`;
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const method = req.method.toUpperCase();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream.authHeaders)) {
    if (value) headers[name] = value;
  }
  const referer = header(req, 'http-referer') ?? header(req, 'referer');
  if (referer) headers['HTTP-Referer'] = referer;
  const title = header(req, 'x-title');
  if (title) headers['X-Title'] = title;
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? JSON.stringify(req.body ?? {}) : undefined;

  console.log(`→ ${method} ${proxySuffix(req)}  →  ${upstream.baseUrl}` +
    (upstream.providerId ? `  provider=${upstream.providerId}` : ''));

  const response = await fetch(target, {
    method,
    headers,
    body,
    signal: abort.signal
  });

  console.log(`← Status: ${response.status}`);

  res.status(response.status);
  const contentType = response.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');

  if (!response.body) {
    res.send(await response.text());
    return;
  }

  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  await pipeline(nodeStream, res);
}

export function registerProxyRoutes(app: Express, store: PersistencePort): void {
  app.use('/proxy', (req: Request, res: Response, next: NextFunction) => {
    handleProxy(req, res, store).catch((err: unknown) => {
      // Once the upstream stream is being piped, headers are already flushed
      // and the body may be partially sent. Express can no longer produce an
      // error payload — forwarding would trigger ERR_HTTP_HEADERS_SENT.
      if (res.headersSent) {
        console.error(`proxy error after response started: ${err instanceof Error ? err.message : err}`);
        try { res.end(); } catch { /* client may already be gone */ }
        return;
      }
      next(err);
    });
  });
}

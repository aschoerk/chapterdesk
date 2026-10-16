/**
 * Proxy auth adaptation per provider type:
 *   - resolved via `x-provider-id` → the proxy builds the upstream auth header
 *     from the persisted provider record (Bearer for OpenAI-compatible kinds,
 *     x-goog-api-key for Gemini, x-api-key+version for Anthropic).
 *   - addressed via `x-target-base` (not yet persisted, e.g. prospective-provider
 *     test) → the client's auth header(s) are forwarded verbatim.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { makeApp } from './helpers/app.js';

let app: Express;

// Small upstream capture server: records the request line + headers it saw.
const seen: { url: string; headers: Record<string, string> }[] = [];
let upstream: Server;
let upstreamBase: string;

beforeAll(async () => {
  ({ app } = await makeApp());
  upstream = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])
      ),
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'upstream-model', name: 'Upstream' }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address() as AddressInfo;
  upstreamBase = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstream.close((err) => (err ? reject(err) : resolve()))
  );
});

async function createProvider(type: string, apiKey: string, baseUrl = upstreamBase) {
  const res = await request(app)
    .post('/api/providers')
    .send({ name: type, type, baseUrl, apiKey, enabled: true });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

describe('proxy auth adaptation', () => {
  test('Gemini provider (x-provider-id) → upstream gets x-goog-api-key, not Bearer', async () => {
    const provider = await createProvider('gemini', 'AIza-secret-123');
    seen.length = 0;

    const res = await request(app)
      .get('/proxy/models')
      .set('x-provider-id', provider.id);

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers['x-goog-api-key']).toBe('AIza-secret-123');
    expect(seen[0].headers['authorization']).toBeUndefined();
  });

  test('Anthropic provider (x-provider-id) → upstream gets x-api-key + anthropic-version', async () => {
    const provider = await createProvider('anthropic', 'sk-ant-secret');
    seen.length = 0;

    const res = await request(app)
      .get('/proxy/models')
      .set('x-provider-id', provider.id);

    expect(res.status).toBe(200);
    expect(seen[0].headers['x-api-key']).toBe('sk-ant-secret');
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[0].headers['authorization']).toBeUndefined();
  });

  test('OpenAI-compatible provider (x-provider-id) → upstream gets Authorization Bearer', async () => {
    const provider = await createProvider('openrouter', 'sk-or-secret');
    seen.length = 0;

    const res = await request(app)
      .get('/proxy/models')
      .set('x-provider-id', provider.id);

    expect(res.status).toBe(200);
    expect(seen[0].headers['authorization']).toBe('Bearer sk-or-secret');
  });

  test('x-target-base path forwards the client auth headers verbatim', async () => {
    seen.length = 0;

    const res = await request(app)
      .get('/proxy/models')
      .set('x-target-base', upstreamBase)
      .set('x-goog-api-key', 'AIza-client-provided')
      .set('anthropic-version', '2023-06-01');

    expect(res.status).toBe(200);
    expect(seen[0].headers['x-goog-api-key']).toBe('AIza-client-provided');
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  test('legacy custom provider with a Google URL → x-goog-api-key + real API host (no Bearer)', async () => {
    // Provider saved before the gemini kind existed: type custom, AI Studio URL.
    const provider = await createProvider('custom', 'AIza-legacy-key', 'https://aistudio.google.com/v1beta');

    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;
    try {
      const res = await request(app).get('/proxy/models').set('x-provider-id', provider.id);
      expect(res.status).toBe(200);
      // URL rewritten from AI Studio console to the real Gemini API.
      expect(capturedUrl).toContain('https://generativelanguage.googleapis.com/v1beta/models');
      expect(capturedHeaders?.get('x-goog-api-key')).toBe('AIza-legacy-key');
      expect(capturedHeaders?.get('authorization')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
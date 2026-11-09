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
import http, { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import {
  isGoogleGeminiUrl,
  normalizeGeminiBase,
  providerAuthHeaders,
} from '../src/http/proxy.js';
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

  test('legacy custom provider with a Google URL → x-goog-api-key + real API host (no Bearer)', () => {
    // Provider saved before the gemini kind existed: type custom, AI Studio URL.
    // The proxy no longer uses fetch (undici's 300 s ceiling cut long renders),
    // so the URL/auth adaptation is asserted on the pure helpers directly.
    const provider = {
      id: 'legacy',
      name: 'legacy',
      type: 'custom' as const,
      baseUrl: 'https://aistudio.google.com/v1beta',
      apiKey: 'AIza-legacy-key',
      enabled: true,
    };

    expect(isGoogleGeminiUrl(provider.baseUrl)).toBe(true);
    expect(normalizeGeminiBase(provider.baseUrl))
      .toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(providerAuthHeaders(provider)).toEqual({ 'x-goog-api-key': 'AIza-legacy-key' });
    expect(providerAuthHeaders(provider)['authorization']).toBeUndefined();
  });
});

describe('proxy streaming', () => {
  test('relays SSE chunks incrementally and sends no interim 102 for event streams', async () => {
    const sse = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"a":1}\n\n');
      setTimeout(() => {
        res.write('data: {"b":2}\n\n');
        res.end();
      }, 120);
    });
    await new Promise<void>((resolve) => sse.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (sse.address() as AddressInfo).port;

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const apiPort = (server.address() as AddressInfo).port;

    try {
      const interim: number[] = [];
      const arrivalTimes: number[] = [];
      const started = Date.now();
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: apiPort,
            path: '/proxy/chat/completions',
            method: 'POST',
            headers: {
              accept: 'text/event-stream',
              'content-type': 'application/json',
              'x-target-base': `http://127.0.0.1:${upstreamPort}`,
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              arrivalTimes.push(Date.now() - started);
              data += String(chunk);
            });
            res.on('end', () => resolve(data));
          },
        );
        req.on('information', (info) => interim.push(info.statusCode ?? 0));
        req.on('error', reject);
        req.end('{"stream":true}');
      });

      expect(body).toContain('{"a":1}');
      expect(body).toContain('{"b":2}');
      // First chunk arrived well before the upstream finished → not buffered.
      expect(arrivalTimes[0]).toBeLessThan(120);
      // SSE sends its own data; no extra heartbeat should be injected.
      expect(interim).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        sse.close((err) => (err ? reject(err) : resolve()))
      );
    }
  }, 10_000);
});

describe('proxy long-running requests', () => {
  test('waits for a slow upstream instead of failing at a fixed timeout', async () => {
    // Simulates an SD render: no bytes for a while, then the JSON result.
    const slow = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ images: ['AAAA'] }));
      }, 400);
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const port = (slow.address() as AddressInfo).port;

    try {
      const res = await request(app)
        .post('/proxy/sdapi/v1/txt2img')
        .set('x-target-base', `http://127.0.0.1:${port}`)
        .send({ prompt: 'a lantern' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ images: ['AAAA'] });
    } finally {
      await new Promise<void>((resolve, reject) =>
        slow.close((err) => (err ? reject(err) : resolve()))
      );
    }
  }, 10_000);

  test('emits interim 102 responses while the upstream is still working', async () => {
    const slow = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      }, 350);
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (slow.address() as AddressInfo).port;

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const apiPort = (server.address() as AddressInfo).port;

    const previous = process.env.CHAPTERDESK_PROXY_KEEPALIVE_MS;
    process.env.CHAPTERDESK_PROXY_KEEPALIVE_MS = '60';
    try {
      const interim: number[] = [];
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: apiPort,
            path: '/proxy/sdapi/v1/txt2img',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-target-base': `http://127.0.0.1:${upstreamPort}`,
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += String(chunk)));
            res.on('end', () => resolve(data));
          },
        );
        // 1xx interim responses are emitted on the ClientRequest.
        req.on('information', (info) => interim.push(info.statusCode ?? 0));
        req.on('error', reject);
        req.end('{"prompt":"x"}');
      });

      expect(body).toContain('"ok":true');
      // At least one heartbeat was relayed before the final response.
      expect(interim.length).toBeGreaterThan(0);
      expect(interim.every((code) => code === 102)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CHAPTERDESK_PROXY_KEEPALIVE_MS;
      else process.env.CHAPTERDESK_PROXY_KEEPALIVE_MS = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        slow.close((err) => (err ? reject(err) : resolve()))
      );
    }
  }, 10_000);
});
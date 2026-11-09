/**
 * WebSocket proxy multiplexer — protocol + concurrency tests.
 *
 * One socket must carry MANY logically independent requests: a request is
 * identified by its id, and head/chunk/end frames are routed back per id. A
 * slow image render must not block a fast JSON call on the same socket.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import WebSocket from 'ws';
import { registerProxyMux, type ProxyMuxHandle } from '../src/http/proxy-mux.js';
import type { PersistencePort } from '../src/domain/chat-api.port.js';
import { makeApp } from './helpers/app.js';

interface Frame {
  t: string;
  id: string;
  status?: number;
  contentType?: string;
  data?: string;
  text?: string;
}

/** Collects frames per request id until 'end' or 'err' arrives. */
class Collector {
  private readonly frames = new Map<string, Frame[]>();
  private readonly waiters = new Map<string, ((f: Frame[]) => void)[]>();

  push(frame: Frame): void {
    const list = this.frames.get(frame.id) ?? [];
    list.push(frame);
    this.frames.set(frame.id, list);
    if (frame.t === 'end' || frame.t === 'err') {
      const waiting = this.waiters.get(frame.id) ?? [];
      this.waiters.delete(frame.id);
      for (const resolve of waiting) resolve(list);
    }
  }

  wait(id: string, timeoutMs = 5000): Promise<Frame[]> {
    const existing = this.frames.get(id);
    if (existing && existing.some((f) => f.t === 'end' || f.t === 'err')) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), timeoutMs);
      const list = this.waiters.get(id) ?? [];
      list.push((frames) => {
        clearTimeout(timer);
        resolve(frames);
      });
      this.waiters.set(id, list);
    });
  }
}

/** Decode the base64 chunk frames into one UTF-8 string. */
function payloadOf(frames: Frame[]): string {
  const bytes: Uint8Array[] = [];
  for (const frame of frames) {
    if (frame.t !== 'chunk' || !frame.data) continue;
    const binary = Buffer.from(frame.data, 'base64');
    bytes.push(new Uint8Array(binary));
  }
  const total = bytes.reduce((n, b) => n + b.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const b of bytes) {
    merged.set(b, offset);
    offset += b.length;
  }
  return new TextDecoder().decode(merged);
}

let app: Express;
let store: PersistencePort;
let upstream: Server;
let upstreamBase = '';
let apiServer: Server;
let mux: ProxyMuxHandle;
let socket: WebSocket;
const collector = new Collector();

/** Upstream routes used by the tests. */
const upstreamLog: string[] = [];
/** Headers each upstream route actually received (lowercased keys). */
const seenHeaders: Record<string, Record<string, string>> = {};
/** Ids whose upstream request was closed before the response finished. */
const abortedUpstream: string[] = [];

beforeAll(async () => {
  ({ app, store } = await makeApp());

  upstream = createServer((req, res) => {
    upstreamLog.push(req.url ?? '');
    seenHeaders[req.url ?? ''] = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, String(v)])
    );
    if (req.url === '/slow-abort') {
      req.on('close', () => abortedUpstream.push('slow-abort'));
      // Never answer: the client must be able to abort this one.
      return;
    }
    if (req.url === '/stream') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"delta":"one"}\n\n');
      setTimeout(() => {
        res.write('data: {"delta":"two"}\n\n');
        res.end();
      }, 60);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  apiServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => apiServer.once('listening', resolve));
  // Requests in these tests address the upstream directly via x-target-base,
  // so the mux never consults the provider table.
  mux = registerProxyMux(apiServer, store);

  const port = (apiServer.address() as AddressInfo).port;
  socket = new WebSocket(`ws://127.0.0.1:${port}/proxy-mux`);
  socket.on('message', (raw) => {
    try {
      collector.push(JSON.parse(String(raw)) as Frame);
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
});

afterAll(async () => {
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  mux?.close();
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    upstream.close((err) => (err ? reject(err) : resolve()))
  );
});

function request(id: string, path: string, body: unknown = {}): void {
  socket.send(
    JSON.stringify({
      t: 'req',
      id,
      path,
      method: 'POST',
      headers: { 'x-target-base': upstreamBase, 'content-type': 'application/json' },
      body,
    })
  );
}

describe('proxy mux protocol', () => {
  test('returns head, chunk and end for a JSON upstream response', async () => {
    request('json-1', '/echo');
    const frames = await collector.wait('json-1');

    const head = frames.find((f) => f.t === 'head');
    expect(head?.status).toBe(200);
    expect(head?.contentType).toContain('application/json');
    expect(payloadOf(frames)).toContain('"ok":true');
    expect(frames[frames.length - 1].t).toBe('end');
  });

  test('streams SSE chunks as separate frames on the same socket', async () => {
    request('sse-1', '/stream');
    const frames = await collector.wait('sse-1');

    const chunks = frames.filter((f) => f.t === 'chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const text = payloadOf(frames);
    expect(text).toContain('"delta":"one"');
    expect(text).toContain('"delta":"two"');
    expect(frames[frames.length - 1].t).toBe('end');
  });

  test('runs a slow request and a fast request CONCURRENTLY on one socket', async () => {
    // Start the slow one first (never answers on its own), then the fast one.
    request('slow-1', '/slow-abort');
    request('fast-1', '/echo');

    // The fast request must complete while the slow one is still in flight —
    // proof that one socket multiplexes independent requests.
    const fastFrames = await collector.wait('fast-1', 2000);
    expect(payloadOf(fastFrames)).toContain('"ok":true');

    // Now abort the slow one; the upstream request must be torn down.
    socket.send(JSON.stringify({ t: 'abort', id: 'slow-1' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(abortedUpstream).toContain('slow-abort');
  });

  test('forwards Content-Type and the client Authorization header to the upstream', async () => {
    socket.send(
      JSON.stringify({
        t: 'req',
        id: 'headers-1',
        path: '/echo-headers',
        method: 'POST',
        headers: {
          'x-target-base': upstreamBase,
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-123',
        },
        body: { a: 1 },
      })
    );
    const frames = await collector.wait('headers-1');
    expect(frames[frames.length - 1].t).toBe('end');

    // Header names are case-insensitive on the wire but plain object lookups
    // are not — a capitalized client header must still reach the upstream.
    const seen = seenHeaders['/echo-headers'];
    expect(seen['content-type']).toContain('application/json');
    expect(seen['authorization']).toBe('Bearer test-token-123');
  });

  test('reports an error frame when the upstream base is missing', async () => {
    socket.send(
      JSON.stringify({
        t: 'req',
        id: 'bad-1',
        path: '/echo',
        method: 'POST',
        headers: {},
        body: {},
      })
    );
    const frames = await collector.wait('bad-1');
    const err = frames.find((f) => f.t === 'err');
    expect(err).toBeTruthy();
    expect(String(err?.text)).toMatch(/x-target-base|x-provider-id/i);
  });
});

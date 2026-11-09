import http, { type IncomingMessage, type Server } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { PersistencePort } from '../domain/chat-api.port.js';
import type { Request } from 'express';
import { resolveUpstream } from './proxy.js';

/**
 * WEBSOCKET PROXY MULTIPLEXER — one socket, arbitrarily many concurrent
 * upstream requests.
 *
 * WHY: browsers cap HTTP/1.1 at ~6 concurrent connections per origin, and that
 * pool is SHARED with every `/api/*` call. Long-lived LLM streams (and image
 * renders that take minutes) exhaust it, so opening a second chat — or even
 * loading the chat list — appears to hang. WebSockets live in a SEPARATE pool
 * (~255 per host), so multiplexing all proxy traffic over ONE socket removes
 * the ceiling entirely.
 *
 * PROTOCOL (JSON text frames):
 *
 *   client → server
 *     { t: 'req', id, path, method?, headers?, body? }   start a request
 *     { t: 'abort', id }                                 cancel a request
 *
 *   server → client
 *     { t: 'head', id, status, contentType }             upstream answered
 *     { t: 'chunk', id, data }                           base64 payload bytes
 *     { t: 'end', id }                                   upstream finished
 *     { t: 'err', id, text }                             transport failure
 *
 * `head` carries the upstream STATUS even for 4xx/5xx so the client keeps the
 * normal "non-2xx → read error body" behaviour. `err` is reserved for failures
 * with no upstream status at all (connection refused, DNS, socket reset).
 *
 * Binary-safe: chunk data is base64, so images/octets survive intact.
 */

const MUX_PATH = '/proxy-mux';

/** Headers the client may pass through to the upstream (auth is rebuilt from
 *  the provider record by `resolveUpstream`). */
const FORWARD_HEADERS = ['http-referer', 'x-title', 'content-type'] as const;

interface ReqFrame {
  t: 'req';
  id: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface AbortFrame {
  t: 'abort';
  id: string;
}

export interface ProxyMuxHandle {
  close(): void;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* the peer is gone — nothing to do */
  }
}

/** Normalize a client-supplied path into a proxy-relative URL path. */
function normalizePath(path: string): string {
  const trimmed = (path || '').trim();
  if (!trimmed) throw new Error('missing path');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Header names are case-insensitive on the wire, but plain object lookups are
 * not. The client sends `Content-Type`, `Authorization`, `HTTP-Referer`, …
 * while `resolveUpstream`/`header()` index by lowercase name — so normalize
 * ONCE here, otherwise auth and content-type would be silently dropped.
 */
function normalizeHeaders(client: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!client) return out;
  for (const [name, value] of Object.entries(client)) {
    if (typeof value === 'string' && value) out[name.toLowerCase()] = value;
  }
  return out;
}

/** Re-create the proper header casing for forwarding to the upstream. */
function buildForwardHeaders(lower: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const casing: Record<string, string> = {
    'content-type': 'Content-Type',
    'http-referer': 'HTTP-Referer',
    'x-title': 'X-Title',
  };
  for (const name of FORWARD_HEADERS) {
    const value = lower[name];
    if (value) out[casing[name] ?? name] = value;
  }
  return out;
}

/**
 * Attach the multiplexer to an existing HTTP server. Returns a handle whose
 * `close()` detaches the upgrade listener and stops the socket server (used by
 * tests and graceful shutdown).
 */
export function registerProxyMux(server: Server, store: PersistencePort): ProxyMuxHandle {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      return;
    }
    if (pathname !== MUX_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket) => {
    /** Requests still streaming, so an abort/close can tear the upstream down. */
    const inflight = new Map<string, http.ClientRequest>();

    ws.on('error', () => {
      /* handled by 'close' */
    });

    ws.on('close', () => {
      for (const req of inflight.values()) {
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
      }
      inflight.clear();
    });

    ws.on('message', (raw: unknown) => {
      let frame: ReqFrame | AbortFrame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;

      if (frame.t === 'abort') {
        const req = inflight.get(String(frame.id ?? ''));
        if (req) {
          inflight.delete(String(frame.id));
          try {
            req.destroy();
          } catch {
            /* already gone */
          }
        }
        return;
      }

      if (frame.t !== 'req') return;
      void handleRequest(ws, inflight, frame, store);
    });
  });

  return {
    close(): void {
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* already gone */
        }
      }
      wss.close();
    },
  };
}

async function handleRequest(
  ws: WebSocket,
  inflight: Map<string, http.ClientRequest>,
  frame: ReqFrame,
  store: PersistencePort,
): Promise<void> {
  const id = String(frame.id ?? '');
  if (!id) return;

  try {
    const path = normalizePath(frame.path);
    const method = (frame.method ?? 'POST').toUpperCase();
    // Lowercase once — `resolveUpstream`/`header()` index by lowercase name.
    const clientHeaders = normalizeHeaders(frame.headers);
    // resolveUpstream only reads headers, so a header-only request shim is
    // enough (no Express request object needed).
    const upstream = await resolveUpstream({ headers: clientHeaders } as Request, store);

    const target = new URL(`${upstream.baseUrl}${path}`);
    const headers: Record<string, string> = {
      ...buildForwardHeaders(clientHeaders),
      ...upstream.authHeaders,
    };

    const payload = frame.body === undefined ? undefined : JSON.stringify(frame.body);
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));

    const transport = target.protocol === 'https:' ? https : http;

    await new Promise<void>((resolve) => {
      const upstreamReq = transport.request(target, { method, headers }, (upstreamRes) => {
        send(ws, {
          t: 'head',
          id,
          status: upstreamRes.statusCode ?? 502,
          contentType: String(upstreamRes.headers['content-type'] ?? ''),
        });
        upstreamRes.on('data', (chunk: Buffer) => {
          send(ws, { t: 'chunk', id, data: chunk.toString('base64') });
        });
        upstreamRes.on('end', () => {
          inflight.delete(id);
          send(ws, { t: 'end', id });
          resolve();
        });
        upstreamRes.on('error', (err: Error) => {
          inflight.delete(id);
          send(ws, { t: 'err', id, text: err.message });
          resolve();
        });
      });

      // No socket idle timeout — a render may legitimately take many minutes.
      upstreamReq.setTimeout(0);
      upstreamReq.on('error', (err: Error) => {
        inflight.delete(id);
        send(ws, { t: 'err', id, text: err.message });
        resolve();
      });

      inflight.set(id, upstreamReq);
      if (payload !== undefined) upstreamReq.write(payload);
      upstreamReq.end();
    });
  } catch (err: unknown) {
    send(ws, { t: 'err', id, text: err instanceof Error ? err.message : String(err) });
  }
}

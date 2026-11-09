import { Injectable } from '@angular/core';
import { getServerConfig } from '../util/server-config';

/**
 * CLIENT SIDE OF THE WEBSOCKET PROXY MULTIPLEXER.
 *
 * Browsers allow only ~6 concurrent HTTP/1.1 connections per origin, and that
 * pool is shared with every `/api/*` call — so a couple of long-lived LLM
 * streams (or one slow image render) starves the rest of the app. A WebSocket
 * lives in a SEPARATE pool, so this client carries ALL proxy traffic over ONE
 * socket and multiplexes the logical requests by id.
 *
 * Server contract (see chapterdesk-api-server/src/http/proxy-mux.ts):
 *   → { t: 'req', id, path, method, headers, body }
 *   → { t: 'abort', id }
 *   ← { t: 'head', id, status, contentType }
 *   ← { t: 'chunk', id, data }        base64 bytes
 *   ← { t: 'end', id }
 *   ← { t: 'err', id, text }          transport failure (no upstream status)
 *
 * A non-2xx upstream still arrives as `head` + body, so callers keep the
 * normal "read the error body" behaviour; `err` is only for failures with no
 * upstream status at all.
 */

/** Structurally compatible with `Response` for the subset the transport uses. */
export interface ProxyResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<any>;
}

/** Thrown when the multiplexer cannot be used at all — callers may fall back
 *  to plain HTTP. Never thrown for a request that already reached the server. */
export class MuxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MuxUnavailableError';
  }
}

interface Pending {
  resolve: (response: ProxyResponse) => void;
  reject: (error: unknown) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  stream: ReadableStream<Uint8Array>;
  closed: boolean;
}

function decodeBase64(data: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Node fallback (tests / non-browser runtimes).
  const buffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (buffer) return new Uint8Array(buffer.from(data, 'base64'));
  return new Uint8Array();
}

/** Response returned for a multiplexed request. */
class MuxResponse implements ProxyResponse {
  private textCache: string | null = null;
  readonly headers: { get(name: string): string | null };

  constructor(
    readonly status: number,
    contentType: string,
    readonly body: ReadableStream<Uint8Array>,
  ) {
    this.headers = {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    };
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    if (this.textCache !== null) return this.textCache;
    const reader = this.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.textCache = new TextDecoder('utf-8', { fatal: false }).decode(merged);
    return this.textCache;
  }

  async json(): Promise<any> {
    return JSON.parse(await this.text());
  }
}

@Injectable({ providedIn: 'root' })
export class ProxyMuxClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private unavailable = false;

  /** True when a WebSocket exists in this runtime and the mux is usable. */
  enabled(): boolean {
    return !this.unavailable && typeof WebSocket !== 'undefined';
  }

  /** The multiplexer URL derived from the configured proxy base. */
  url(): string {
    const base = getServerConfig().proxyBase; // http(s)://host:port/proxy
    return base
      .replace(/^http/i, 'ws')
      .replace(/\/proxy\/?$/, '/proxy-mux');
  }

  /**
   * Perform one proxied request over the shared socket. Rejects with
   * {@link MuxUnavailableError} only when the socket cannot be established, so
   * the caller can fall back to plain HTTP.
   */
  async request(
    path: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<ProxyResponse> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await this.connect();

    const id = `${Date.now().toString(36)}-${(this.sequence += 1).toString(36)}`;
    return new Promise<ProxyResponse>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });

      const pending: Pending = { resolve, reject, controller, stream, closed: false };
      this.pending.set(id, pending);

      const cleanup = (): void => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        this.pending.delete(id);
        this.send({ t: 'abort', id });
        try {
          controller?.error(new DOMException('Aborted', 'AbortError'));
        } catch {
          /* already closed */
        }
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.send({ t: 'req', id, path, method: 'POST', headers, body });
    });
  }

  /** Close the socket and fail every in-flight request (shutdown/tests). */
  close(reason = 'proxy-mux closed'): void {
    this.failAll(reason);
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }

  private send(frame: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* the peer is gone — 'close' handles the cleanup */
    }
  }

  private connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    const attempt = new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url());
      } catch (err) {
        this.unavailable = true;
        reject(new MuxUnavailableError(`proxy-mux unavailable: ${String(err)}`));
        return;
      }

      const timer = setTimeout(() => {
        this.unavailable = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new MuxUnavailableError('proxy-mux connect timeout'));
      }, 4000);

      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        this.unavailable = false;
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        this.unavailable = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new MuxUnavailableError('proxy-mux unavailable'));
      };
      socket.onmessage = (event: MessageEvent) => this.onMessage(event);
      socket.onclose = () => {
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        this.failAll('proxy-mux closed');
      };
    });

    this.connecting = attempt.finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onMessage(event: MessageEvent): void {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const id = String(frame?.['id'] ?? '');
    const pending = this.pending.get(id);
    if (!pending) return;

    switch (frame['t']) {
      case 'head': {
        const status = Number(frame['status'] ?? 502);
        const contentType = String(frame['contentType'] ?? '');
        pending.resolve(new MuxResponse(status, contentType, pending.stream));
        break;
      }
      case 'chunk': {
        const bytes = decodeBase64(String(frame['data'] ?? ''));
        if (bytes.length) this.enqueue(pending, bytes);
        break;
      }
      case 'end': {
        this.finish(id, pending);
        break;
      }
      case 'err': {
        this.pending.delete(id);
        const error = Object.assign(new Error(String(frame['text'] ?? 'proxy error')), {
          status: 0,
          text: String(frame['text'] ?? 'proxy error'),
        });
        pending.reject(error);
        break;
      }
      default:
        break;
    }
  }

  private enqueue(pending: Pending, bytes: Uint8Array): void {
    if (pending.closed || !pending.controller) return;
    try {
      pending.controller.enqueue(bytes);
    } catch {
      pending.closed = true;
    }
  }

  private finish(id: string, pending: Pending): void {
    this.pending.delete(id);
    if (pending.closed) return;
    pending.closed = true;
    try {
      pending.controller?.close();
    } catch {
      /* already closed */
    }
  }

  private failAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.closed) continue;
      pending.closed = true;
      try {
        pending.controller?.error(new Error(reason));
      } catch {
        /* already closed */
      }
      pending.reject(new Error(reason));
    }
  }
}

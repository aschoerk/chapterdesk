import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersistencePort } from '../domain/chat-api.port.js';
import { HttpError } from './http-error.js';
import { registerOpenApiRoutes } from './openapi.js';
import { registerProxyRoutes } from './proxy.js';
import { registerChatApiRoutes } from './routes.js';
import { registerMockLlmRoutes } from './mock-llm.js';

function publicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'public'),
    path.resolve(here, '../public'),
    path.resolve(here, '../../public'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
}

const IDB_KINDS = ['chats', 'chat-parameters', 'projects', 'topics', 'personas', 'providers', 'models'];
const ALL_KINDS = ['users', 'auth', 'chats', 'chat-parameters', 'projects', 'topics', 'personas', 'providers', 'models'];

/**
 * Storage split the SPA should use (see DOCKER-MODES.txt). An explicit
 * `CHAPTERDESK_STORAGE` env var wins (used by the E2E stack to force the
 * client onto the seeded HTTP/SQLite API); otherwise it follows the runtime:
 * docker/gcloud → everything in IndexedDB, everything else → SQLite/server.
 */
function storageFor(kind: string | undefined, docker: boolean): {
  profile: string;
  sqlite: string[];
  idb: string[];
} {
  const forced = (kind ?? '').toLowerCase().trim();
  if (forced === 'sqlite-all') {
    return { profile: 'sqlite-all', sqlite: [...ALL_KINDS], idb: [] };
  }
  if (forced === 'indexeddb-all') {
    return { profile: 'indexeddb-all', sqlite: [], idb: [...IDB_KINDS] };
  }
  if (forced === 'chats-idb') {
    return { profile: 'chats-idb', sqlite: ALL_KINDS.filter(k => k !== 'chats'), idb: ['chats'] };
  }
  if (forced === 'chats-params-idb') {
    return {
      profile: 'chats-params-idb',
      sqlite: ALL_KINDS.filter(k => k !== 'chats' && k !== 'chat-parameters'),
      idb: ['chats', 'chat-parameters'],
    };
  }
  if (forced === 'theme-local') {
    return {
      profile: 'theme-local',
      sqlite: ALL_KINDS.filter(k => k !== 'personas' && k !== 'projects'),
      idb: ['personas', 'projects'],
    };
  }
  // runtime heuristic (Docker/gcloud → IndexedDB, else SQLite/server)
  return docker
    ? { profile: 'indexeddb-all', sqlite: [], idb: [...IDB_KINDS] }
    : { profile: 'sqlite-all', sqlite: [...ALL_KINDS], idb: [] };
}

/**
 * Central error handler for the API app. Must be registered AFTER the routes
 * whose errors it should catch (Express only forwards to downstream handlers),
 * e.g. the chat routes and the streaming /proxy route.
 */
export function errorHandler(err: unknown, res: Response): void {
  // Safety net for streamed/partial responses (e.g. a proxy body that failed
  // mid-stream): once headers are flushed we cannot send a status or body,
  // so close the connection instead of crashing with ERR_HTTP_HEADERS_SENT.
  if (res.headersSent) {
    try { res.end(); } catch { /* client may already be gone */ }
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const named = err as { name?: string };
  if (named?.name === 'AbortError') {
    res.end();
    return;
  }
  const message = err instanceof Error ? err.message : 'internal error';
  res.status(500).json({ error: message });
}

export function createApp(store: PersistencePort) {
  const app = express();
  const spaRoot = publicDir();

  // 'null' is the Origin the browser sends when the SPA is loaded from a
  // file:// URL (packaged Electron). Allow it so the desktop app can reach the
  // localhost API without being blocked by CORS.
  app.use(cors({ origin: ['http://localhost:4200', 'null'] }));
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, persistence: store.kind });
  });
  app.get('/api/environment', (_req, res) => {
    const runtime = process.env.CHAPTERDESK_RUNTIME;
    const docker = runtime === 'docker-prod' || runtime === 'docker-dev';
    const gcloud = runtime === 'gcloud' || store.kind === 'firebase';
    const storage = storageFor(process.env.CHAPTERDESK_STORAGE, docker || gcloud);
    res.json({
      runtime: docker ? runtime : gcloud ? 'gcloud' : 'local',
      docker,
      partlySqlite: false,
      storage,
      auth: {
        login: 'none',
        username: null,
        userId: null,
        googleConfigured: false,
        required: false,
        skipLogin: true,
      },
      persistence: store.kind,
    });
  });

  registerOpenApiRoutes(app);
  registerChatApiRoutes(app, store);
  registerProxyRoutes(app, store);
  // Must be registered before the SPA static fallback so the mock provider
  // (whose baseUrl points back at this server) is reachable through /proxy.
  registerMockLlmRoutes(app);

  app.use(express.static(spaRoot, { index: 'index.html', fallthrough: true }));

  app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const index = path.join(spaRoot, 'index.html');
    if (!fs.existsSync(index)) {
      res.status(404).json({ error: `SPA not found at ${spaRoot}` });
      return;
    }
    res.sendFile(index);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    errorHandler(err, res);
  });

  return app;
}

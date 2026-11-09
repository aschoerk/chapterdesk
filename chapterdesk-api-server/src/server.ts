import { createPersistence, detectPersistenceKind } from './persistence/factory.js';
import { createApp } from './http/create-app.js';
import { registerProxyMux } from './http/proxy-mux.js';

async function main(): Promise<void> {
  const store = await createPersistence();
  const app = createApp(store);
  const port = Number(process.env.PORT ?? 3847);
  const host = process.versions.electron ? '127.0.0.1' : '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`chapterdesk-api ${store.kind} on ${host}:${port} (detect=${detectPersistenceKind()})`);
  });
  // One socket carries every proxy request, so long LLM streams and slow
  // image renders no longer exhaust the browser's 6-connections-per-origin.
  registerProxyMux(server, store);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

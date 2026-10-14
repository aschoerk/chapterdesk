import { getServerConfig } from '../common/server-config';

/**
 * The built-in, key-free "Mock (no key)" provider.
 *
 * Its baseUrl points back at the local API server (the same one that hosts
 * /api and /proxy) where `registerMockLlmRoutes` answers OpenAI-shaped
 * requests (`/chat/completions`, `/models`). A user can therefore play with a
 * fully working ChapterDesk — writing, titles, headings, language checks —
 * without any provider API key.
 *
 * Seeding is idempotent by provider NAME (see `DemoDataService.ensureMockProvider`).
 */
export const MOCK_PROVIDER_NAME = 'Mock (no key)';
export const MOCK_MODEL_ID = 'mock-writer';
export const MOCK_MODEL_DISPLAY = 'Mock Writer';

/** Base URL of the local API server (e.g. `http://127.0.0.1:3847`). */
export function mockProviderBaseUrl(): string {
  const apiBase = getServerConfig().apiBase; // e.g. http://127.0.0.1:3847/api
  const base = apiBase.replace(/\/?api\/?$/, '');
  return base || 'http://127.0.0.1:3847';
}
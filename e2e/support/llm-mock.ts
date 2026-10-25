import { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Wiremock-style LLM for E2E tests.
//
// The Angular client calls POST {proxyBase}/chat/completions
// (proxyBase = the single E2E origin, e.g. http://127.0.0.1:8081/proxy) and
// streams the answer as a sequence of SSE `data:` events. Instead of letting
// the API server proxy to a real provider, these helpers intercept that
// request in the browser and fulfill it with a canned, deterministic SSE
// stream — exactly like a wiremock.
// ---------------------------------------------------------------------------

export const CHAT_COMPLETIONS_GLOB = '**/proxy/chat/completions';
export const IMAGES_GLOB = '**/proxy/images';

export interface MockedLlmRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export interface LlmMockScript {
  /** Assistant text lines — each emitted as its own content delta. */
  answer?: string[];
  /** Optional reasoning/thinking text streamed before the answer. */
  thinking?: string[];
  /** Optional extra raw SSE `data:` payloads (before [DONE]). */
  extraData?: string[];
  /** If true, respond with a non-stream JSON payload instead of SSE. */
  nonStream?: boolean;
  /** Image generation result: the answer is a non-stream JSON with this many
   *  `image_url` parts (URLs are generated deterministically) — used by the
   *  Illustrate render calls (UC1–UC5) and image-send (UC14). */
  images?: number;
  /** Planning-pass result: respond with a non-stream JSON whose content is a
   *  `{"pictures": [...]}` array of this many generated descriptions — used
   *  by the planned-enblock / planned-scenes planning call. */
  planning?: number;
  /** Refusal: respond 200 with `message.refusal` (no content). */
  refusal?: string;
}

const openaiData = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

const DONE = 'data: [DONE]\n\n';

/** Build an SSE body from a script. Separate events are concatenated. */
export function sseBody(script: LlmMockScript): string {
  if (script.nonStream) {
    throw new Error('sseBody() is only for streaming scripts');
  }
  const parts: string[] = [];
  for (const piece of script.thinking ?? []) {
    parts.push(openaiData({ reasoning_content: piece }));
  }
  for (const line of script.answer ?? ['(empty answer)']) {
    parts.push(openaiData({ content: line }));
  }
  for (const raw of script.extraData ?? []) {
    parts.push(`data: ${raw}\n\n`);
  }
  parts.push(DONE);
  return parts.join('');
}

/** Non-streaming OpenAI-style completion JSON. */
export function completionJson(answer: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: answer } }],
  });
}

/**
 * Deterministic data-URL "image" for the mock image model. The client renders
 * `data:` URLs fine; distinct `index`/`scene` values produce distinct URLs so
 * a storyboard of N yields N visibly different attachments.
 */
export function mockImageDataUrl(index: number, label?: string): string {
  const safe = (label ?? 'pic').replace(/[^a-zA-Z0-9 _-]/g, '') || 'pic';
  const palette = ['#1d6b9e', '#c2471d', '#2e6b35', '#6a6f78', '#9a8c6a'];
  const color = palette[index % palette.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">` +
    `<rect width="120" height="80" fill="#eef2f7"/>` +
    `<rect x="20" y="16" width="80" height="48" rx="6" fill="${color}"/>` +
    `<text x="60" y="44" font-family="sans-serif" font-size="11" fill="#ffffff" text-anchor="middle">${safe}#${index + 1}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** A non-stream chat-completion whose message carries `image_url` parts. */
export function imageCompletionJson(indexes: number[], label?: string): string {
  return JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: indexes.map(i => ({
          type: 'image_url',
          image_url: { url: mockImageDataUrl(i, label) }
        }))
      }
    }],
  });
}

/** A non-stream refusal completion (message.refusal, no content). */
export function refusalCompletionJson(reason: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', refusal: reason } }],
  });
}

/** A non-stream planning completion: content = `{"pictures":[...]}`. */
export function planningCompletionJson(descriptions: string[]): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: JSON.stringify({ pictures: descriptions }) } }],
  });
}

/**
 * Build the body for ONE mocked LLM call from a script. Kept pure so a
 * scripted-sequence mock can reuse it.
 */
export function mockLlmBody(script: LlmMockScript): {
  contentType: string;
  body: string;
} {
  // Image generation (non-stream, image_url parts).
  if (typeof script.images === 'number') {
    const indexes = Array.from({ length: script.images }, (_, i) => i);
    return { contentType: 'application/json', body: imageCompletionJson(indexes) };
  }
  // Planning pass (non-stream, pictures array). Generates deterministic
  // descriptions so the render call has something concrete to "draw".
  if (typeof script.planning === 'number') {
    const descriptions = Array.from(
      { length: script.planning },
      (_, i) => `Mock scene ${i + 1} — a quiet harbour at ${['dusk', 'dawn', 'noon', 'night'][i % 4]}.`
    );
    return { contentType: 'application/json', body: planningCompletionJson(descriptions) };
  }
  // Moderation refusal (non-stream).
  if (script.refusal) {
    return { contentType: 'application/json', body: refusalCompletionJson(script.refusal) };
  }
  // Plain text (streaming SSE or single-shot JSON).
  const contentType = script.nonStream ? 'application/json' : 'text/event-stream';
  const body = script.nonStream
    ? completionJson((script.answer ?? ['']).join('\n'))
    : sseBody(script);
  return { contentType, body };
}

/** One request recorded by a mock. */
export function recordRequest(req: import('@playwright/test').Request): MockedLlmRequest {
  let body: MockedLlmRequest['body'] = null;
  try {
    const raw = req.postData();
    if (raw) body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* leave null */
  }
  return { url: req.url(), method: req.method(), headers: req.headers(), body };
}

/**
 * Install a wiremock for /proxy/chat/completions on `page`.
 * Returns the request log so tests can assert on what the UI actually sent
 * (model id, provider, message history, …).
 */
export async function mockLlm(
  page: Page,
  script: LlmMockScript = {}
): Promise<MockedLlmRequest[]> {
  return mockLlmScripts(page, [script]);
}

/**
 * Install a SCRIPTED SEQUENCE wiremock for /proxy/chat/completions.
 * Each mocked LLM request consumes the NEXT script in `scripts` (the last one
 * repeats), so multi-call use cases (planned-enblock/scenes = planning call +
 * render call; per-scene fallbacks; reprise) get a deterministic reply per
 * call. Returns the request log.
 */
export async function mockLlmScripts(
  page: Page,
  scripts: LlmMockScript[]
): Promise<MockedLlmRequest[]> {
  const log: MockedLlmRequest[] = [];
  let call = 0;

  await page.route(CHAT_COMPLETIONS_GLOB, async (route) => {
    const req = route.request();
    log.push(recordRequest(req));

    const script = scripts[Math.min(call, scripts.length - 1)] ?? {};
    call++;
    const { contentType, body: bodyText } = mockLlmBody(script);

    await route.fulfill({
      status: 200,
      contentType,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
      body: bodyText,
    });
  });

  return log;
}

/**
 * Install a mock for the OpenRouter-Images fallback endpoint
 * (`/proxy/images`, `{ model, prompt, n }`). Returns image_url data-URLs so a
 * transport /images fallback produces attachable pictures.
 */
export async function mockImagesEndpoint(
  page: Page,
  n = 1
): Promise<MockedLlmRequest[]> {
  const log: MockedLlmRequest[] = [];
  await page.route(IMAGES_GLOB, async (route) => {
    const req = route.request();
    log.push(recordRequest(req));
    const indexes = Array.from({ length: n }, (_, i) => i);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ created: 1, data: indexes.map(i => ({ url: mockImageDataUrl(i) })) }),
    });
  });
  return log;
}

/** Convenience: install + wait until at least one request has been recorded. */
export async function withLlmMock(
  page: Page,
  script: LlmMockScript = {},
  run: (log: MockedLlmRequest[]) => Promise<void>
): Promise<MockedLlmRequest[]> {
  const log = await mockLlm(page, script);
  await run(log);
  return log;
}
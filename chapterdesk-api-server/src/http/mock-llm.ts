import type { Express, Request, Response } from 'express';

/**
 * Built-in mock LLM.
 *
 * A local, key-free "provider" so an installed ChapterDesk can be played with
 * out of the box. The mock provider's baseUrl points back at THIS server
 * (see `src/app/core/mock-llm/mock-llm-config.ts` on the client), so the
 * regular `/proxy` route forwards the usual OpenAI-shaped requests here:
 *
 *   POST  /chat/completions   (streaming SSE and non-stream JSON)
 *   GET   /models             (model catalog for Settings → providers)
 *   GET   /images/models      (image catalog — empty, text-only mock)
 *
 * The replies are plausible, direction-aware prose so every writing path
 * (send/append/branch/regenerate/elaborate, titles, headings, language
 * checks) returns 200-shaped data instead of failing. No external calls.
 */

export const MOCK_MODEL_ID = 'mock-writer';
export const MOCK_MODEL_NAME = 'Mock Writer';

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
      )
      .join('\n\n');
  }
  return '';
}

function normalizeMessages(messages: unknown): { role: string; content: string }[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is { role?: unknown; content?: unknown } => !!m && typeof m === 'object')
    .map((m) => ({
      role: typeof m.role === 'string' ? m.role : 'user',
      content: textOf(m.content),
    }))
    .filter((m) => m.content.trim().length > 0);
}

function lastMessage(messages: { role: string; content: string }[]): string {
  return messages[messages.length - 1]?.content ?? '';
}

// ---------------------------------------------------------------------------
// Small deterministic reply generator
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'your', 'its', 'you',
  'are', 'that', 'this', 'will', 'how', 'what', 'when', 'where', 'why',
  'write', 'next', 'chapter', 'then', 'make', 'give', 'tell', 'could',
  'would', 'shall', 'about', 'over', 'under', 'through', 'after', 'before',
  'against', 'between', 'during', 'without', 'each', 'such', 'there',
  'their', 'they', 'them', 'have', 'been', 'were', 'was', 'not',
  'title', 'generate', 'create', 'please', 'story', 'text', 'section',
]);

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(0 | i)) | 0;
  return Math.abs(h) || 1;
}

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** Distinct, meaningful words from a direction (up to 6). */
export function keyPhrases(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
      if (out.length >= 6) break;
    }
  }
  return out;
}

function extractInt(text: string): number | null {
  const m = text.match(/\b(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

function mockTitle(direction: string): string {
  const k = keyPhrases(direction);
  const seed = hash(direction);
  const subjects = ['The Keeper', 'The Voyage', 'The Letter', 'The Crossing', 'The Hearth'];
  const themes = ['Light', 'Tide', 'Promise', 'Return', 'Silence'];
  const s = subjects[seed % subjects.length];
  const t = themes[(seed >> 3) % themes.length];
  const kw = k[0] ? ` of the ${k[0]}` : '';
  return `${s}${kw} — ${t}`;
}

function mockList(direction: string): string {
  const n = Math.min(Math.max(extractInt(direction) ?? 3, 1), 12);
  const k = keyPhrases(direction);
  const json = /(json\s*array|array)/i.test(direction);
  const lines: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const suffix = k[(seedOf(direction, i)) % Math.max(k.length, 1)] ?? 'story';
    const title = `${wordNumber(i)} — ${capitalize(suffix)}`;
    lines.push(json ? `"${title}"` : `${i}. ${title}`);
  }
  return json ? `[\n${lines.join(',\n')}\n]` : lines.join('\n');
}

function seedOf(text: string, i: number): number {
  return (hash(text) + i * 13) | 0;
}

function wordNumber(i: number): string {
  const base = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  return i <= base.length ? `Chapter ${base[i - 1]}` : `Chapter ${i}`;
}

function mockLanguageCheck(): string {
  return [
    'Your text reads well. I clarified a few phrasings and smoothed two long sentences.',
    '',
    'Suggested rewrite:',
    '“The wind carried the salt in from the harbour, and the day settled into its slow work.”',
    '',
    'Grammar and clarity are already strong — the main change is rhythm.',
  ].join('\n');
}

const OPENERS = [
  'The wind carried the salt in from the harbour, and the day settled into its slow work.',
  'Morning came quietly, the way it always did before something changed.',
  'There was a pause in the village that morning, as if the houses themselves were listening.',
  'The light was low and the streets were empty, but the story had already begun moving.',
  'She noticed the silence first — the kind that holds its breath before a turning point.',
];

const CLOSERS = [
  'Somewhere ahead, the next scene was already waiting — patient, certain, and closer than it seemed.',
  'Whatever came next, it would not find them unprepared.',
  'And that, she decided, would have to be enough for now.',
  'The shadows lengthened, but the way forward stayed open.',
  'She left the room the way one leaves a threshold: already half inside the next moment.',
];

function mockProse(direction: string): string {
  const k = keyPhrases(direction);
  const seed = hash(direction || 'empty');
  const kw = (i: number): string => k[(seed + i) % Math.max(k.length, 1)] ?? 'morning';

  const opener = OPENERS[seed % OPENERS.length];
  const first = k.length
    ? `Something about the ${kw(0)} would not let go — a thread the day kept pulling toward ${kw(1)}.`
    : 'Something about the day would not let go — a thread it kept pulling toward the morning.';

  const second =
    `The details pressed in — each familiar and yet strangely unsettled. ` +
    (k[2] ? `Whatever the ${kw(2)} demanded, ` : 'Whatever the hour demanded, ') +
    `there was no hurry, only the next step and the one after it.`;

  const closing = CLOSERS[(seed >> 5) % CLOSERS.length];

  return [opener, first, second, closing].join('\n\n');
}

/** Build a reasonable assistant reply for a chat-completions request. */
export function buildChatReply(messages: unknown, model: string): string {
  const normalized = normalizeMessages(messages);
  const direction = lastMessage(normalized);

  if (!direction.trim()) {
    return mockProse('');
  }
  if (/title\b/i.test(direction) && direction.length < 120) return mockTitle(direction);
  if (/(json\s*array|array\s*of|chapter descriptions|headings?)/i.test(direction)) {
    return mockList(direction);
  }
  if (/(english|grammar|language|rephrase)/i.test(direction)) return mockLanguageCheck();
  return mockProse(direction);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function usageFor(messages: unknown, model: string, reply: string) {
  const promptTokens = estimateTokens(lastMessage(normalizeMessages(messages)));
  const completionTokens = estimateTokens(reply);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function splitForStreaming(text: string, size: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '));
  return out.length ? out : [''];
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

const CATALOG = {
  object: 'list',
  data: [
    {
      id: MOCK_MODEL_ID,
      object: 'model',
      created: 1720000000,
      owned_by: 'chapterdesk',
      name: MOCK_MODEL_NAME,
      context_length: 8192,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: [],
    },
  ],
};

function handleModels(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'application/json');
  res.json(CATALOG);
}

function handleChatCompletions(req: Request, res: Response): void {
  const body = (req.body ?? {}) as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
  };
  const model = typeof body.model === 'string' ? body.model : MOCK_MODEL_ID;
  const reply = buildChatReply(body.messages, model);
  const usage = usageFor(body.messages, model, reply);
  const stream = body.stream !== false;

  if (!stream) {
    res.setHeader('Content-Type', 'application/json');
    res.json({
      id: 'mock-' + Date.now().toString(36),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: reply },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage,
    });
    return;
  }

  // Streaming: emit a role chunk, then the reply in small word groups with a
  // gentle delay so the reveal animation has something to show.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const chunks = splitForStreaming(reply, 4);
  let i = 0;

  res.write(sse({ choices: [{ delta: { role: 'assistant', content: '' } }] }));

  const timer = setInterval(() => {
    if (i >= chunks.length) {
      clearInterval(timer);
      res.write(sse({ choices: [], usage }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(sse({ choices: [{ delta: { content: chunks[i] } }] }));
    i += 1;
  }, 24);

  // `res.on('close')` fires when the RESPONSE side is done (either fully sent
  // or the client aborted). Do NOT use `req.on('close')` here — that fires as
  // soon as the request body is read, which would cut the stream immediately
  // (and breaks the flow through the /proxy pipeline, where the upstream
  // request completes right after the body).
  res.on('close', () => clearInterval(timer));
}

/** Register the mock endpoints BEFORE the SPA static fallback. */
export function registerMockLlmRoutes(app: Express): void {
  app.get('/models', handleModels);
  app.get('/images/models', (_req, res) => res.json({ object: 'list', data: [] }));
  app.post('/chat/completions', handleChatCompletions);
}
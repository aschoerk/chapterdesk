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
 *   GET   /images/models      (image catalog — lists Mock Image)
 *   POST  /images             (OpenRouter-Images shape, used by fallbacks)
 *
 * TWO models are offered:
 *   - mock-writer ("Mock Writer") — text-only prose for every writing path
 *     (send/append/branch/regenerate/elaborate, titles, headings, language
 *     checks) returns 200-shaped data instead of failing.
 *   - mock-image ("Mock Image")  — an IMAGE-capable model (output modality
 *     image) that returns a small deterministic inline-SVG picture. The
 *     picture is CONTENT-TRIGGERED: its colour and caption change with the
 *     prompt text, so different scenes/prompts visibly produce different
 *     pictures. Explicit "mock:…" markers in the prompt let a tester force
 *     the partial / refused / per-scene-fallback / error outcomes (see
 *     `mockImageTrigger`). No external calls.
 */

export const MOCK_MODEL_ID = 'mock-writer';
export const MOCK_MODEL_NAME = 'Mock Writer';

export const MOCK_IMAGE_MODEL_ID = 'mock-image';
export const MOCK_IMAGE_MODEL_NAME = 'Mock Image';

/** Small deterministic palette — the mock picture picks a colour by keyword. */
const IMAGE_PALETTE: Record<string, string> = {
  sea: '#1d6b9e', ocean: '#16608f', water: '#2a7bb8', harbour: '#3a6ea5',
  fire: '#c2471d', burn: '#b03a1a', sunset: '#cf5d2b', dawn: '#e08b4a',
  night: '#26324d', dark: '#232a3c', shadow: '#2b2b33', moon: '#3d4a6b',
  forest: '#2e6b35', green: '#3f7d44', garden: '#4f8a4a',
  snow: '#7fa8c9', winter: '#6f9cc0', ice: '#89b6d9', mist: '#8faabe',
  castle: '#6a6f78', stone: '#77706a', tower: '#6f6a63',
  gold: '#c08a1e', desert: '#c29a5a', sand: '#cbb07a',
  rose: '#b03a5e', red: '#a6352f',
  letter: '#9a8c6a', paper: '#c7bfa6', lamp: '#c08a3a', light: '#d6b95a',
  storm: '#46546f', rain: '#4a6b86', wind: '#5d7d94',
};

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
  return JSON.stringify([
    'Please keep the old lighthouse open through winter.',
    'Please keep the old lighthouse open throughout the winter.',
    'Please ensure that the old lighthouse remains open during the winter season.',
  ]);
}

type MockTask = 'language-check' | 'chapter-descriptions' | 'title' | 'overview' | 'heading' | 'writing';

function identifyTask(prompt: string): MockTask {
  if (/exactly\s+3\s+variants[\s\S]*corrected direction|json array of exactly 3 strings[\s\S]*minimal, clearer, rewritten/i.test(prompt)) {
    return 'language-check';
  }
  if (/plan a list of chapter headings and descriptions|chapter description list|number of chapters to plan/i.test(prompt)) {
    return 'chapter-descriptions';
  }
  if (/generate a concise title for this story|generate a title for this story|story title/i.test(prompt)) {
    return 'title';
  }
  if (/write an engaging introduction to this story|introduction \/ overview|story overview/i.test(prompt)) {
    return 'overview';
  }
  if (/generate a concise chapter or section heading|generate the heading for the last chapter only|chapter heading/i.test(prompt)) {
    return 'heading';
  }
  return 'writing';
}

function sectionContext(prompt: string, label: string): string {
  const start = prompt.indexOf(label.replace(/:?$/, ':'));
  if (start < 0) return prompt;
  const markerLength = label.replace(/:?$/, ':').length;
  return prompt.slice(start + markerLength).split(/\n\nReturn only/i)[0].trim();
}

function mockOverview(context: string): string {
  const phrases = keyPhrases(context);
  if (phrases.length === 0) {
    return 'In a quiet place on the edge of change, an ordinary discovery draws its keeper into a story of difficult choices, unexpected allies, and the courage to begin again.';
  }
  const [subject, second, third] = phrases;
  return `When ${subject} unsettles an otherwise familiar life, a search for answers leads toward ${second ?? 'an unexpected discovery'}. As ${third ?? 'old certainties'} give way to new choices, the story follows the people who must decide what they are willing to protect.`;
}

function mockHeading(context: string): string {
  const phrases = keyPhrases(context);
  if (phrases.length === 0) return 'The Turning Point';
  return `${capitalize(phrases[0])} and the ${capitalize(phrases[1] ?? 'Hidden Truth')}`;
}

function mockChapterDescriptions(prompt: string): string {
  const count = Math.min(Math.max(extractInt(prompt.match(/Number of chapters to plan:\s*(\d+)/i)?.[1] ?? '') ?? 3, 1), 12);
  const first = extractInt(prompt.match(/First chapter number:\s*(\d+)/i)?.[1] ?? '') ?? 1;
  const goal = sectionContext(prompt, 'What the chapters are meant to achieve:');
  const topic = keyPhrases(goal || prompt).slice(0, 2).map(capitalize).join(' and ') || 'The Unfinished Journey';
  return Array.from({ length: count }, (_, index) => {
    const number = first + index;
    const heading = index === 0 ? `The ${topic}` : index === count - 1 ? 'A Choice That Changes Everything' : `What the ${topic} Reveals`;
    const description = index === 0
      ? `The story establishes ${topic.toLowerCase()} and introduces the problem that will drive the next stage.`
      : index === count - 1
        ? 'The characters act on what they have learned, face the central consequence, and move toward the stated goal.'
        : 'A new complication tests the characters’ assumptions and reveals a useful clue about the path ahead.';
    return `${number}. ${heading} — ${description}`;
  }).join('\n');
}

function mockLanguageVariants(prompt: string): string {
  const original = sectionContext(prompt, 'Original direction:') || 'Please continue the story from here.';
  const minimal = original.trim();
  const clearer = minimal.replace(/\s+/g, ' ').replace(/\bi\b/g, 'I');
  const rewritten = `Continue the story by following this direction: ${clearer.replace(/[.!?]+$/, '')}.`;
  return JSON.stringify([minimal, clearer, rewritten]);
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

// ---------------------------------------------------------------------------
// Mock IMAGE model — a tiny deterministic picture.
// ---------------------------------------------------------------------------

/** The 1-based scene number a prompt asks for ("picture 2 of 3") — 0 when none. */
function perSceneIndex(prompt: string): number {
  const m = prompt.match(/\bpicture\s+(\d+)\s+of\s+(\d+)\b/i);
  return m ? Number(m[1]) : 0;
}

/**
 * How many pictures a single render prompt asks for. The app embeds the
 * storyboard total in the one-shot/pure render prompts ("EXACTLY N pictures",
 * "Render ALL N pictures"); a per-scene storyboard render asks ONE picture
 * even though it says "of N".
 */
function requestedPictureCount(prompt: string): number {
  if (perSceneIndex(prompt) > 0) return 1;
  const explicit =
    prompt.match(/EXACTLY\s+(\d+)\s+pictures?/i)
    ?? prompt.match(/\bcreate\s+(\d+)\s+pictures?/i)
    ?? prompt.match(/\bRender\s+ALL\s+(\d+)\s+pictures?/i)
    ?? prompt.match(/\bALL\s+(\d+)\s+pictures?/i);
  if (explicit) {
    const n = Number(explicit[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  }
  return 1;
}

/** Hex colour implied by the prompt (keyword palette), or null. */
function keywordColorHex(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  for (const [word, color] of Object.entries(IMAGE_PALETTE)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return color;
  }
  return null;
}

/** Distinct image hue implied by the prompt (keyword palette or prompt hash). */
function imageHue(prompt: string): number {
  const color = keywordColorHex(prompt);
  return color ? hash(color) % 360 : hash(prompt) % 360;
}

/** Caption shown on the mock picture (the first meaningful keyword). */
function imageCaption(prompt: string): string {
  const phrases = keyPhrases(prompt);
  return phrases[0] ? capitalize(phrases[0]) : 'Mock image';
}

/**
 * A tiny inline SVG "picture". Deterministic per prompt+hue+scene so the same
 * prompt always yields the same picture (consistent style across a story)
 * while different prompts/scenes yield visibly different ones.
 */
function mockImageDataUrl(prompt: string, scene: number): string {
  const hue = imageHue(prompt);
  const caption = imageCaption(prompt);
  const safe = (caption || 'mock').slice(0, 24).replace(/[<>&"']/g, '');
  const accent = `hsl(${hue}, 62%, 40%)`;
  const bg = `hsl(${(hue + 46) % 360}, 55%, 84%)`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">` +
    `<rect width="320" height="200" fill="${bg}"/>` +
    `<rect x="96" y="54" width="128" height="92" rx="8" fill="${accent}" opacity="0.92"/>` +
    `<circle cx="160" cy="100" r="34" fill="${bg}" opacity="0.85"/>` +
    `<text x="160" y="90" font-family="sans-serif" font-size="15" font-weight="bold" fill="#ffffff" text-anchor="middle">Mock</text>` +
    `<text x="160" y="110" font-family="sans-serif" font-size="12" fill="#ffffff" text-anchor="middle">image</text>` +
    `<text x="160" y="166" font-family="sans-serif" font-size="14" fill="${accent}" text-anchor="middle">${safe}</text>` +
    (scene > 1 ? `<text x="308" y="190" font-family="sans-serif" font-size="13" fill="${accent}" text-anchor="end">${scene}</text>` : '') +
    `</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** The explicit "mock:…" trigger a tester can place in the storyboard
 *  Additional rules / style / content to force a specific outcome. */
function mockImageTrigger(prompt: string): 'per-scene' | 'partial' | 'refuse' | 'error' | null {
  const m = prompt.toLowerCase().match(/mock:(per-scene|partial|refuse|error)\b/);
  return (m?.[1] as 'per-scene' | 'partial' | 'refuse' | 'error' | undefined) ?? null;
}

/**
 * The OpenAI-shaped assistant reply message for the mock image model.
 *   - default: one picture per requested count; each image's colour + caption
 *     derive from the prompt content (keyword palette / hash), and batch
 *     scenes get per-index hues so the N pictures are visibly distinct.
 *   - "mock:per-scene" on a multi-picture batch → 0 pictures (the per-scene
 *     fallback then fills every scene); single/per-scene prompts still answer 1.
 *   - "mock:partial" on a multi-picture batch → exactly 1 picture (batch is
 *     authoritative → use case stops, "only X of N" alert).
 *   - "mock:refuse" → a content-policy refusal (message.refusal), no picture.
 */
function buildMockImageMessage(prompt: string): {
  role: 'assistant';
  content: unknown;
  refusal?: string;
  finish_reason: 'stop' | 'content_filter';
} {
  const trigger = mockImageTrigger(prompt);
  if (trigger === 'refuse') {
    return {
      role: 'assistant',
      content: null,
      refusal: 'I cannot create this picture (mock content policy — "mock:refuse").',
      finish_reason: 'content_filter',
    };
  }
  const total = requestedPictureCount(prompt);
  const scene = perSceneIndex(prompt);
  let urls: string[];
  if (trigger === 'per-scene' && total > 1) {
    // The batch asks several pictures at once: pretend the model returns
    // NO picture so the per-scene fallback runs. Single / per-scene prompts
    // (which do not carry the multi-picture request) still return theirs.
    urls = [];
  } else if (trigger === 'partial' && total > 1) {
    urls = [mockImageDataUrl(`${prompt}\n#scene 1`, 1)];
  } else {
    urls = Array.from({ length: total }, (_, i) =>
      mockImageDataUrl(`${prompt}\n#scene ${i + 1}`, scene || i + 1));
  }
  return {
    role: 'assistant',
    content: urls.map((url) => ({ type: 'image_url', image_url: { url } })),
    finish_reason: 'stop',
  };
}

/** Build a reasonable assistant reply for a chat-completions request. */
export function buildChatReply(messages: unknown, model: string): string {
  const normalized = normalizeMessages(messages);
  const direction = lastMessage(normalized);
  const prompt = normalized.map(message => message.content).join('\n\n');

  if (!direction.trim()) {
    return mockProse('');
  }
  const task = identifyTask(prompt);
  if (task !== 'language-check' && task !== 'chapter-descriptions' && /json\s*array|array\s*of/i.test(direction)) {
    return mockList(direction);
  }
  switch (task) {
    case 'language-check':
      return mockLanguageVariants(direction);
    case 'chapter-descriptions':
      return mockChapterDescriptions(direction);
    case 'title':
      return mockTitle(sectionContext(direction, 'Current chat context:') || direction);
    case 'overview':
      return mockOverview(sectionContext(direction, 'Current chat context:'));
    case 'heading':
      return mockHeading(sectionContext(direction, 'Current chat context:'));
    default:
      break;
  }

  if (/(json\s*array|array\s*of|chapter descriptions|headings?)/i.test(direction)) return mockList(direction);
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

const IMAGE_CATALOG_ENTRY = {
  id: MOCK_IMAGE_MODEL_ID,
  object: 'model',
  created: 1720000001,
  owned_by: 'chapterdesk',
  name: MOCK_IMAGE_MODEL_NAME,
  context_length: 8192,
  // input text (and images, for reference-image sends) → output IMAGE
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] },
  supported_parameters: [],
};

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
    IMAGE_CATALOG_ENTRY,
  ],
};

function handleModels(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'application/json');
  res.json(CATALOG);
}

function handleImageModels(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'application/json');
  res.json({ object: 'list', data: [IMAGE_CATALOG_ENTRY] });
}

/** OpenRouter-Images shape (`{ model, prompt, n }`) used by the transport's
 *  /images fallback. The mock answers a small deterministic SVG per picture. */
function handleImages(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { model?: unknown; prompt?: unknown; n?: unknown };
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const n = Math.min(Math.max(Number(body.n) || 1, 1), 4);
  const data = Array.from({ length: n }, (_, i) => ({
    url: mockImageDataUrl(`${prompt}\n#image ${i + 1}`, i + 1),
  }));
  res.setHeader('Content-Type', 'application/json');
  res.json({ created: Math.floor(Date.now() / 1000), data });
}

function handleChatCompletions(req: Request, res: Response): void {
  const body = (req.body ?? {}) as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
  };
  const model = typeof body.model === 'string' ? body.model : MOCK_MODEL_ID;

  // ---- Mock IMAGE model: answer a small deterministic picture. ----
  const isImageModel = model === MOCK_IMAGE_MODEL_ID || model.endsWith('/' + MOCK_IMAGE_MODEL_ID);
  if (isImageModel) {
    const prompt = lastMessage(normalizeMessages(body.messages));
    if (mockImageTrigger(prompt) === 'error') {
      res.status(400).setHeader('Content-Type', 'application/json');
      res.json({ error: { message: 'mock image failure ("mock:error")' } });
      return;
    }
    const message = buildMockImageMessage(prompt);
    const usage = usageFor(body.messages, model, String((message.content as unknown[])?.length ?? 0));
    // Always answer with a plain application/json body — the Angular transport
    // already treats a JSON reply to a `stream:true` request as NON-stream
    // (image-capable WRITE-model path), and completeImage is non-stream anyway.
    res.setHeader('Content-Type', 'application/json');
    res.json({
      id: 'mock-' + Date.now().toString(36),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.finish_reason,
          logprobs: null,
        },
      ],
      usage,
    });
    return;
  }

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
  app.get('/images/models', handleImageModels);
  app.post('/images', handleImages);
  app.post('/chat/completions', handleChatCompletions);
}
import { inject, Injectable } from '@angular/core';
import { ChatMessage } from '../../../models/chat';
import { canGenerateImages, ModelEntry, type ProviderConfig } from '../../../models/chat-config';
import { getServerConfig } from '../../util/server-config';
import { normalizeProviderBaseUrl, isGoogleGeminiUrl } from '../../util/provider-url';
import { LlmLogService } from '../llm-log.service';
import { normalizeChatMessages, type MessagePart, type LlmImagePart } from '../llm-message';
import { readSseStream, type LlmChunk } from '../llm-sse';

/**
 * ONE image-generation attempt hard timeout — a provider that hangs must
 * never leave the UI stuck in "Creating…". (Same safety as the legacy path.)
 */
const TIMEOUT_MS = 120_000_000;

export interface ProviderRef {
  baseUrl: string;
  apiKey: string;
  /** Connection kind — selects the auth header scheme in `headers()`. */
  type?: ProviderConfig['type'];
}

export interface CompletionRequest {
  provider: ProviderRef;
  model: ModelEntry;
  messages: ChatMessage[];
  /** Extra request params (temperature, thinking, stream, modalities, …). */
  extras?: Record<string, unknown>;
  /** True for image-generating completions (modalities + fallbacks). */
  imageCapable?: boolean;
  /** When imageCapable, force `modalities: ['image']` (route-fallback). */
  imageOnlyModalities?: boolean;
  /** Force `modalities: ['text']` (used by image-interpret so a multimodal
   *  model must answer with text, not a generated image). */
  textOnlyModalities?: boolean;
  signal?: AbortSignal;
  /** Streaming callback — raw chunks, unpaced (pacing is a view concern). */
  onChunk?: (chunk: LlmChunk) => void;
  /** Chat attribution for the log. */
  chat?: { id?: string; title?: string; usecase?: string; nodeId?: string };
  /** Per-attempt timeout in ms (default TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface ImagesRequest {
  provider: ProviderRef;
  model: ModelEntry;
  prompt: string;
  n?: number;
  signal?: AbortSignal;
  chat?: { id?: string; title?: string; usecase?: string; nodeId?: string };
  timeoutMs?: number;
}

export interface CompletionResult {
  /** Raw JSON body (for non-stream image calls; for streams a lookalike). */
  raw?: unknown;
  /** Assembled text for streaming calls ('' when non-stream). */
  content: string;
  thinking: string;
  /** Generated images assembled from the stream (''/[] when none). */
  images?: LlmImagePart[];
  /** The provider's whole-request usage block (streamed / raw), if any. */
  usage?: unknown;
  /** The recorded LLM-log entry of this call (for node attribution). */
  logEntry?: import('../llm-log.service').LlmLogEntry;
  /**
   * True when the response was actually an SSE stream and `onChunk` fired
   * live. False when a `stream: true` request was answered with a regular
   * NON-stream JSON body (a model/endpoint that cannot stream) or when the
   * request was non-stream from the start — in that case the caller must
   * evaluate the raw JSON directly instead of finalizing folded chunks.
   */
  streamed?: boolean;
}

export interface ImagesResult {
  /** Raw OpenAI-Images JSON body. */
  raw: unknown;
}

/** Typed transport error — the evaluator turns this into slot statuses. */
export interface TransportError {
  status: number;
  text: string;
  aborted?: boolean;
}

function defaultModalities(model: ModelEntry): string[] {
  const declared = model.architecture?.output_modalities ?? [];
  return declared.includes('text') ? ['text', 'image'] : ['image'];
}

/**
 * LlmTransport — PURE transport: sends requests to the completion or images
 * endpoint, maintains the log (LlmLogService), and handles EVERY retry that
 * is a transport concern:
 *   1. `modalities` field rejected          → retry chat completion w/o it
 *   2. OpenRouter modality-route 404        → retry asking for ['image'] only
 *   3. model served ONLY on /images         → retry via the images endpoint
 *   4. context-length overflow              → retry via the images endpoint
 *
 * It knows NOTHING about use cases, slots, or the chat — that is the
 * evaluators'/orchestrator's job. It NEVER throws a generation "result": a
 * failure is thrown as a TransportError for the evaluator to slot-ify.
 */
@Injectable({ providedIn: 'root' })
export class LlmTransportService {
  private readonly llmLog = inject(LlmLogService);

  /**
   * One raw chat-completions call (stream or non-stream). Returns parsed JSON
   * for non-stream, or a `{choices:[{message:{content}}]}` lookalike for
   * stream (an evaluator-friendly shape). Throws TransportError on any
   * failure. Streaming fires `onChunk` per raw SSE chunk.
   */
  private async rawCompletion(req: CompletionRequest): Promise<CompletionResult> {
    const config = getServerConfig();
    const payloadMessages = normalizeChatMessages([...req.messages]);
    const stream = req.extras?.['stream'] !== false;
    const payload: Record<string, unknown> = {
      model: req.model.modelId,
      messages: payloadMessages,
      ...req.extras,
    };
    if (req.imageCapable) payload['modalities'] = req.imageOnlyModalities ? ['image'] : defaultModalities(req.model);
    else if (req.textOnlyModalities) payload['modalities'] = ['text'];
    payload['stream'] = stream;
    if (stream) {
      // Ask OpenAI-compatible providers to emit a final chunk carrying the
      // whole-request usage block (tokens + cost) BEFORE [DONE], so streamed
      // calls show usage in the log too. A caller-provided stream_options
      // (e.g. to opt out) wins over this default.
      payload['stream_options'] = req.extras?.['stream_options'] ?? { include_usage: true };
    }

    const logEntry = this.llmLog.record({
      kind: 'chat',
      modelId: req.model.modelId,
      provider: req.provider.baseUrl,
      chatId: req.chat?.id,
      chatTitle: req.chat?.title,
      nodeId: req.chat?.nodeId,
      usecase: req.chat?.usecase,
      endpoint: 'chat/completions',
      messages: payloadMessages.map(m => ({ role: m.role, content: m.content })),
      body: payload,
      extras: { ...(req.extras ?? {}), ...(req.imageCapable ? { modalities: payload['modalities'] } : {}) }
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const response = await fetch(`${config.proxyBase}/chat/completions`, {
        method: 'POST',
        headers: this.headers(req.provider),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        this.llmLog.complete(logEntry, { error: { status: response.status, text } });
        throw { status: response.status, text, aborted: controller.signal.aborted } as TransportError;
      }

      if (stream) {
        // A provider may ignore `stream: true` (a model/endpoint that cannot
        // stream) and answer with a regular `application/json` body instead
        // of an SSE stream. Detect that via the content-type and handle the
        // body as a NON-stream response — the full text / thinking / images
        // are already in the JSON, and the caller evaluates it directly.
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        // A plain `application/json` body in reply to a `stream: true` request
        // means the endpoint cannot stream and answered with the full response
        // (text/thinking/images already complete). Treat it as NON-stream.
        const isPlainJson = /application\/json/i.test(contentType) && !/event-stream/i.test(contentType);
        if (isPlainJson) {
          const raw = await response.json();
          this.llmLog.complete(logEntry, { response: raw });
          const usage = (raw as Record<string, unknown>)['usage'];
          return { content: '', thinking: '', raw, usage, logEntry, streamed: false };
        }
        // Only the STREAMING path needs a readable body.
        if (!response.body) {
          const err: TransportError = { status: 0, text: 'No response body', aborted: controller.signal.aborted };
          this.llmLog.complete(logEntry, { error: { status: 0, text: err.text } });
          throw err;
        }
        const assembled = await readSseStream(response.body, req.onChunk).then(r => ({
          content: r.content.trim(),
          thinking: r.thinking.trim(),
          images: r.images,
          usage: r.usage
        }));
        // The log must show what the model actually returned — including any
        // generated images an image-capable model streamed back, and the
        // provider's final usage block (OpenAI include_usage) when present.
        this.llmLog.complete(logEntry, {
          response: {
            content: assembled.content,
            thinking: assembled.thinking,
            ...(assembled.images.length ? { images: assembled.images } : {}),
            ...(assembled.usage ? { usage: assembled.usage } : {})
          }
        });
        const raw = {
          choices: [{
            message: {
              role: 'assistant',
              content: assembled.content,
              ...(assembled.images.length ? { images: assembled.images } : {})
            }
          }]
        };
        return {
          content: assembled.content, thinking: assembled.thinking, images: assembled.images,
          raw, usage: assembled.usage, logEntry, streamed: true
        };
      }

      const raw = await response.json();
      this.llmLog.complete(logEntry, { response: raw });
      const usage = (raw as Record<string, unknown>)['usage'];
      return { content: '', thinking: '', raw, usage, logEntry, streamed: false };
    } catch (err: any) {
      if ((err as TransportError).status !== undefined) throw err;
      const aborting = controller.signal.aborted;
      const tErr: TransportError = {
        status: 0,
        text: aborting
          ? (req.signal?.aborted ? 'aborted' : `timed out after ${(req.timeoutMs ?? TIMEOUT_MS) / 1000}s`)
          : String(err?.message ?? err),
        aborted: aborting
      };
      if (!logEntry.completed) {
        this.llmLog.complete(logEntry, { error: { status: 0, text: tErr.text } });
      }
      throw tErr;
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * One IMAGE-capable completion attempt WITH the graceful fallback tree.
   * Returns the full CompletionResult (raw + usage + logEntry) so the caller
   * can attribute tokens/cost to the answer node. The /images-endpoint
   * fallback reports no usage block — it is logged but contributes nothing.
   */
  private async imageCallOnce(req: CompletionRequest): Promise<CompletionResult> {
    const run = (r: CompletionRequest): Promise<CompletionResult> => this.rawCompletion(r);
    try {
      return await run({ ...req, imageCapable: true });
    } catch (err: any) {
      const tErr = err as TransportError;
      const msg = String(tErr?.text ?? err?.message ?? err);

      // 1. Some providers reject the modalities field → retry once without it.
      if (/modalities/i.test(msg) && /unsupported|invalid|parameter|recognized|unknown/i.test(msg)) {
        return await run({ ...req, imageCapable: false });
      }
      // 2. OpenRouter route filter: asked text+image but only image is served.
      const wantsText = !!(req.model.architecture?.output_modalities ?? []).includes('text');
      if (wantsText && /No endpoints found that support the requested output modalit/i.test(msg)) {
        return await run({ ...req, imageOnlyModalities: true });
      }
      // 3. Model served ONLY on /images; 4. context overflow.
      if (this.shouldRouteToImages(msg)) {
        const prompt = lastUserPromptText(req.messages);
        if (prompt.trim()) {
          const routed = await this.images({
            provider: req.provider,
            model: req.model,
            prompt,
            signal: req.signal,
            chat: req.chat,
            timeoutMs: req.timeoutMs
          });
          return { raw: routed.raw, content: '', thinking: '', streamed: false };
        }
      }
      throw tErr;
    }
  }

  /**
   * IMAGE-GENERATING chat completion (single image / en-block / per-scene):
   * request body with modalities + the transport fallback tree. Returns the
   * raw JSON body so the evaluator can extract images.
   */
  async completeImage(req: Omit<CompletionRequest, 'imageCapable'>): Promise<unknown> {
    return (
      await this.imageCallOnce({
        ...req,
        imageCapable: true,
        extras: { ...req.extras, stream: false }
      })
    ).raw;
  }

  /**
   * Plain chat completion (text use cases + the planning pass). Streams when
   * `req.extras.stream` is not false, firing `onChunk` live. Returns a
   * CompletionResult (raw + assembled text/thinking).
   *
   * When `req.imageCapable` is set (an image-GENERATION model used as the
   * WRITING model of an answer flow), it is the image-capable completion with
   * `modalities` + the full fallback tree (`imageCallOnce`): a provider that
   * refuses chat completions routes to `/images`; a provider that cannot
   * stream routes through the non-stream retry. This is what lets send-* /
   * append produce a picture from an image model instead of an empty 200.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (req.imageCapable) {
      try {
        // Keep the raw JSON + the provider's usage/log entry so an
        // image-capable WRITE-model answer still gets its tokens/cost
        // attributed (the raw lookalike carries the assembled text).
        const result = await this.imageCallOnce({ ...req, imageCapable: true });
        return { ...result, content: '', thinking: '', streamed: false };
      } catch (err: any) {
        const tErr = err as TransportError;
        const msg = String(tErr?.text ?? err?.message ?? err);
        if (tErr?.aborted) throw err;
        // A provider that cannot stream may reject `stream: true`; retry once
        // without streaming (still image-capable → fallback tree applies).
        const wantsStream = (req.extras?.['stream'] ?? true) !== false;
        if (wantsStream && isStreamingUnsupported(msg)) {
          return this.complete({ ...req, extras: { ...req.extras, stream: false } });
        }
        throw err;
      }
    }

    try {
      return await this.rawCompletion({ ...req, imageCapable: false });
    } catch (err: any) {
      const tErr = err as TransportError;
      const msg = String(tErr?.text ?? err?.message ?? err);
      if (!tErr || tErr.aborted) throw err;

      // An image-GENERATION model used as a WRITING model (send-branch /
      // send-rewrite / append) is served ONLY on the /images endpoint and
      // rejects chat completions outright. Route to /images with the last
      // user prompt so the flow still gets the generated image(s) to attach
      // to the assistant node.
      if (isImagesEndpointHint(msg)) {
        const prompt = lastUserPromptText(req.messages);
        if (prompt.trim()) {
          const routed = await this.images({
            provider: req.provider,
            model: req.model,
            prompt,
            signal: req.signal,
            chat: req.chat,
            timeoutMs: req.timeoutMs
          });
          return { raw: routed.raw, content: '', thinking: '', streamed: false };
        }
      }

      // A model/endpoint that cannot stream may REJECT `stream: true` with a
      // provider error instead of ignoring it. Retry ONCE without streaming —
      // the raw body is then a complete JSON response evaluated as such. The
      // retry goes through complete() again so it also benefits from the
      // /images routing above.
      const wantsStream = (req.extras?.['stream'] ?? true) !== false;
      if (wantsStream && isStreamingUnsupported(msg)) {
        return this.complete({ ...req, extras: { ...req.extras, stream: false } });
      }
      throw err;
    }
  }

  /** OpenRouter-Images endpoint: `{ model, prompt, n }`. Returns raw JSON. */
  async images(req: ImagesRequest): Promise<ImagesResult> {
    const config = getServerConfig();
    const payload = {
      model: req.model.modelId,
      prompt: req.prompt,
      ...(req.n && req.n > 1 ? { n: req.n } : {})
    };
    const logEntry = this.llmLog.record({
      kind: 'image',
      modelId: req.model.modelId,
      provider: req.provider.baseUrl,
      chatId: req.chat?.id,
      chatTitle: req.chat?.title,
      nodeId: req.chat?.nodeId,
      usecase: req.chat?.usecase,
      endpoint: 'images',
      prompt: req.prompt,
      body: payload,
      extras: req.n && req.n > 1 ? { n: req.n } : {}
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const response = await fetch(`${config.proxyBase}/images`, {
        method: 'POST',
        headers: this.headers(req.provider),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        this.llmLog.complete(logEntry, { error: { status: response.status, text } });
        throw { status: response.status, text, aborted: controller.signal.aborted } as TransportError;
      }
      const raw = await response.json();
      this.llmLog.complete(logEntry, { response: raw });
      return { raw };
    } catch (err: any) {
      if ((err as TransportError).status !== undefined) throw err;
      const aborting = controller.signal.aborted;
      const tErr: TransportError = {
        status: 0,
        text: aborting
          ? (req.signal?.aborted ? 'aborted' : `timed out after ${(req.timeoutMs ?? TIMEOUT_MS) / 1000}s`)
          : String(err?.message ?? err),
        aborted: aborting
      };
      if (!logEntry.completed) {
        this.llmLog.complete(logEntry, { error: { status: 0, text: tErr.text } });
      }
      throw tErr;
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', forwardAbort);
    }
  }

  private headers(provider: ProviderRef): Record<string, string> {
    const effectiveType = provider.type === 'gemini' || isGoogleGeminiUrl(provider.baseUrl)
      ? 'gemini'
      : provider.type ?? 'custom';
    const base = {
      'Content-Type': 'application/json',
      'x-target-base': normalizeProviderBaseUrl(effectiveType, provider.baseUrl),
      'HTTP-Referer': 'https://chat-client.local',
      'X-Title': 'ChapterDesk'
    };
    switch (effectiveType) {
      case 'gemini':
        return { ...base, 'x-goog-api-key': provider.apiKey };
      case 'anthropic':
        return { ...base, 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' };
      default:
        return { ...base, Authorization: `Bearer ${provider.apiKey}` };
    }
  }

  private shouldRouteToImages(text: string): boolean {
    return (
      /cannot be used with the chat\/completions endpoint|use the \/api\/v1\/images endpoint|images endpoint instead/i.test(text)
      || /maximum context length|context length is|reduce the length|requested about \d+ tokens|too many tokens/i.test(text)
    );
  }
}

/**
 * True when a provider error text means the model is an image-GENERATION
 * model served only via the images endpoint (not chat completions) — the text
 * path then routes to `/images` with the last user prompt. Deliberately
 * narrower than `shouldRouteToImages` (which also matches context overflow):
 * routing a plain TEXT completion to /images is only right when the provider
 * itself tells us the model lives on that endpoint.
 */
export function isImagesEndpointHint(text: string): boolean {
  return (
    /cannot be used with the chat\/completions endpoint|use the \/api\/v1\/images endpoint|images endpoint instead/i.test(text)
  );
}

/**
 * True when a provider error text means the model/endpoint rejected
 * `stream: true` (it cannot stream) — used to retry once without streaming.
 */
export function isStreamingUnsupported(text: string): boolean {
  return (
    /stream/i.test(text) &&
    /not support|unsupported|does not|cannot|can't|disabled|invalid|not allowed|unavailable|not available|not permitted|not enabled/i.test(text)
  );
}

/** The exact last user-prompt text (used to record exact prompts). */
export function lastUserPromptText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = (m.content as MessagePart[])
        .filter(p => p.type === 'text' && p.text)
        .map(p => (p as { text: string }).text)
        .join('\n\n');
      if (text.trim()) return text;
    }
  }
  return '';
}

export const canExtractImage = canGenerateImages;
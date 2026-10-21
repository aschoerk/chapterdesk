import { inject, Injectable } from '@angular/core';
import type { LlmChunk } from '../llm-sse';
import { evaluateCompletion, evaluateDescriptions, evaluateImagesResponse, foldStreamChunk, finalizeStream } from './evaluators';
import { LlmTransportService, type CompletionRequest, type CompletionResult, type ProviderRef } from './transport';
import { refusedSlot, okSlot } from './slots';
import { parseProviderUsage } from '../usage';
import type { ChatMessage } from '../../../models/chat';
import type { ModelEntry } from '../../../models/chat-config';
import type { EvalSlots, LlmImagePart, UsecaseContext } from './types';

/** One primitive request (a sub-slice of a RequestIntent). */
export interface PrimitiveRequest {
  readonly model: ModelEntry;
  readonly provider: ProviderRef;
  readonly messages: ChatMessage[];
  readonly extras?: Record<string, unknown>;
  readonly stream?: boolean;
  /** True when the model can ALSO generate images (the transport then adds
   *  `modalities` and, on failure, runs the images-endpoint fallback tree).
   *  Used by ANSWER-SENDING flows whose write model is an image model — a
   *  request without `modalities` may come back 200 with empty content. */
  readonly imageCapable?: boolean;
  /** Force `modalities: ['text']` on the request (image-interpret). */
  readonly textOnlyModalities?: boolean;
}

/** What one primitive call needs besides the transport request. */
export interface PrimitiveOptions {
  /** Expected slot kind, decides which evaluator runs. */
  expect: 'text' | 'images' | 'descriptions';
  /** The exact prompt sent (kept as provenance on image slots). */
  prompt?: string;
  /** 1-based scene number (kept as provenance on slots). */
  scene?: number;
  /** Streaming callback — raw chunks get folded into partial slots. */
  onChunk?: (chunk: LlmChunk) => void;
  /** Caller signal (abort propagates to the whole tree). */
  signal?: AbortSignal;
  /** Node the call's output belongs to (e.g. the assistant answer node being
   *  streamed into). Falls back to the context node when unset. */
  nodeId?: string;
}

/** Attach usage + log reference to the returned slots (best effort). */
function attachUsageSlots(slots: EvalSlots, result: CompletionResult): EvalSlots {
  const usage = parseProviderUsage(result.usage);
  if (usage) slots.usage = okSlot(usage, {});
  if (result.logEntry) slots.logEntry = result.logEntry;
  return slots;
}

/**
 * LlmOrchestrator — the SHARED PRIMITIVES class. It has NO use-case logic
 * (no storyboard branches, no fallback decisions). It exposes two low-level
 * operations—`completion()` and `images()`—that call the transport and turn
 * the outcome into EvalSlots. Use cases (plain async functions) use these to
 * script their flow; they read the slots to decide continuations.
 */
@Injectable({ providedIn: 'root' })
export class LlmOrchestratorService {
  private readonly transport = inject(LlmTransportService);

  /** Chat attribution slice for the log (incl. the orchestration use case). */
  private chatRef(
    cx: Pick<UsecaseContext, 'chat'> & Partial<Pick<UsecaseContext, 'usecase' | 'nodeId' | 'node'>>,
    nodeId?: string
  ): { id: string; title: string | undefined; usecase: string | undefined; nodeId: string | undefined } | undefined {
    return cx?.chat
      ? {
          id: cx.chat.id,
          title: cx.chat.title,
          usecase: cx.usecase,
          nodeId: nodeId ?? cx.nodeId ?? cx.node?.id
        }
      : undefined;
  }

  /**
   * One chat-completion call (text use cases + the planning pass).
   * For streaming (`expect: 'text'`) folds chunks into partial slots and
   * finalizes them; for non-stream fills text/images/descriptions from the
   * raw JSON. NEVER throws a generation result — failures become slots.
   */
  async completion(
    cx: Pick<UsecaseContext, 'chat'> & Partial<Pick<UsecaseContext, 'usecase' | 'nodeId' | 'node'>>,
    req: PrimitiveRequest,
    opts: PrimitiveOptions
  ): Promise<EvalSlots> {
    const runReq: CompletionRequest = {
      provider: req.provider,
      model: req.model,
      messages: req.messages,
      extras: { ...(req.extras ?? {}), stream: req.stream ?? false },
      imageCapable: req.imageCapable ?? false,
      textOnlyModalities: req.textOnlyModalities ?? false,
      onChunk: opts.onChunk,
      signal: opts.signal,
      chat: this.chatRef(cx, opts.nodeId)
    };

    if (opts.expect === 'text' && (req.stream !== false)) {
      // Streaming: fold chunks, then finalize.
      let running: EvalSlots = {};
      const result: CompletionResult = await this.transport.complete({
        ...runReq,
        onChunk: chunk => {
          running = foldStreamChunk(running, chunk);
          opts.onChunk?.(chunk);
        }
      });
      // When the endpoint could not stream and the transport fell back to a
      // NON-stream JSON body (`streamed === false`), the raw body ALREADY
      // holds the complete text/thinking/images — evaluate it directly. The
      // folded partial stream is empty (no SSE chunks ever arrived), so
      // finalizeStream would only refuse the answer and DROP the content
      // (including an image-only response).
      if (result.streamed === false) {
        return attachUsageSlots(evaluateCompletion({ raw: result.raw, prompt: opts.prompt, scene: opts.scene }), result);
      }
      return attachUsageSlots(finalizeStream(running, { raw: result.raw, prompt: opts.prompt, scene: opts.scene }), result);
    }

    const result = await this.transport.complete(runReq);
    if (opts.expect === 'text') {
      // Non-streaming text completion (e.g. the image-interpret step): the
      // response body already holds the full text — evaluate it directly
      // (finalizeStream only settles an already-folded partial stream).
      return attachUsageSlots(evaluateCompletion({ raw: result.raw, prompt: opts.prompt, scene: opts.scene }), result);
    }
    if (opts.expect === 'descriptions') {
      return attachUsageSlots(evaluateDescriptions({ raw: result.raw, prompt: opts.prompt, scene: opts.scene }), result);
    }
    return attachUsageSlots(evaluateCompletion({ raw: result.raw, prompt: opts.prompt, scene: opts.scene }), result);
  }

  /**
   * One IMAGE-GENERATING completion call (single image / en-block / per
   * scene). Picks the images-vs-text evaluator by `expect`. NEVER throws —
   * failures become `images` refused / `error` slots.
   */
  async completeImage(
    cx: Pick<UsecaseContext, 'chat'> & Partial<Pick<UsecaseContext, 'usecase' | 'nodeId' | 'node'>>,
    req: PrimitiveRequest,
    opts: PrimitiveOptions
  ): Promise<EvalSlots> {
    const runReq: CompletionRequest = {
      provider: req.provider,
      model: req.model,
      messages: req.messages,
      extras: req.extras,
      signal: opts.signal,
      chat: this.chatRef(cx, opts.nodeId)
    };
    try {
      const raw = await this.transport.completeImage(runReq);
      if (opts.expect === 'images') {
        return evaluateImagesResponse({ raw, prompt: opts.prompt, scene: opts.scene });
      }
      return evaluateCompletion({ raw, prompt: opts.prompt, scene: opts.scene });
    } catch (err: any) {
      return {
        images: refusedSlot<LlmImagePart[]>(String(err?.text ?? err?.message ?? err), { prompt: opts.prompt, scene: opts.scene })
      };
    }
  }

  /**
   * One OpenRouter-Images endpoint call. Same slot contract.
   */
  async images(
    cx: Pick<UsecaseContext, 'chat'> & Partial<Pick<UsecaseContext, 'usecase' | 'nodeId' | 'node'>>,
    req: { model: ModelEntry; provider: ProviderRef; prompt: string; n?: number },
    opts: PrimitiveOptions
  ): Promise<EvalSlots> {
    try {
      const raw = await this.transport.images({
        provider: req.provider,
        model: req.model,
        prompt: req.prompt,
        n: req.n,
        signal: opts.signal,
        chat: this.chatRef(cx, opts.nodeId)
      });
      return evaluateImagesResponse({ raw: raw.raw, prompt: req.prompt, scene: opts.scene });
    } catch (err: any) {
      return {
        images: refusedSlot<LlmImagePart[]>(String(err?.text ?? err?.message ?? err), { prompt: req.prompt, scene: opts.scene })
      };
    }
  }
}
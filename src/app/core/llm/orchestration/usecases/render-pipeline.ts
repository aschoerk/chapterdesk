import type { ChatMessage, NodeAttachment } from '../../../../models/chat';
import type { EvalSlots, ImageScene, LlmImagePart } from '../types';
import { isImageMime, resolvedMime, type MessagePart } from '../../llm-message';
import { makeSlot } from '../slots';
import type { UsecaseEnv } from './env';

/**
 * The `image_url` message parts of the reference images the user attached in
 * the dialog (`vars.attachments`). Only data: URLs are forwarded — http(s)
 * URLs are never shipped as binaries. Empty when nothing was attached.
 */
export function referenceImageParts(attachments: NodeAttachment[] | undefined | null): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const a of attachments ?? []) {
    if (isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:') && a.dataUrl.includes(',')) {
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    }
  }
  return parts;
}

/**
 * Build the single user message for an image render call: the prompt text,
 * plus any reference images the user attached in the dialog (`vars.attachments`)
 * as `image_url` parts. Prior illustrations / hand-attached chat images are
 * deliberately NOT auto-forwarded — only the images the user explicitly chose
 * as references reach the image model.
 */
export function renderMessages(env: UsecaseEnv, prompt: string): ChatMessage[] {
  const refs = referenceImageParts(env.cx.vars.attachments);
  if (refs.length === 0) return [{ role: 'user', content: prompt }];
  return [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      ...refs
    ]
  }];
}

/**
 * One image-model request. The prompt is sent as a single user message —
 * TEXT plus any user-chosen reference images (see `renderMessages`); optionally
 * a text-only `prefix` (chat context) is prepended.
 */
export async function renderImage(
  env: UsecaseEnv,
  prompt: string,
  opts: { prefix?: ChatMessage[]; scene?: number } = {}
): Promise<EvalSlots> {
  return env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages: [...(opts.prefix ?? []), ...renderMessages(env, prompt)],
    extras: env.imageExtras
  }, { expect: 'images', prompt, scene: opts.scene, signal: env.signal });
}

/** Complete batch result: ONE scene record holding ALL images under the batch prompt. */
export function completeStoryboard(batchPrompt: string, images: LlmImagePart[]): ImageScene[] {
  return [{ scene: 1, prompt: batchPrompt, images, refused: false }];
}

/** Aggregated outcome of a multi-picture render attempt. */
interface StoryboardRender {
  images: LlmImagePart[];
  scenes: ImageScene[];
  /** First refusal / failure reason (kept findable on refused scenes). */
  content: string;
}

/** Progressive snapshot of the per-scene fallback: the scenes 1..attempted
 *  (each with its own prompt + the image produced so far, or a refused record
 *  when the model returned none). Scenes that were not attempted yet are NOT
 *  included, so a caller can attach each picture the moment it is ready. */
export function fallbackSceneSnapshot(
  perScene: (LlmImagePart | null)[],
  count: number,
  attempted: number,
  scenePrompt: (i: number) => string,
  content: string
): ImageScene[] {
  const out: ImageScene[] = [];
  for (let i = 0; i < Math.min(attempted, count); i++) {
    const img = perScene[i];
    out.push({
      scene: i + 1,
      prompt: scenePrompt(i),
      images: img ? [img] : [],
      content: img ? undefined : (content || undefined),
      refused: !img
    });
  }
  return out;
}

/**
 * Multi-picture render with PER-PICTURE FALLBACK + REPRISE. Used by the three
 * use cases that can produce several pictures from ONE image-model call
 * (`storyboard-direct`, `planned-enblock`, `planned-scenes`):
 *
 *  1. Try the BATCH call for all `count` pictures — text only.
 *  2. If it returns fewer than `count`, render each MISSING picture
 *     individually (per-scene prompts, text only — each sends ONLY that
 *     scene's own description).
 *  3. If a picture is STILL missing, run ONE final "consistency" batch
 *     attempt — but ONLY when MORE THAN ONE picture was already rendered
 *     (a single image gives too little style context to re-render against).
 *     Its prompt is built by `reprisePromptFor(successful, missing)` with the
 *     DEFAULT render prompt builder, embedding ONLY the successfully rendered
 *     descriptions and using their REAL count as `total`. A `null` return
 *     skips the reprise entirely. When it yields `>= count` pictures the
 *     whole set is replaced; otherwise each returned image is merged into a
 *     still-missing slot.
 */
export async function renderBatchWithFallback(
  env: UsecaseEnv,
  count: number,
  batchPrompt: string,
  scenePrompt: (i: number) => string,
  prefix: ChatMessage[] = [],
  reprisePromptFor?: (successful: number[], missing: number[]) => string | null
): Promise<StoryboardRender> {
  // 1. Batch attempt (text only).
  const first = await renderImage(env, batchPrompt, { prefix });
  const firstImages = first.images?.value ?? [];
  let content = first.images?.reason ?? '';
  if (env.signal?.aborted) {
    return {
      images: firstImages,
      content,
      scenes: firstImages.length ? completeStoryboard(batchPrompt, firstImages) : []
    };
  }
  if (firstImages.length > 0) {
    return { images: firstImages, content, scenes: completeStoryboard(batchPrompt, firstImages) };
  }

  // 2. Per-picture fallback: render each MISSING scene individually, sending
  //    ONLY that scene's own description (never the whole list again).
  const perScene: (LlmImagePart | null)[] = [];
  for (let i = 0; i < count; i++) {
    if (i < firstImages.length) { perScene.push(firstImages[i]); continue; }
    const slots = await renderImage(env, scenePrompt(i), { prefix, scene: i + 1 });
    if (slots.images?.reason && !content) content = slots.images.reason;
    perScene.push((slots.images?.value ?? [])[0] ?? null);
    // The scene is ready the moment its render call resolves (image or
    // refused) — surface it immediately so a caller can attach it now.
    env.onImages?.(fallbackSceneSnapshot(perScene, count, i + 1, scenePrompt, content));
    if (env.signal?.aborted) break;
  }

  const successful: number[] = [];
  const missing: number[] = [];
  for (let i = 0; i < perScene.length; i++) {
    (perScene[i] ? successful : missing).push(i);
  }

  // 3. Final "consistency" batch: it embeds ONLY the SUCCESSFULLY rendered
  //    descriptions and re-renders the FULL `count` set, so the missing
  //    pictures are completed consistently with the ones that worked.
  if (missing.length > 0 && !env.signal?.aborted) {
    // Decide the reprise prompt. A `null` from the builder means "skip the
    // reprise entirely" (e.g. not enough successful pictures); without a
    // builder (storyboard-direct) the original batch prompt is re-run.
    const reprisePrompt = reprisePromptFor
      ? reprisePromptFor(successful, missing)
      : batchPrompt;
    if (reprisePrompt) {
      const reprise = await renderImage(env, reprisePrompt, { prefix });
      if (reprise.images?.reason && !content) content = reprise.images.reason;
      const repriseImages = reprise.images?.value ?? [];
      if (repriseImages.length >= count) {
        // The re-rendered whole set is consistent → replace everything.
        return { images: repriseImages, content, scenes: completeStoryboard(reprisePrompt, repriseImages) };
      }
      if (repriseImages.length > 0) {
        // Partial reprise → merge into the still-missing slots.
        let j = 0;
        for (const idx of missing) {
          if (j >= repriseImages.length) break;
          perScene[idx] = repriseImages[j++];
        }
      }
    }
  }

  const scenes: ImageScene[] = [];
  const finalCollected: LlmImagePart[] = [];
  for (let i = 0; i < count; i++) {
    const img = perScene[i];
    if (img) finalCollected.push(img);
    scenes.push({
      scene: i + 1,
      prompt: scenePrompt(i),
      images: img ? [img] : [],
      content: img ? undefined : (content || undefined),
      refused: !img
    });
  }
  return { images: finalCollected, content, scenes };
}

/** Wrap a single/en-block image result as a one-scene storyboard slot. */
export function wrapImagesAsStoryboard(
  slots: EvalSlots,
  prompt: string,
  count: number
): EvalSlots {
  const images = slots.images?.value ?? [];
  const refused = slots.images?.status === 'refused' || images.length === 0;
  const reason = slots.images?.reason;
  const scenes: ImageScene[] = count > 1
    ? Array.from({ length: count }, (_, i) => ({
        scene: i + 1,
        prompt,
        images: (i === 0 ? images : []),
        content: reason ?? (refused ? undefined : undefined),
        refused: i === 0 ? refused : refused
      }))
    : [{
        scene: 1,
        prompt,
        images,
        content: reason ?? undefined,
        refused
      }];
  return {
    ...slots,
    storyboard: makeSlot('ok', scenes, undefined, {})
  };
}
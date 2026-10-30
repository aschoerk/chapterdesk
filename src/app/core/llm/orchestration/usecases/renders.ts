import type { ChatMessage } from '../../../../models/chat';
import type { EvalSlots } from '../types';
import { renderMessages, referenceImageParts, wrapImagesAsStoryboard } from './render-pipeline';
import type { UsecaseEnv } from './env';

// ---------------------------------------------------------------------------
// 4. render-full — no storyboard, current node + FULL chat context (text only)
// 5. render-window — no storyboard, current node + a bounded WINDOW of the
//    last `historyNodes` beats (text only). Both deliver the same shape: the
//    pre-computed context messages (full or windowed — chosen by the runner)
//    plus the anchor (current node text) as the scene to render. The image
//    model only ever receives TEXT: the context is stripped to text and no
//    reference/attachment images are forwarded.
// ---------------------------------------------------------------------------
async function renderWithContext(env: UsecaseEnv): Promise<EvalSlots> {
  const contextText = env.factory.textOnlyMessages(env.contextMessages);
  const messages = [...contextText, ...renderMessages(env, env.anchor)];
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages,
    extras: env.imageExtras
  }, { expect: 'images', prompt: env.anchor, signal: env.signal });
  return wrapImagesAsStoryboard(slots, env.anchor, 1);
}

async function renderFull(env: UsecaseEnv): Promise<EvalSlots> {
  return renderWithContext(env);
}

async function renderWindow(env: UsecaseEnv): Promise<EvalSlots> {
  return renderWithContext(env);
}

// ---------------------------------------------------------------------------
// 6. render-node — no storyboard, CURRENT NODE ONLY (text only)
// ---------------------------------------------------------------------------
async function renderNode(env: UsecaseEnv): Promise<EvalSlots> {
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages: renderMessages(env, env.anchor),
    extras: env.imageExtras
  }, { expect: 'images', prompt: env.anchor, signal: env.signal });
  return wrapImagesAsStoryboard(slots, env.anchor, 1);
}

// ---------------------------------------------------------------------------
// 6. image-generation — ONE explicit picture from `vars.promptText` (no
// storyboard). Used by the "adapt prompt & re-render" flow: the adapted
// prompt IS the concrete scene, so there is no planning pass. The image
// model receives ONLY the prompt text — no reference/attachment images.
// ---------------------------------------------------------------------------
async function imageGeneration(env: UsecaseEnv): Promise<EvalSlots> {
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages: renderMessages(env, env.anchor),
    extras: env.imageExtras
  }, { expect: 'images', prompt: env.anchor, signal: env.signal });
  return wrapImagesAsStoryboard(slots, env.anchor, 1);
}

// ---------------------------------------------------------------------------
// 7. image-send — create an image from marked text + a chat constant
// (combined in `vars.promptText`) sent AS-IS to the image model, plus optional
// reference images (`vars.attachments`) forwarded as image_url parts. That is
// explicitly NOT like the illustration use cases: no planning pass and NO
// drawing-instruction template — the prompt is exactly what the user typed in
// the dialog. Reference images are forwarded ONLY when the user attached them
// (they are occasional references, not the primary input). The picture is
// attached to the assistant node by the caller.
// ---------------------------------------------------------------------------
async function imageSend(env: UsecaseEnv): Promise<EvalSlots> {
  const prompt = (env.cx.vars.promptText ?? '').trim();
  const refs = referenceImageParts(env.cx.vars.attachments);
  let messages: ChatMessage[];
  if (refs.length > 0) {
    messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || 'See the attached reference image(s).' },
        ...refs
      ]
    }];
  } else {
    messages = [{ role: 'user', content: prompt || '(no text)' }];
  }
  const slots = await env.orch.completeImage(env.cx, {
    model: env.render.model,
    provider: env.render.provider,
    messages,
    extras: env.imageExtras
  }, { expect: 'images', prompt, signal: env.signal });
  return wrapImagesAsStoryboard(slots, prompt, 1);
}

export {
  renderFull,
  renderWindow,
  renderNode,
  imageGeneration,
  imageSend
};
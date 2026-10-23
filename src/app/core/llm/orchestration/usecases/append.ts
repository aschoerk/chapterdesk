import type { EvalSlots } from '../types';
import { canGenerateImages } from '../../../../models/chat-config';
import { makeSlot, okSlot } from '../slots';
import { prepareTextSend } from '../flows';
import type { UsecaseEnv } from './env';

// ---------------------------------------------------------------------------
// append — normal send: user/director at the end of the chat + full history.
// Streams the answer (unless the model/chat is configured non-streaming); the
// text/thinking slots fill incrementally (partial) so a view adapter can paint
// the node DURING the SSE stream, then finalize.
// ---------------------------------------------------------------------------
async function append(env: UsecaseEnv): Promise<EvalSlots> {
  const write = env.write;
  const messages = env.sendMessages ?? [];
  if (!write) {
    return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
  }
  return env.orch.completion(env.cx, {
    model: write.model,
    provider: write.provider,
    messages,
    extras: env.textExtras,
    stream: env.textExtras?.['stream'] !== false,
    imageCapable: canGenerateImages(write.model)
  }, { expect: 'text', onChunk: env.onChunk, signal: env.signal, nodeId: env.nodeId });
}

// ---------------------------------------------------------------------------
// append-with-images — like append, but the current user node carries image
// attachments. The images are FIRST described by the image-interpret model;
// the description is then merged into the direction text of the final user
// message (so the writing model sees the images' content, never the binary
// payload). Interpretation runs ONLY when the descriptions are NOT already
// stored in the node's text (see `prepareTextSend` + the image-description
// record). Falls back to a plain append otherwise.
// ---------------------------------------------------------------------------
async function appendWithImages(env: UsecaseEnv): Promise<EvalSlots> {
  const write = env.write;
  if (!write) {
    return { error: makeSlot('error', 'http', 'No writing model is enabled.', {}) };
  }

  const prep = await prepareTextSend(env, env.cx.chat.id, env.cx.node, {
    content: env.cx.vars.content,
    attachments: env.cx.vars.attachments
  });

  const slots = await env.orch.completion(env.cx, {
    model: write.model,
    provider: write.provider,
    messages: prep.messages,
    extras: env.textExtras,
    stream: env.textExtras?.['stream'] !== false,
    imageCapable: canGenerateImages(write.model)
  }, { expect: 'text', onChunk: env.onChunk, signal: env.signal, nodeId: env.nodeId });

  const out: EvalSlots = { ...slots };
  if (prep.mergedContent && prep.record) {
    // Expose the MERGED content (persist for real) + the record (marks the
    // description as stored, so it is never interpreted again).
    out.direction = okSlot(prep.mergedContent, {});
    out.interpretation = okSlot({ content: prep.mergedContent, record: prep.record }, {});
  }
  return out;
}

export {
  append,
  appendWithImages
};
import { ChatMessage, ChatNode, NodeAttachment } from '../../../../models/chat';
import { canGenerateImages } from '../../../../models/chat-config';
import { ChatService } from '../../../chat/chat.service';
import { LlmLogService } from '../../llm-log.service';
import { UsecaseContextFactory, type NodeAttachmentLike } from '../context';
import { LlmOrchestratorService } from '../orchestrator';
import type { EvalSlots, LlmImagePart, UsecaseContext } from '../types';
import { imagePartToAttachment, isGeneratedImageAttachment } from '../../llm-message';
import { newId } from '../../../util/helpers';
import type { FlowEnv } from './env';

/**
 * The shared TEXT-SEND pipeline used by the structural chat-mutation flows
 * (`flows/sends.ts`) and by the plain append use cases (`usecases/append.ts`).
 *
 *  - `prepareTextSend` interprets attached images ONLY when their description
 *    is not already stored in the node's text, then builds a text-only
 *    history for the request.
 *  - `streamAnswerNode` creates a placeholder assistant node, streams into it
 *    via the orchestrator with live painting, and versions it.
 *
 * Everything here is a `FlowEnv`/`PrepareEnv`-typed helper — the flow
 * controllers are the only place chat-mutation decisions are made.
 */

/** Result of preparing a text send (interpretation + message building). */
interface PreparedSend {
  messages: ChatMessage[];
  /** Set when images were freshly interpreted and merged into the content. */
  mergedContent?: string;
  /** The record attachment to persist (marks "description stored"). */
  record?: NodeAttachmentLike;
}

/** Minimal env fields `prepareTextSend` needs (UsecaseEnv + FlowEnv satisfy it). */
interface PrepareEnv {
  readonly cx: UsecaseContext;
  readonly factory: UsecaseContextFactory;
  readonly orch: LlmOrchestratorService;
  readonly signal?: AbortSignal;
}

/**
 * Build the messages for a text send for a QUESTION node, using THE
 * interpretation rule: images are interpreted ONLY when their description is
 * not already stored in the node's text (i.e. no matching
 * `image-description.txt` record). When freshly interpreted, the merged
 * content + record are returned so the caller persists them.
 */
export async function prepareTextSend(
  env: PrepareEnv,
  chatId: string,
  question: ChatNode,
  opts: { content?: string; attachments?: NodeAttachmentLike[] } = {}
): Promise<PreparedSend> {
  const content = (opts.content ?? question.content ?? '').trim();
  const atts = opts.attachments !== undefined ? opts.attachments : (question.attachments ?? []);

  const need = env.factory.needsImageInterpretation(question, atts);
  if (need) {
    const interpret = env.factory.resolveInterpretModel();
    const images = env.factory.imageAttachments(atts);
    if (interpret && images.length > 0) {
      // Force text output when the interpret model can ALSO generate images:
      // a multimodal model may otherwise answer with an image instead of a
      // description. Only a genuinely successful TEXT reply is accepted — a
      // refused/empty/image-only response must never merge a placeholder.
      const forceText = (interpret.model.architecture?.output_modalities ?? []).includes('image');
      const islots = await env.orch.completion(env.cx, {
        model: interpret.model,
        provider: interpret.provider,
        messages: env.factory.buildInterpretMessage(images),
        extras: await env.factory.resolveTextExtras(interpret.model, env.cx.chat),
        stream: false,
        textOnlyModalities: forceText
      }, { expect: 'text', signal: env.signal, nodeId: question.id });
      const description = islots.text?.status === 'ok'
        ? (islots.text?.value ?? '').trim()
        : '';
      if (description) {
        const merged = env.factory.mergeDirectionWithDescription(content, description);
        const messages = env.factory.buildSendMessagesEx({ chatId, nodeId: question.id, contentOverride: merged });
        const record = env.factory.buildImageDescriptionRecord(images, description);
        return { messages, mergedContent: merged, record };
      }
    }
  }
  const messages = env.factory.buildSendMessagesEx({ chatId, nodeId: question.id, contentOverride: content });
  return { messages };
}

/** Merge + persist the freshly-interpreted content + record onto the node. */
export async function persistInterpretation(
  env: FlowEnv,
  chatId: string,
  node: ChatNode,
  prep: PreparedSend
): Promise<void> {
  if (!prep.mergedContent || !prep.record) return;
  const attachments = [
    ...env.factory.withoutImageDescriptionRecord(node.attachments),
    prep.record
  ];
  await env.chatService.patchNode(chatId, node.id, {
    content: prep.mergedContent,
    attachments: attachments as ChatNode['attachments']
  });
}

/** True when a flow's answer produced nothing (refused/empty). */
export function flowEmpty(slots: EvalSlots): boolean {
  const text = (slots.text?.value ?? '').trim();
  // Images count as content — an image-capable model returning ONLY pictures
  // is a successful (non-empty) answer, not a refused/empty one.
  if (!text && slots.text?.status !== 'ok') {
    return (slots.images?.value ?? []).length === 0;
  }
  return false;
}

/**
 * Convert generated image parts into persisted node attachments (ids assigned,
 * deduped by URL — a stream may resend the same part in delta + final message).
 * `startIndex` lets a caller that PRESERVES existing generated illustrations
 * number the NEW pictures after them (`illustration-N` names stay unique).
 */
export function generatedImageAttachments(images: LlmImagePart[], startIndex = 0): NodeAttachment[] {
  const seen = new Set<string>();
  const out: NodeAttachment[] = [];
  let idx = startIndex;
  for (const img of images ?? []) {
    if (!img?.url || seen.has(img.url)) continue;
    seen.add(img.url);
    out.push({ ...imagePartToAttachment(img, idx), id: newId() });
    idx++;
  }
  return out;
}

/** Count of app-generated illustrations (`illustration-N.ext`) in a list. */
function existingGeneratedImageCount(attachments: NodeAttachment[] | undefined): number {
  return (attachments ?? []).filter(a => isGeneratedImageAttachment(a)).length;
}

/**
 * The attachments a rewritten chapter should carry: the PRESERVED attachments
 * of the old answer (so previous images stay available after a rewrite in
 * place) merged with any NEWLY generated image(s), renumbered after the
 * preserved ones. Returns `undefined` when there is nothing to attach.
 */
function mergeAnswerAttachments(
  preserved: NodeAttachment[] | undefined,
  newImages: LlmImagePart[] | undefined
): NodeAttachment[] | undefined {
  const kept = preserved ?? [];
  const fresh = generatedImageAttachments(newImages ?? [], existingGeneratedImageCount(kept));
  if (kept.length === 0 && fresh.length === 0) return undefined;
  return [...kept, ...fresh];
}

/**
 * The content of an IMAGE-ONLY answer. When the writing model returned ONLY
 * pictures (no text/thinking), the assistant chapter is filled with the
 * original DIRECTION text so it is not an empty bubble — the generated image
 * is attached right below it and the chapter still tells the reader what was
 * asked. Returns the model text unchanged when the model DID answer with text.
 */
export function imageOnlyAnswerContent(
  modelText: string,
  questionText: string | null | undefined,
  images: LlmImagePart[] | undefined
): string {
  if ((modelText ?? '').trim()) return modelText;
  if (!images?.length) return modelText;
  return (questionText ?? '').trim();
}

/**
 * Stream one answer into a NEW assistant node under `questionNodeId` (the
 * normal send path: placeholder + startGeneration + live paint via
 * ChatService.updateNodes + versioned editAssistant), optionally re-parenting
 * `adoptNodeIds` under the fresh answer.
 */
export async function streamAnswerNode(
  env: FlowEnv,
  chatId: string,
  questionNodeId: string,
  messages: ChatMessage[],
  opts: { adoptNodeIds?: string[]; preserveAttachments?: NodeAttachment[] } = {}
): Promise<{ answerNodeId: string; slots: EvalSlots }> {
  const chatService = env.chatService;
  const write = env.write;
  const answerNode = await chatService.addNode(chatId, {
    parentId: questionNodeId,
    role: 'assistant',
    content: '',
    thinking: '',
    modelId: write.model.modelId,
    providerId: write.model.providerId
  });
  chatService.setActiveChild(questionNodeId, answerNode.id);
  const signal = chatService.startGeneration(answerNode.id);

  let accContent = '';
  let accThinking = '';
  let accImages: LlmImagePart[] = [];
  try {
    const slots = await env.orch.completion(env.cx, {
      model: write.model,
      provider: write.provider,
      messages,
      extras: env.textExtras,
      // Respect the model's / chat's configured streaming preference — a
      // non-streaming configuration (chat parameters stream:false) must make
      // a plain completion, not force an SSE stream.
      stream: env.textExtras['stream'] !== false,
      // An image-GENERATION write model must be told to generate (modalities)
      // and gets the images-endpoint fallback tree; otherwise it answers 200
      // with empty content and no picture.
      imageCapable: canGenerateImages(write.model)
    }, {
      expect: 'text',
      nodeId: answerNode.id,
      onChunk: chunk => {
        if (chunk.content) accContent += chunk.content;
        if (chunk.thinking) accThinking += chunk.thinking;
        if (chunk.images?.length) accImages.push(...chunk.images);
        chatService.updateNodes(list =>
          list.map(n => (n.id === answerNode.id ? { ...n, content: accContent, thinking: accThinking } : n))
        );
      },
      signal
    });

    const finalContent = slots.text?.value ?? accContent;
    const finalThinking = slots.thinking?.value ?? accThinking;
    const finalImages = slots.images?.value ?? accImages;
    // An IMAGE-ONLY answer (the writing model returned only pictures, no
    // text): fill the chapter with the original direction so it is not an
    // empty bubble — the generated image is attached below it. The user
    // direction is the question node this answer is streamed under.
    const question = chatService.nodes().find(n => n.id === questionNodeId);
    const chapterContent = imageOnlyAnswerContent(finalContent, question?.content, finalImages);
    chatService.updateNodes(list =>
      list.map(n => (n.id === answerNode.id ? { ...n, content: chapterContent, thinking: finalThinking } : n))
    );

    let answerId = answerNode.id;
    // An image-only answer (image-capable model streamed pictures, no text)
    // must STILL be finalized — otherwise it stays an empty placeholder that
    // renders as "Generation stopped" and the images are never attached.
    if (chapterContent.trim() || finalThinking.trim() || finalImages.length > 0 || (opts.preserveAttachments?.length ?? 0) > 0) {
      // Preserved attachments (e.g. the old answer's images on a rewrite in
      // place) + any newly generated image(s), renumbered after the kept ones.
      const attachments = mergeAnswerAttachments(opts.preserveAttachments, finalImages);
      const versioned = await chatService.editAssistant(
        chatId, answerNode.id, chapterContent, attachments, finalThinking, slots.usage?.value ?? undefined
      );
      answerId = versioned.id;
      chatService.setActiveChild(questionNodeId, answerId);
      if (opts.adoptNodeIds?.length) {
        await chatService.reparentNodes(chatId, opts.adoptNodeIds, answerId);
      }
    }
    // The call was recorded under the placeholder node id — the node that is
    // actually kept (possibly a new version) must carry the usage instead.
    if (slots.logEntry && answerId !== answerNode.id) {
      env.llmLog.retargetNode(slots.logEntry, answerId);
    }
    return { answerNodeId: answerId, slots };
  } finally {
    chatService.clearGeneration();
    // One-shot excluded nodes (e.g. the chat-lore node created with
    // `excludeAfterSend`) have now been sent as part of this request: flip
    // them to permanently excluded so they are documented but never re-shipped.
    await chatService.markSentOnceExcluded(chatId, questionNodeId);
  }
}
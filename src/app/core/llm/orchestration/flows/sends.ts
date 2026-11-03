import { ChatNode, type NodeAttachment } from '../../../../models/chat';
import { canGenerateImages } from '../../../../models/chat-config';
import type { NodeAttachmentLike } from '../context';
import type { LlmImagePart } from '../../llm-message';
import type { ParsedUsage } from '../../usage';
import type { LlmLogEntry } from '../../llm-log.service';
import { makeSlot, okSlot } from '../slots';
import type { EvalSlots, FlowResult } from '../types';
import {
  flowEmpty,
  imageOnlyAnswerContent,
  mergeAnswerAttachments,
  persistInterpretation,
  prepareTextSend,
  streamAnswerNode
} from './text-send';
import { startHeldAnswerStream, type HeldAnswerStreamDeps } from '../../held-answer-stream';
import type { FlowEnv, FlowController, HeldRun } from './env';

// ---------------------------------------------------------------------------
// send-branch — new sibling question + streamed answer
// ---------------------------------------------------------------------------
const sendBranch: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const content = env.cx.vars.content ?? node.content ?? '';
  const carried = carryAttachments(node.attachments ?? [], env.cx.vars.attachments);

  // Legacy rule: branching a QUESTION creates a sibling under its parent;
  // branching an ANSWER creates a child question under the answer.
  const newQuestion = node.role === 'user'
    ? await env.chatService.branchQuestion(
        chatId, node.id, content, env.write.model.modelId, env.write.model.providerId, carried
      )
    : await env.chatService.addNode(chatId, {
        parentId: node.id,
        role: 'user',
        content,
        modelId: env.write.model.modelId,
        providerId: env.write.model.providerId,
        attachments: carried as ChatNode['attachments']
      });
  env.chatService.setActiveChild(newQuestion.parentId, newQuestion.id);

  // Current chat-lore: materialize a lore node in front of the new direction.
  await env.chatService.ensureLoreNodeBefore(chatId, newQuestion.id);

  const prep = await prepareTextSend(env, chatId, newQuestion, { content, attachments: carried });
  await persistInterpretation(env, chatId, newQuestion, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, newQuestion.id, prep.messages);
  return flowResult(slots, {
    questionNodeId: newQuestion.id,
    answerNodeId,
    activateId: newQuestion.id,
    branchNodeId: newQuestion.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-insert — new sibling question + answer that adopts the old siblings
// ---------------------------------------------------------------------------
const sendInsert: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const parentId = node.parentId ?? null;
  const content = env.cx.vars.content ?? node.content ?? '';
  const carried = carryAttachments(node.attachments ?? [], env.cx.vars.attachments);

  const newQuestion = await env.chatService.branchQuestion(
    chatId, node.id, content, env.write.model.modelId, env.write.model.providerId, carried
  );
  // Switch the active path to the new question IMMEDIATELY (mirroring
  // send-branch) so the streamed answer paints LIVE while it fills in. With
  // the switch deferred to the end, the new nodes stay off the active path
  // (the tree only renders the active path): the user sees neither the
  // streaming answer nor — from their side — the editor closing.
  env.chatService.setActiveChild(parentId, newQuestion.id);

  const adoptNodeIds = env.chatService.nodes()
    .filter(n => n.chatId === chatId && (n.parentId ?? null) === parentId && n.id !== newQuestion.id)
    .map(n => n.id);

  // Current chat-lore: materialize a lore node in front of the new direction.
  await env.chatService.ensureLoreNodeBefore(chatId, newQuestion.id);

  const prep = await prepareTextSend(env, chatId, newQuestion, { content, attachments: carried });
  await persistInterpretation(env, chatId, newQuestion, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, newQuestion.id, prep.messages, { adoptNodeIds });

  // Show the adopted (old) sibling chain under the fresh answer.
  const firstAdopt = adoptNodeIds.includes(node.id) ? node.id : adoptNodeIds[0];
  if (firstAdopt) env.chatService.setActiveChild(answerNodeId, firstAdopt);

  return flowResult(slots, {
    questionNodeId: newQuestion.id,
    answerNodeId,
    activateId: newQuestion.id,
    branchNodeId: newQuestion.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-regenerate — delete the answer (+ subtree), re-stream under the question
// ---------------------------------------------------------------------------
const sendRegenerate: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const question = parentQuestion(env, node);
  if (!question) {
    return { error: makeSlot('error', 'http', 'No question node to regenerate.', {}) };
  }

  // Current chat-lore: the direction being regenerated sits behind a lore
  // node that was deactivated after its first send — (re-)arm it (clear its
  // excludeFromContext flag) BEFORE anything is deleted, so the re-sent
  // request carries the lore again.
  await env.chatService.ensureLoreNodeBefore(chatId, question.id);

  await env.chatService.deleteNode(chatId, node.id);

  const prep = await prepareTextSend(env, chatId, question, {
    content: question.content,
    attachments: question.attachments
  });
  await persistInterpretation(env, chatId, question, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, question.id, prep.messages);
  return flowResult(slots, {
    questionNodeId: question.id,
    answerNodeId,
    activateId: question.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-rewrite — delete ONLY the answer (keep following text), re-stream
// ---------------------------------------------------------------------------
const sendRewrite: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const question = parentQuestion(env, node);
  if (!question) {
    return { error: makeSlot('error', 'http', 'No question node to rewrite.', {}) };
  }

  // Current chat-lore: the direction being rewritten in place sits behind a
  // lore node deactivated after its first send — (re-)arm it (clear its
  // excludeFromContext flag) BEFORE anything is removed, so the re-sent
  // request carries the lore again.
  await env.chatService.ensureLoreNodeBefore(chatId, question.id);

  const adoptNodeIds = env.chatService.getChildren(node.id).map(c => c.id);
  // Rewrite in place preserves the OLD answer's attachments (e.g. previously
  // generated images) — they must survive the node deletion and be merged
  // onto the fresh answer so earlier pictures stay available.
  const preservedAttachments = (node.attachments ?? []).slice();
  await env.chatService.deleteNode(chatId, node.id, { keepChildren: true });

  const prep = await prepareTextSend(env, chatId, question, {
    content: question.content,
    attachments: question.attachments
  });
  await persistInterpretation(env, chatId, question, prep);
  const { answerNodeId, slots } = await streamAnswerNode(
    env, chatId, question.id, prep.messages, { adoptNodeIds, preserveAttachments: preservedAttachments }
  );
  if (adoptNodeIds.length) env.chatService.setActiveChild(answerNodeId, adoptNodeIds[0]);
  return flowResult(slots, {
    questionNodeId: question.id,
    answerNodeId,
    activateId: question.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-prepend — director node + streamed result, adopting the current node
// ---------------------------------------------------------------------------
const sendPrepend: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const parentId = node.parentId ?? null;
  const directorText = (env.cx.vars.directorText ?? '').trim();
  const following = (env.cx.vars.followingText ?? '').trim();
  const prompt = [directorText, following].filter(Boolean).join('\n\n');
  if (!prompt.trim()) {
    return { error: makeSlot('error', 'http', 'No director text to prepend.', {}) };
  }

  const directorNode = await env.chatService.addNode(chatId, {
    parentId,
    role: 'user',
    content: directorText,
    modelId: env.write.model.modelId,
    providerId: env.write.model.providerId
  });
  env.chatService.setActiveChild(parentId, directorNode.id);

  // Current chat-lore: materialize a lore node in front of the director
  // direction.
  await env.chatService.ensureLoreNodeBefore(chatId, directorNode.id);

  // The final user message is the director + following chapters; history is
  // the text-only path up to the current node (images never re-sent).
  const messages = env.factory.buildSendMessagesEx({
    chatId,
    nodeId: directorNode.id,
    contentOverride: prompt
  });

  const { answerNodeId, slots } = await streamAnswerNode(
    env, chatId, directorNode.id, messages, { adoptNodeIds: [node.id] }
  );
  env.chatService.setActiveChild(parentId, directorNode.id);
  return flowResult(slots, {
    questionNodeId: directorNode.id,
    answerNodeId,
    directorNodeId: directorNode.id,
    activateId: answerNodeId
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-elaborate — one chapter elaboration appended under the anchor
// ---------------------------------------------------------------------------
const sendElaborate: FlowController = async env => {
  const anchor = env.cx.node;
  const chatId = env.cx.chat.id;
  const content = (env.cx.vars.content ?? '').trim();
  if (!content) {
    return { error: makeSlot('error', 'http', 'No elaborate prompt.', {}) };
  }
  const parentId = anchor?.id ?? null;

  // Reuse an empty user leaf draft under the anchor if one exists, else
  // create a fresh question (mirrors the legacy elaborate dialog).
  const question = await getOrCreateElaborateQuestion(env, chatId, parentId, content);

  // Current chat-lore: materialize a lore node in front of the elaborate
  // direction.
  await env.chatService.ensureLoreNodeBefore(chatId, question.id);

  // History = text-only path up to the question + topic system prompt; the
  // final user message is the rendered elaborate prompt.
  const messages = env.factory.buildSendMessagesEx({
    chatId,
    nodeId: question.id,
    contentOverride: content
  });

  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, question.id, messages);
  return flowResult(slots, {
    questionNodeId: question.id,
    answerNodeId,
    activateId: answerNodeId
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// send-elaborate (HELD) — the sequential elaborate pipeline. The question +
// lore + messages are prepared exactly like `sendElaborate`, but the answer
// stream is returned as a HeldRun: the caller finalizes each chapter the
// moment its LLM stops (so the NEXT chapter's context is complete) and drains
// its tail at pace while the next chapter streams in the background.
// ---------------------------------------------------------------------------
export async function startSendElaborateHeld(env: FlowEnv): Promise<HeldRun> {
  const anchor = env.cx.node;
  const chatId = env.cx.chat.id;
  const content = (env.cx.vars.content ?? '').trim();
  if (!content) {
    throw new Error('No elaborate prompt.');
  }
  const parentId = anchor?.id ?? null;

  // Reuse an empty user leaf draft under the anchor if one exists, else
  // create a fresh question (mirrors the legacy elaborate dialog).
  const question = await getOrCreateElaborateQuestion(env, chatId, parentId, content);

  // Current chat-lore: materialize a lore node in front of the elaborate
  // direction.
  await env.chatService.ensureLoreNodeBefore(chatId, question.id);

  // History = text-only path up to the question + topic system prompt; the
  // final user message is the rendered elaborate prompt. `historyOverrides`
  // carries the FULL text of the previous (still-revealing) chapter so the
  // next chapter's context is never truncated by the reveal clamp.
  const messages = env.factory.buildSendMessagesEx({
    chatId,
    nodeId: question.id,
    contentOverride: content,
    overrides: env.cx.vars.historyOverrides
  });

  const deps: HeldAnswerStreamDeps = {
    prefs: env.chatService,
    createPlaceholderNode: async () => {
      const node = await env.chatService.addNode(chatId, {
        parentId: question.id,
        role: 'assistant',
        content: '',
        thinking: '',
        modelId: env.write.model.modelId,
        providerId: env.write.model.providerId
      });
      env.chatService.setActiveChild(question.id, node.id);
      return node.id;
    },
    setActiveChild: (p: string | null, c: string) => env.chatService.setActiveChild(p, c),
    startGeneration: (id: string) => env.chatService.startGeneration(id),
    paint: (nodeId: string, c: string, t: string) => env.chatService.updateNodes(list =>
      list.map(n => (n.id === nodeId ? { ...n, content: c, thinking: t } : n))),
    runCompletion: async ({ nodeId, signal, onChunk }: {
      nodeId: string;
      signal: AbortSignal;
      onChunk: (chunk: import('../../llm-sse').LlmChunk) => void;
    }) => env.orch.completion(env.cx, {
      model: env.write.model,
      provider: env.write.provider,
      messages,
      extras: env.textExtras,
      // Respect the model's / chat's configured streaming preference.
      stream: env.textExtras['stream'] !== false,
      // An image-GENERATION write model must be told to generate (modalities)
      // and gets the images-endpoint fallback tree.
      imageCapable: canGenerateImages(env.write.model)
    }, { expect: 'text', nodeId, onChunk, signal }),
    finalizeAnswer: async (opts: {
      placeholderId: string;
      finalContent: string;
      finalThinking: string;
      finalImages: LlmImagePart[];
      usage?: ParsedUsage;
      logEntry?: LlmLogEntry;
      adoptNodeIds?: string[];
      preserveAttachments?: NodeAttachment[];
    }) => {
      const questionNode = env.chatService.nodes().find(n => n.id === question.id);
      const chapterContent = imageOnlyAnswerContent(opts.finalContent, questionNode?.content, opts.finalImages);
      const attachments = mergeAnswerAttachments(opts.preserveAttachments, opts.finalImages);
      const versioned = await env.chatService.editAssistant(
        chatId, opts.placeholderId, chapterContent, attachments, opts.finalThinking, opts.usage
      );
      env.chatService.setActiveChild(question.id, versioned.id);
      if (opts.adoptNodeIds?.length) {
        await env.chatService.reparentNodes(chatId, opts.adoptNodeIds, versioned.id);
      }
      return { id: versioned.id, content: chapterContent };
    },
    markSentOnceExcluded: () => env.chatService.markSentOnceExcluded(chatId, question.id),
    retargetLog: (entry: LlmLogEntry, nodeId: string) => env.llmLog.retargetNode(entry, nodeId)
  };

  const stream = await startHeldAnswerStream(deps, { queue: env.queue });
  return {
    questionNodeId: question.id,
    placeholderNodeId: stream.placeholderNodeId,
    streamDone: stream.streamDone,
    get answerNodeId() {
      return stream.answerNodeId;
    },
    finalContent: () => stream.finalContent(),
    async finalize(signal?: AbortSignal): Promise<EvalSlots> {
      const answerNodeId = await stream.finalize(signal);
      const slots = await stream.streamDone;
      return flowResult(slots, {
        questionNodeId: question.id,
        answerNodeId,
        activateId: answerNodeId
      }, flowEmpty(slots));
    },
    drain: (signal?: AbortSignal) => stream.drain(signal),
    abort: () => stream.abort()
  };
}

/** Reuse an empty user leaf under `parentId` if one exists, else create one. */
async function getOrCreateElaborateQuestion(
  env: FlowEnv,
  chatId: string,
  parentId: string | null,
  content: string
): Promise<ChatNode> {
  const chatService = env.chatService;
  const children = chatService.getChildren(parentId);
  const draft = children.find(n =>
    n.role === 'user' &&
    !(n.content ?? '').trim() &&
    !(n.attachments?.length)
  );
  if (draft) {
    const saved = await chatService.persistQuestion(
      chatId, draft.id, content, undefined,
      env.write.model.modelId, env.write.model.providerId
    );
    chatService.setActiveChild(parentId, saved.id);
    // The elaborate prompt is an auto-generated meta-direction: it must have
    // been sent (it is/was the current question), but is excluded as history.
    await chatService.patchNode(chatId, saved.id, { excludeFromContext: true });
    return saved;
  }
  const created = await chatService.addNode(chatId, {
    parentId,
    role: 'user',
    content,
    modelId: env.write.model.modelId,
    providerId: env.write.model.providerId,
    excludeFromContext: true
  });
  chatService.setActiveChild(parentId, created.id);
  return created;
}

// ---------------------------------------------------------------------------
// send-chapter-descriptions — plan a chapter description list as ANOTHER
// branch (sibling question + streamed answer). The empty leaf question (where
// Continue lives) stays untouched; the branch request carries the parameters
// (chapter count, sentences per description, first chapter number, goal) and
// the FULL previous chat content arrives as history via buildSendMessagesEx.
// ---------------------------------------------------------------------------
const sendChapterDescriptions: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const count = Math.max(1, Math.floor(Number(env.cx.vars.chapterCount) || 1));
  const sentences = Math.max(1, Math.floor(Number(env.cx.vars.sentencesPerChapter) || 1));
  const first = Math.max(1, Math.floor(Number(env.cx.vars.firstChapter) || 1));
  const goal = (env.cx.vars.goal ?? '').trim();
  const instruction = env.factory.chapterDescriptionsInstruction();

  const lines: string[] = [instruction];
  lines.push(`Number of chapters to plan: ${count}`);
  lines.push(`Sentences per chapter description: ${sentences}`);
  lines.push(`First chapter number: ${first}`);
  if (goal) {
    lines.push('What the chapters are meant to achieve:');
    lines.push(goal);
  }
  lines.push(`Return only the chapter list, starting at chapter ${first}.`);
  const request = lines.filter(Boolean).join('\n');

  // "Another branch to the first one": branch a NEW sibling question off the
  // current node (the empty leaf) — the previous chat content is the history,
  // the final user message is the chapter-description request. The request is
  // an auto-generated meta-direction: sent once (it is the current question),
  // excluded from history afterwards.
  const newQuestion = await env.chatService.branchQuestion(
    chatId, node.id, request, env.write.model.modelId, env.write.model.providerId, undefined
  );
  env.chatService.setActiveChild(newQuestion.parentId, newQuestion.id);
  await env.chatService.patchNode(chatId, newQuestion.id, { excludeFromContext: true });

  // Current chat-lore: materialize a lore node in front of the request
  // direction.
  await env.chatService.ensureLoreNodeBefore(chatId, newQuestion.id);

  const prep = await prepareTextSend(env, chatId, newQuestion, { content: request });
  await persistInterpretation(env, chatId, newQuestion, prep);
  const { answerNodeId, slots } = await streamAnswerNode(env, chatId, newQuestion.id, prep.messages);
  return flowResult(slots, {
    questionNodeId: newQuestion.id,
    answerNodeId,
    activateId: answerNodeId,
    branchNodeId: newQuestion.id
  }, flowEmpty(slots));
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flowResult(slots: EvalSlots, r: Omit<FlowResult, 'empty'>, empty: boolean): EvalSlots {
  return { ...slots, flow: okSlot({ ...r, empty }, {}) };
}

/** Merge original attachments (with records) + draft images, deduped by dataUrl. */
function carryAttachments(
  original: NodeAttachmentLike[],
  draft?: NodeAttachmentLike[] | null
): NodeAttachmentLike[] {
  const seen = new Set<string>();
  const out: NodeAttachmentLike[] = [];
  for (const a of [...(original ?? []), ...(draft ?? [])]) {
    const key = a?.dataUrl || a?.id || a?.name || '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** The user node a regenerate/rewrite re-answers (the parent of the answer). */
function parentQuestion(env: FlowEnv, node: ChatNode): ChatNode | null {
  return node.parentId
    ? env.chatService.nodes().find(n => n.id === node.parentId) ?? null
    : null;
}

export {
  sendBranch,
  sendInsert,
  sendRegenerate,
  sendRewrite,
  sendPrepend,
  sendElaborate,
  sendChapterDescriptions
};
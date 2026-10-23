import { ChatNode } from '../../../../models/chat';
import { makeSlot, okSlot } from '../slots';
import type { EvalSlots, FlowResult } from '../types';
import type { FlowEnv, FlowController } from './env';

// ---------------------------------------------------------------------------
// Structure generation — non-streaming text completions that CREATE or PATCH
// structural nodes around a plain text result (story title, introduction,
// per-chapter headings) plus the language check. They reuse the shared
// write-model + text-extras resolution from the flow runner; the editorial
// placement goes through ChatService (create structural node + reparent).
// ---------------------------------------------------------------------------

/** One text completion (title/overview/heading/language check default to
 *  non-streaming; `stream: true` streams and forwards `env.onChunk` so a
 *  caller can show live progress — used by rewrite-selection). */
async function textCompletion(env: FlowEnv, userContent: string, opts: { stream?: boolean } = {}): Promise<EvalSlots> {
  const stream = opts.stream === true;
  return env.orch.completion(env.cx, {
    model: env.write.model,
    provider: env.write.provider,
    messages: [{ role: 'user', content: userContent }],
    extras: env.textExtras,
    stream
  }, { expect: 'text', onChunk: stream ? env.onChunk : undefined, signal: env.signal });
}

/** Create a structural node (title/overview/heading) under `parentId`. */
async function addStructureNode(env: FlowEnv, chatId: string, parentId: string | null, content: string): Promise<ChatNode> {
  const model = env.write.model;
  return env.chatService.addNode(chatId, {
    parentId,
    role: 'structural',
    content,
    modelId: model.modelId,
    providerId: model.providerId,
    chatParametersId: env.chatService.chats().find(c => c.id === chatId)?.chatParametersId
      || model.chatParametersId
      || undefined
  });
}

/** Wrap result slots in a structure placement (node(s) created/patched). */
function structureResult(slots: EvalSlots, nodeId: string, ids?: string[]): EvalSlots {
  const flow: FlowResult = {
    questionNodeId: '',
    answerNodeId: nodeId,
    activateId: nodeId,
    structureNodeId: nodeId,
    ...(ids ? { structureNodeIds: ids } : {}),
    empty: false
  };
  return { ...slots, flow: okSlot(flow, {}) };
}

/** All current assistant chapters (the whole-story context). */
function wholeStoryContext(env: FlowEnv): string {
  return env.chatService.currentNodes()
    .filter(n => n.isCurrent && n.role === 'assistant' && n.content?.trim())
    .map(n => n.content)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// structure-title — a story title from ALL current chapters, wrapped at root;
// the generated title also becomes the chat title.
// ---------------------------------------------------------------------------
const structureTitle: FlowController = async env => {
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  const instruction = env.factory.structureInstruction('title');
  const context = wholeStoryContext(env);
  const slots = await textCompletion(env,
    `${instruction}\n\nCurrent chat context:\n${context || '(empty chat)'}\n\nReturn only the resulting text.`);
  const content = (slots.text?.value ?? '').trim();
  if (!content) return { ...slots, error: makeSlot('error', 'http', 'No title generated.', {}) };

  const first = chatService.getActiveChild(null);
  const created = await addStructureNode(env, chatId, null, content);
  if (first) {
    await chatService.reparentNodes(chatId, [first.id], created.id);
    chatService.setActiveChild(null, created.id);
    chatService.setActiveChild(created.id, first.id);
  } else {
    chatService.setActiveChild(null, created.id);
  }
  await chatService.updateChatTitle(chatId, content);
  return structureResult(slots, created.id);
};

// ---------------------------------------------------------------------------
// structure-overview — an introduction from ALL current chapters; sits right
// after an existing structure node (e.g. a title), else becomes the first.
// ---------------------------------------------------------------------------
const structureOverview: FlowController = async env => {
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  const instruction = env.factory.structureInstruction('overview');
  const context = wholeStoryContext(env);
  const slots = await textCompletion(env,
    `${instruction}\n\nCurrent chat context:\n${context || '(empty chat)'}\n\nReturn only the resulting text.`);
  const content = (slots.text?.value ?? '').trim();
  if (!content) return { ...slots, error: makeSlot('error', 'http', 'No introduction generated.', {}) };

  const rootChildren = chatService.getChildren(null);
  const existingStructure = rootChildren.find(n => n.role === 'structural');
  const parentId = existingStructure?.id ?? null;
  const first = chatService.getActiveChild(parentId);
  const created = await addStructureNode(env, chatId, parentId, content);
  if (first) {
    await chatService.reparentNodes(chatId, [first.id], created.id);
    chatService.setActiveChild(parentId, created.id);
    chatService.setActiveChild(created.id, first.id);
  } else {
    chatService.setActiveChild(parentId, created.id);
  }
  return structureResult(slots, created.id);
};

// ---------------------------------------------------------------------------
// structure-heading — a heading for ONE chapter (the current node). Patches
// the chapter's structural parent when one exists, else wraps the chapter.
// ---------------------------------------------------------------------------
const structureHeading: FlowController = async env => {
  const node = env.cx.node;
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  if (!node || node.role !== 'assistant') {
    return { error: makeSlot('error', 'http', 'No assistant chapter to head.', {}) };
  }
  const instruction = env.factory.structureInstruction('headings');
  const context = (node.content ?? '').trim();
  const slots = await textCompletion(env,
    `${instruction}\n\nCurrent chat context:\n${context || '(empty chat)'}\n\nReturn only the resulting text.`);
  const content = (slots.text?.value ?? '').trim();
  if (!content) return { ...slots, error: makeSlot('error', 'http', 'No heading generated.', {}) };

  const existingHeading = node.parentId
    ? chatService.nodes().find(n => n.id === node.parentId && n.role === 'structural')
    : undefined;
  if (existingHeading) {
    await chatService.patchNode(chatId, existingHeading.id, {
      content,
      modelId: env.write.model.modelId,
      providerId: env.write.model.providerId
    });
    return structureResult(slots, existingHeading.id);
  }

  const created = await addStructureNode(env, chatId, node.parentId, content);
  await chatService.reparentNodes(chatId, [node.id], created.id);
  chatService.setActiveChild(node.parentId, created.id);
  chatService.setActiveChild(created.id, node.id);
  return structureResult(slots, created.id);
};

// ---------------------------------------------------------------------------
// structure-headings — a heading for EVERY chapter on the active path that
// has none yet. Already-headed chapters stay in the context (as previous
// chapters with their headings) but are never regenerated. Aborts between
// chapters on the caller signal (one Stop cancels the whole run).
// ---------------------------------------------------------------------------
const structureHeadings: FlowController = async env => {
  const chatId = env.cx.chat.id;
  const chatService = env.chatService;
  const instruction = env.factory.structureInstruction('headings');
  const assistants = chatService.getActivePath()
    .filter(n => n.role === 'assistant' && n.content?.trim());
  const nodeById = new Map(chatService.currentNodes().map(n => [n.id, n]));
  const previous: { node: ChatNode; heading: ChatNode }[] = [];
  const createdIds: string[] = [];

  for (const assistant of assistants) {
    // BOTH stop signals end the run between chapters: the hard Stop abort
    // (signal) and the graceful “Finish & stop” (checked before a chapter's
    // request), so the heading of the chapter that is CURRENTLY being
    // generated is still fetched and persisted.
    if (env.signal?.aborted || chatService.shouldStopAfterCurrentStep()) break;
    const parent = assistant.parentId ? nodeById.get(assistant.parentId) : undefined;
    if (parent?.role === 'structural') {
      previous.push({ node: assistant, heading: parent });
      continue;
    }

    // Context = earlier chapters (incl. their generated headings) + the current one.
    const blocks: string[] = previous.map(({ node, heading }) =>
      `Chapter — heading: "${heading.content}"\n\nContent:\n${node.content}`);
    blocks.push(`Chapter — heading: (to be created)\n\nContent:\n${assistant.content}`);

    const slots = await textCompletion(env,
      `${instruction}\n\nThe following chapters are listed in story order. Every chapter already has a heading EXCEPT the LAST one.\nGenerate the heading for the LAST chapter only; use the earlier chapters to match the style.\n\n${blocks.join('\n\n')}\n\nReturn only the heading text.`);
    // Hard abort only here: the heading text was already fetched, and a
    // graceful stop must still PERSIST it (preserve the result) before the
    // next loop iteration stops the run.
    if (env.signal?.aborted) break;
    const headingContent = (slots.text?.value ?? '').trim();
    if (!headingContent) return { ...slots, error: makeSlot('error', 'http', 'No heading generated.', {}) };

    const heading = await addStructureNode(env, chatId, assistant.parentId, headingContent);
    await chatService.reparentNodes(chatId, [assistant.id], heading.id);
    chatService.setActiveChild(assistant.parentId, heading.id);
    chatService.setActiveChild(heading.id, assistant.id);
    previous.push({ node: assistant, heading });
    createdIds.push(heading.id);
  }

  const lastId = createdIds[createdIds.length - 1] ?? '';
  return structureResult({}, lastId, createdIds);
};

// ---------------------------------------------------------------------------
// language-check — copy-edit a writing direction; returns the RAW model text
// (the caller parses the three variants). No chat mutation.
// ---------------------------------------------------------------------------
const languageCheck: FlowController = async env => {
  const text = (env.cx.vars.content ?? '').trim();
  if (!text) {
    return { error: makeSlot('error', 'http', 'No direction to check.', {}) };
  }
  const instruction = env.factory.englishCheckInstruction();
  return textCompletion(env, `${instruction}\n\nOriginal direction:\n${text}`);
};

// ---------------------------------------------------------------------------
// rewrite-selection — propose corrected variants of a MARKED piece of text,
// optionally grounded in surrounding context. No chat mutation; the caller
// renders the returned variant strings and replaces the marked range.
// ---------------------------------------------------------------------------
const rewriteSelection: FlowController = async env => {
  const text = (env.cx.vars.content ?? '').trim();
  if (!text) {
    return { error: makeSlot('error', 'http', 'No text to rewrite.', {}) };
  }
  const directions = (env.cx.vars.directions ?? '').trim();
  // Context scope: 'none' | 'node' | 'upto' | 'all' (defaults to the node).
  const mode = (env.cx.vars.contextMode ?? 'node');
  const node = env.cx.node;
  const nodeContent = node?.content ?? '';

  let contextText = '';
  if (mode === 'node') {
    contextText = nodeContent;
  } else if (mode === 'upto') {
    const end = typeof env.cx.vars.selectionEnd === 'number'
      ? env.cx.vars.selectionEnd
      : nodeContent.length;
    contextText = nodeContent.slice(0, Math.max(0, end));
  } else if (mode === 'all') {
    // The whole thread up to (and including) the current node, text-only.
    const messages = node
      ? env.factory.buildSendMessagesEx({ chatId: env.cx.chat.id, nodeId: node.id })
      : [];
    contextText = env.factory.textOnlyMessages(messages)
      .map(m => {
        const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
        return `${who}:\n${typeof m.content === 'string' ? m.content : ''}`;
      })
      .join('\n\n');
  }

  const instruction = env.factory.rewriteInstruction();
  const parts: string[] = [instruction];
  if (directions) parts.push(`User directions — the rewrite MUST follow these:\n${directions}`);
  if (contextText) parts.push(`Context the marked text appears in:\n${contextText}`);
  parts.push(`Marked text to rewrite:\n${text}`);
  // Streamed so the rewrite dialog can show live progress (last word received).
  return textCompletion(env, parts.join('\n\n'), { stream: true });
};

export {
  structureTitle,
  structureOverview,
  structureHeading,
  structureHeadings,
  languageCheck,
  rewriteSelection
};
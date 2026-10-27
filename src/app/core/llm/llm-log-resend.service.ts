import { inject, Injectable } from '@angular/core';
import { Chat, ChatMessage, ChatNode, NodeAttachment, NodeUsageSummary } from '../../models/chat';
import { canGenerateImages, ModelEntry, ProviderConfig } from '../../models/chat-config';
import { ChatService } from '../chat/chat.service';
import { SettingsService } from '../settings/settings.service';
import { LlmLogEntry, LlmLogService } from './llm-log.service';
import { LlmOrchestratorService } from './orchestration/orchestrator';
import { generatedImageAttachments } from './orchestration/flows';
import type { UsecaseKind } from './orchestration/types';
import { isGeneratedImageAttachment, MessagePart, messageText } from './llm-message';
import type { LlmImagePart } from './llm-message';

/**
 * One message as shown in the "Edit & resend" dialog: the role (read-only)
 * plus the editable text. Non-text parts (image_url / file) that the ORIGINAL
 * request carried are preserved separately and re-attached unchanged when the
 * request is sent again, so media the model saw is not lost by editing.
 */
export interface ResendMessage {
  role: string;
  text: string;
  /** Non-text parts (image_url/file/…) preserved from the original request. */
  parts?: MessagePart[];
}

/** Outcome of a resend. */
export interface ResendResult {
  ok: boolean;
  /** Why it failed, for the caller's alert/toast. */
  reason?: 'model' | 'provider' | 'chat' | 'failed';
  /** Human-readable failure text (provider error / refusal). */
  message?: string;
  /** Id of the persisted assistant answer node (when ok). */
  answerNodeId?: string;
  /** Number of generated pictures attached to the answer (when ok). */
  images?: number;
  /** The chat the response was added to. */
  chatId?: string;
  /** What happened with the response: added as a new chapter at the end of
   *  the chat, replaced the content of the node the original call created, or
   *  attached pictures to the node the original call illustrated. */
  applied?: 'chapter' | 'replaced' | 'attached';
}

/**
 * Log use-cases whose output is a generated picture (illustrate / re-render).
 * A resend of one of these ATTACHES the new pictures to the chapter node the
 * original call illustrated.
 */
const IMAGE_USECASES = new Set<string>([
  'storyboard-direct', 'planned-enblock', 'planned-scenes',
  'render-full', 'render-window', 'render-node',
  'image-generation', 'image-send',
]);

/**
 * Log use-cases whose output is a streamed answer chapter. A resend of one of
 * these REPLACES the content of the node the original call created (a
 * regenerate-style re-send).
 */
const TEXT_ANSWER_USECASES = new Set<string>([
  'append', 'append-with-images',
  'send-branch', 'send-insert', 'send-regenerate', 'send-rewrite',
  'send-prepend', 'send-elaborate',
]);

/**
 * "Edit & resend" for the LLM call log (`/logs`). Takes a recorded chat
 * request, sends it AGAIN with user-edited messages (same model/provider),
 * and adds the new response to the chat it was made for — the assistant text
 * becomes a new chapter (a direction node + answer node at the end of the
 * active path) and any generated pictures are attached to it.
 */
@Injectable({ providedIn: 'root' })
export class LlmLogResendService {
  private readonly settings = inject(SettingsService);
  private readonly chat = inject(ChatService);
  private readonly orch = inject(LlmOrchestratorService);
  private readonly llmLog = inject(LlmLogService);

  /**
   * Build the editable message list for a chat log entry. Text parts are
   * joined into one editable textarea; non-text parts (images/files the
   * request carried) are kept for re-attachment, not discarded.
   */
  editableMessages(entry: LlmLogEntry): ResendMessage[] {
    return (entry.messages ?? []).map(m => {
      const content = m.content;
      if (typeof content === 'string') {
        return { role: m.role, text: content };
      }
      if (Array.isArray(content)) {
        const texts: string[] = [];
        const parts: MessagePart[] = [];
        for (const p of content) {
          if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text') {
            const t = (p as { text?: unknown }).text;
            if (typeof t === 'string' && t.trim()) texts.push(t);
          } else if (p && typeof p === 'object') {
            parts.push(p as MessagePart);
          }
        }
        return { role: m.role, text: texts.join('\n\n'), parts };
      }
      return { role: m.role, text: content == null ? '' : String(content) };
    });
  }

  /**
   * Rebuild the OpenAI-shaped message array from the dialog's edits: edited
   * text + the preserved non-text parts of each message.
   */
  buildMessages(edits: ResendMessage[]): ChatMessage[] {
    return edits.map(m => {
      const role = (m.role === 'system' || m.role === 'user' || m.role === 'assistant') ? m.role : 'user';
      const text = m.text ?? '';
      if (!m.parts?.length) return { role, content: text };
      const parts: MessagePart[] = [
        ...(text.trim() ? [{ type: 'text', text } as MessagePart] : []),
        ...m.parts
      ];
      return { role, content: parts };
    });
  }

  /** Enabled models the user can re-send with (drives the dialog's model select). */
  availableModels(): ModelEntry[] {
    return this.settings.enabledModels();
  }

  /**
   * Default model for the resend dialog: the model the original call used when
   * it is still enabled, otherwise the first enabled model.
   */
  defaultModelId(entry: LlmLogEntry): string {
    if (entry.modelId && this.settings.enabledModels().some(
      m => m.modelId === entry.modelId || m.id === entry.modelId
    )) {
      return entry.modelId;
    }
    return this.settings.enabledModels()[0]?.modelId ?? '';
  }

  /**
   * Resolve the model + provider to re-send with: an explicit choice from the
   * dialog wins, otherwise the model the original call used. The provider is
   * always taken from the resolved model (falling back to the original call's
   * base URL when the model's provider record is gone).
   */
  private resolveRef(
    entry: LlmLogEntry,
    opts?: { modelId?: string }
  ): { model: ModelEntry; provider: ProviderConfig } | null {
    const chosen = opts?.modelId || entry.modelId;
    if (!chosen) return null;
    const model = this.settings.enabledModels().find(
      m => m.modelId === chosen || m.id === chosen
    ) ?? null;
    if (!model) return null;
    const provider = this.settings.providers().find(p => p.id === model.providerId)
      ?? (entry.provider ? this.settings.providers().find(p => p.baseUrl === entry.provider) : undefined)
      ?? null;
    if (!provider) return null;
    return { model, provider };
  }

  /**
   * Resend the (edited) request and write the response back into the chat it
   * was made for. When the original call was attributed to a node that still
   * exists in the chat, the response goes BACK to that node: a text answer
   * replaces the content of the node the call created, a picture call attaches
   * the new images to the chapter it illustrated. Otherwise the response is
   * added as a brand-new chapter at the end of the chat (direction node +
   * answer node, reusing the empty composer when present). The request is
   * re-sent with the model the original call used, or the explicitly chosen
   * `opts.modelId`.
   */
  async resend(
    entry: LlmLogEntry,
    edits: ResendMessage[],
    opts?: { modelId?: string }
  ): Promise<ResendResult> {
    const ref = this.resolveRef(entry, opts);
    if (!ref) {
      const chosen = opts?.modelId || entry.modelId;
      const hasModel = !!chosen && this.settings.enabledModels().some(
        m => m.modelId === chosen || m.id === chosen
      );
      return { ok: false, reason: hasModel ? 'provider' : 'model' };
    }
    const chatId = entry.chatId;
    if (!chatId) return { ok: false, reason: 'chat' };

    // Nodes of the target chat for path/version resolution. Prefer the live
    // store when it already holds this chat (the currently open one);
    // otherwise fetch WITHOUT clobbering the store.
    const live = this.chat.nodes().filter(n => n.chatId === chatId);
    const nodes = live.length > 0 ? live : await this.chat.fetchNodes(chatId);

    const messages = this.buildMessages(edits);
    const extras = this.extrasFrom(entry);

    // Does the original call point at a node that still exists? Then the
    // re-sent response updates THAT node instead of appending a new chapter.
    const target = this.resolveTargetNode(nodes, entry);

    // Re-send the edited request (original or chosen model), non-streaming —
    // the whole response (text + pictures) arrives in one shot.
    const cx = {
      chat: { id: chatId, title: entry.chatTitle ?? '' } as Chat,
      usecase: 'resend-log' as UsecaseKind,
      nodeId: target?.node.id,
    };
    const slots = await this.orch.completion(cx, {
      model: ref.model,
      provider: { baseUrl: ref.provider.baseUrl, apiKey: ref.provider.apiKey, type: ref.provider.type },
      messages,
      extras,
      stream: false,
      imageCapable: canGenerateImages(ref.model)
    }, { expect: 'text', nodeId: target?.node.id });

    const images = slots.images?.status === 'ok' ? (slots.images?.value ?? []) : [];
    const text = slots.text?.status === 'ok' ? (slots.text?.value ?? '') : '';
    const usable = text.trim() || (slots.text?.status === 'ok') || images.length > 0;
    if (slots.error || !usable) {
      const reason = slots.error?.reason
        ?? slots.text?.reason
        ?? (slots.error?.value ?? 'failed');
      return { ok: false, reason: 'failed', message: String(reason ?? '') };
    }

    if (target) {
      // Update the original node: attach pictures (illustrate) or replace the
      // chapter content (text answer). Both version the node in place.
      const saved = await this.applyToTarget(
        chatId, target.node, target.mode, text, images,
        slots.thinking?.value ?? '', slots.usage?.value ?? undefined
      );
      if (slots.logEntry && saved.id !== target.node.id) {
        this.llmLog.retargetNode(slots.logEntry, saved.id);
      }
      return {
        ok: true,
        answerNodeId: saved.id,
        images: images.length,
        chatId,
        applied: target.mode === 'replace' ? 'replaced' : 'attached',
      };
    }

    // No attributable node: add the response as a brand-new chapter at the end
    // of the chat. Nothing was created before the call, so a failure leaves no
    // partial nodes behind.
    const directionText = this.lastUserText(messages)
      || (messages.length > 0 ? messageText(messages[messages.length - 1]) : '')
      || 'Continue.';
    const path = newestPathOf(nodes);
    const leaf = path.at(-1) ?? null;

    let questionId: string | null = null;
    let reusedDraft = false;
    try {
      // Direction node: reuse the chat's empty composer when it is the leaf.
      if (isEmptyComposer(leaf)) {
        const saved = await this.chat.persistQuestion(
          chatId, leaf!.id, directionText, undefined, ref.model.modelId, ref.model.providerId
        );
        questionId = saved.id;
        reusedDraft = true;
      } else {
        const q = await this.chat.addNode(chatId, {
          parentId: leaf?.id ?? null,
          role: 'user',
          content: directionText,
          modelId: ref.model.modelId,
          providerId: ref.model.providerId
        });
        questionId = q.id;
        this.chat.setActiveChild(leaf?.id ?? null, q.id);
      }

      const answer = await this.chat.addNode(chatId, {
        parentId: questionId,
        role: 'assistant',
        content: '',
        thinking: '',
        modelId: ref.model.modelId,
        providerId: ref.model.providerId
      });
      this.chat.setActiveChild(questionId, answer.id);

      const attachments = generatedImageAttachments(images);
      const saved = await this.chat.editAssistant(
        chatId, answer.id, text, attachments,
        slots.thinking?.value ?? '', slots.usage?.value ?? undefined
      );
      // The call was recorded without a node id (nothing existed yet) — point
      // its usage at the node that is actually kept.
      if (slots.logEntry && saved.id !== answer.id) {
        this.llmLog.retargetNode(slots.logEntry, saved.id);
      }
      return { ok: true, answerNodeId: saved.id, images: attachments.length, chatId, applied: 'chapter' };
    } catch (err) {
      // Persistence failed AFTER a successful call — remove the partial nodes.
      try {
        if (questionId) {
          if (reusedDraft) await this.chat.patchNode(chatId, questionId, { content: '' });
          else await this.chat.purgeBranch(chatId, questionId);
        }
      } catch { /* best-effort */ }
      throw err;
    }
  }

  /**
   * Write the re-sent response back into the ORIGINAL node the call was
   * attributed to. `replace` sets the node's content to the new answer text
   * (preserving attachments + adding any new pictures); `attach` keeps the
   * content and only appends the new pictures (illustrate / re-render).
   */
  private async applyToTarget(
    chatId: string,
    node: ChatNode,
    mode: 'replace' | 'attach',
    text: string,
    images: LlmImagePart[],
    thinking: string,
    usage: NodeUsageSummary | undefined
  ): Promise<ChatNode> {
    const attachments = this.mergeGeneratedAttachments(node.attachments, images);
    const content = mode === 'attach' ? node.content : text;
    return this.versionNode(chatId, node, content, attachments, thinking, usage);
  }

  /** Version the node in place — `editUser` for user nodes, `editAssistant` otherwise. */
  private versionNode(
    chatId: string,
    node: ChatNode,
    content: string,
    attachments: NodeAttachment[] | undefined,
    thinking: string,
    usage: NodeUsageSummary | undefined
  ): Promise<ChatNode> {
    if (node.role === 'user') {
      return this.chat.editUser(chatId, node.id, content, attachments);
    }
    return this.chat.editAssistant(chatId, node.id, content, attachments, thinking, usage);
  }

  /**
   * Existing attachments of a node + the newly generated pictures, with the
   * new illustrations numbered after the existing ones so names stay unique.
   */
  private mergeGeneratedAttachments(
    existing: NodeAttachment[] | undefined,
    newImages: LlmImagePart[]
  ): NodeAttachment[] | undefined {
    const kept = existing ?? [];
    const existingGenerated = kept.filter(a => isGeneratedImageAttachment(a)).length;
    const fresh = generatedImageAttachments(newImages, existingGenerated);
    if (kept.length === 0 && fresh.length === 0) return undefined;
    return [...kept, ...fresh];
  }

  /**
   * The node a log entry should write back to, when its use case + recorded
   * `nodeId` point at a node that still exists (as the current version of a
   * possibly-versioned chain). `null` = no attributable target → the response
   * is appended as a new chapter instead.
   */
  private resolveTargetNode(
    nodes: ChatNode[],
    entry: LlmLogEntry
  ): { node: ChatNode; mode: 'replace' | 'attach' } | null {
    if (!entry.nodeId || !entry.usecase) return null;
    const mode = IMAGE_USECASES.has(entry.usecase)
      ? 'attach'
      : TEXT_ANSWER_USECASES.has(entry.usecase)
        ? 'replace'
        : null;
    if (!mode) return null;
    const node = currentVersionOf(nodes, entry.nodeId);
    if (!node) return null;
    if (node.role !== 'assistant' && node.role !== 'user') return null;
    return { node, mode };
  }

  /** Text of the last USER message (the direction) in the resend payload. */
  private lastUserText(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const t = messageText(messages[i]);
        if (t.trim()) return t.trim();
      }
    }
    return '';
  }

  /** Request extras kept from the original body (minus transport fields). */
  private extrasFrom(entry: LlmLogEntry): Record<string, unknown> {
    const body = entry.body as Record<string, unknown> | undefined;
    if (!body) return {};
    const skip = new Set(['model', 'messages', 'stream', 'modalities', 'stream_options', 'n']);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!skip.has(k)) out[k] = v;
    }
    return out;
  }
}

/** True when the node is an empty composer (unsent direction) under an answer. */
function isEmptyComposer(n: ChatNode | null): boolean {
  return !!n && n.role === 'user' && !n.content?.trim() && !(n.attachments?.length);
}

/**
 * The CURRENT version of a (possibly versioned) node chain that a logged id
 * belongs to: walk the `previousVersionId` links of every current node until
 * the logged id is reached, and return the current node. Falls back to the
 * exact id when it is itself current.
 */
function currentVersionOf(nodes: ChatNode[], loggedId: string | undefined): ChatNode | null {
  if (!loggedId) return null;
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (!n.isCurrent) continue;
    let cur: ChatNode | undefined = n;
    while (cur) {
      if (cur.id === loggedId) return n;
      cur = cur.previousVersionId ? byId.get(cur.previousVersionId) : undefined;
    }
  }
  return byId.get(loggedId) ?? null;
}

/**
 * The active path of a chat as a pure function over a node list: walk the
 * NEWEST child at every level (mirrors `ChatTreeReaderService`'s fallback,
 * which is what `restoreMostRecentPath` uses). Used for the resend target
 * chat without mutating the global active-child map.
 */
function newestPathOf(nodes: ChatNode[]): ChatNode[] {
  const byParent = new Map<string, ChatNode[]>();
  for (const n of nodes) {
    if (!n.isCurrent) continue;
    const key = n.parentId ?? '';
    const arr = byParent.get(key) ?? [];
    arr.push(n);
    byParent.set(key, arr);
  }
  const newest = (parentId: string): ChatNode | null => {
    const arr = byParent.get(parentId) ?? [];
    if (!arr.length) return null;
    return arr.reduce((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0;
      const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0;
      return ta >= tb ? a : b;
    });
  };
  const path: ChatNode[] = [];
  let cur = newest('');
  while (cur) {
    path.push(cur);
    cur = newest(cur.id);
  }
  return path;
}

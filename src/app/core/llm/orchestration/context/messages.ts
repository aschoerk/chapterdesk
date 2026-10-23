import { Injectable, inject } from '@angular/core';
import { Chat, ChatMessage, ChatNode } from '../../../../models/chat';
import { ChatService } from '../../../chat/chat.service';
import { PromptDefaultsService } from '../../../prompts/prompt-defaults.service';
import { ProjectService } from '../../../settings/project.service';
import {
  isImageMime,
  messageText,
  nodeToMessageContent,
  resolvedMime
} from '../../llm-message';
import {
  IMAGE_DESCRIPTION_RECORD,
  imageSetSignature,
  isImageDescriptionRecord,
  parseStoredImageDescription,
  type NodeAttachmentLike
} from './types';
import { ContextTopicService } from './topic';

/**
 * MESSAGE / CONTEXT building for a use case: the chat-thread messages a model
 * sees (full, windowed, text-only, with topic system prompt), PLUS the
 * image-interpretation rule (when attached images are described, and the
 * record that marks them as already-interpreted). Depends only on the chat
 * tree (ChatService), the topic scope and prompt defaults — no model
 * resolution (that is `models.ts`) and no prompt-template building besides
 * the interpret prompt plus the topic-system prompt (both prompt-defaults).
 */
@Injectable({ providedIn: 'root' })
export class ContextMessageBuilderService {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly topicService = inject(ContextTopicService);

  // -------------------------------------------------- context messages

  /** Context messages up to (and including) the node on the active path. */
  buildContextMessagesUpTo(chatId: string, nodeId: string | null): ChatMessage[] {
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    const out: ChatMessage[] = [];
    for (const n of path) {
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      // Meta/excluded nodes (auto-continue, elaborate instructions, lore
      // documentation) are shown in the UI but never re-shipped as history.
      // The FINAL node is excluded from this rule: it is the question being
      // answered and is always sent (see buildSendMessagesEx).
      if (n.id !== nodeId && n.excludeFromContext) continue;
      const content = nodeToMessageContent(n);
      if (!content) continue;
      out.push({ role: n.role, content });
    }
    return out;
  }

  /**
   * Context messages from the last `assistantCount` ASSISTANT beats of the
   * active path up to (and including) `nodeId` — a bounded window instead of
   * the complete chat. The window size is measured in ASSISTANT nodes only
   * ("last N beats" = the last N chapters; a chapter's own user direction
   * travels with it but never counts toward N). The same filtering as
   * {@link buildContextMessagesUpTo} applies (excluded / empty-content nodes
   * are skipped). An `assistantCount` of 0 keeps NO preceding beat (the
   * caller appends the current node's own text as the anchor).
   */
  buildContextMessagesWindow(chatId: string, nodeId: string | null, assistantCount: number): ChatMessage[] {
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    if (!assistantCount || assistantCount <= 0) return [];
    // The window keeps the LAST `assistantCount` assistant chapters. Anything
    // before the window boundary (leading assistant beats there are too old to
    // count) is excluded; the slice begins right after it, so the first kept
    // assistant brings its own direction into the window.
    const assistants = path.reduce((n, node) => n + (node.role === 'assistant' ? 1 : 0), 0);
    const skip = Math.max(0, assistants - assistantCount);
    let startIdx = 0;
    if (skip > 0) {
      let skipped = 0;
      for (let i = 0; i < path.length; i++) {
        if (path[i].role === 'assistant') {
          skipped += 1;
          if (skipped === skip) { startIdx = i + 1; break; }
        }
      }
    }
    const slice = path.slice(startIdx);
    const out: ChatMessage[] = [];
    for (const n of slice) {
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      if (n.id !== nodeId && n.excludeFromContext) continue;
      const content = nodeToMessageContent(n);
      if (!content) continue;
      out.push({ role: n.role, content });
    }
    return out;
  }

  /** Strip media parts → text-only messages (for text planning/rendering). */
  textOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return m;
      const text = messageText(m).trim();
      return { role: m.role, content: text };
    });
  }

  /**
   * The FULL chat up to (and including) the current node as normal messages,
   * with the current node's text as the final USER message. Used by the
   * `append` use case (normal send + history). When `contentOverride` is
   * given (e.g. a composer draft), it replaces the current node's content.
   * The final node is ALWAYS included (even when empty, the override or an
   * empty user turn is still the question being answered).
   */
  buildSendMessages(chatId: string, nodeId: string | null, contentOverride?: string): ChatMessage[] {
    return this.buildSendMessagesEx({ chatId, nodeId, contentOverride });
  }

  /**
   * Extended variant of {@link buildSendMessages}: supports injecting extra
   * user message(s) immediately BEFORE the final question. The topic system
   * prompt is only injected once when the thread has none.
   *
   * HISTORY IS ALWAYS TEXT-ONLY: images/files attached to past nodes are never
   * sent to the LLM. They are only ever visible as their auto-generated
   * textual description inside the node content (see `append-with-images`),
   * so the binaries never leak into a request.
   */
  buildSendMessagesEx(opts: {
    chatId: string;
    nodeId: string | null;
    contentOverride?: string;
    /** Extra messages inserted right before the final user question. */
    beforeFinal?: ChatMessage[];
  }): ChatMessage[] {
    const { chatId, nodeId, contentOverride, beforeFinal } = opts;
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    const out: ChatMessage[] = [];
    // All nodes EXCEPT the final one — Empties are dropped. History nodes are
    // reduced to TEXT (image_url/file parts stripped) so attached images are
    // never re-sent; the content that carries their description survives.
    for (let i = 0; i < path.length - 1; i++) {
      const n = path[i];
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      // Excluded meta / lore-documentation nodes are skipped in history. The
      // final node is always included (it is the question being answered), so
      // an auto-excluded continue/elaborate direction is still sent exactly
      // once while it is the current question.
      if (n.excludeFromContext) continue;
      const text = messageText({ role: n.role, content: nodeToMessageContent(n) }).trim();
      if (!text) continue;
      out.push({ role: n.role, content: text });
    }
    // Optional in-between context (e.g. the auto-generated image description).
    if (beforeFinal) {
      for (const m of beforeFinal) {
        const text = typeof m.content === 'string' ? m.content.trim() : '';
        if (text) out.push({ role: 'user', content: text });
      }
    }
    // The final node is the question — always included.
    const last = path[path.length - 1];
    if (last && last.chatId === chatId) {
      // Text attachments are inlined into the FINAL user message too, mirroring
      // the history rule, so a text file attached to the current question is
      // actually sent. Binary/image parts stay excluded: the writing path is
      // text-only (hand-attached images are interpreted up front instead).
      const hasOverride = contentOverride !== undefined && contentOverride !== null;
      const override = (contentOverride ?? '').trim();
      const fullText = messageText({ role: last.role, content: nodeToMessageContent(last) }).trim();
      const ownText = (last.content ?? '').trim();
      let finalText: string;
      if (hasOverride) {
        // Keep the override (e.g. typed draft or interpreted text), then append
        // any inlined text attachments so they are not lost on the leaf.
        finalText = override;
        if (ownText && fullText.startsWith(ownText)) {
          const suffix = fullText.slice(ownText.length).trim();
          if (suffix) finalText = `${finalText}\n\n${suffix}`;
        } else if (fullText) {
          finalText = `${finalText}\n\n${fullText}`;
        }
      } else {
        finalText = fullText;
      }
      // An empty director is still a valid user turn (the model sees it and
      // answers from history), but as a bare user message.
      const user: ChatMessage = { role: 'user', content: finalText || '(no text)' };
      out.push(user);
    }
    // Topic system-prompt parity (legacy streamAnswer.withTopicSystemPrompt):
    // inject the topic's defaultSystemPrompt when the thread has none. Done at
    // the REQUEST BUILDER so every text use case gets the topic voice, not
    // just `append`.
    if (!out.some(m => m.role === 'system')) {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      const sys = this.topicSystemPrompt(chat);
      if (sys) out.unshift({ role: 'system', content: sys });
    }
    return out;
  }

  /** Topic system prompt for a chat (reuses legacy helper conceptually). */
  topicSystemPrompt(chat: Chat | null): string | null {
    const projectId = chat?.projectId;
    if (!projectId) return null;
    const parts = this.projectService.topics()
      .filter(t => t.projectIds?.includes(projectId) && t.defaultSystemPrompt?.trim())
      .map(t => t.defaultSystemPrompt.trim());
    return parts.length ? parts.join('\n\n') : null;
  }

  // -------------------------------------------------- image interpretation

  /** The image-interpret prompt template (image.interpret default/override). */
  imageInterpretPrompt(): string {
    return this.promptDefaults.effective('image.interpret', this.topicService.promptTopic);
  }

  /**
   * The image attachments of a node/draft that should be interpreted:
   * data-URL images only (the only ones the client can send to a model).
   */
  imageAttachments(attachments: NodeAttachmentLike[] | undefined | null): NodeAttachmentLike[] {
    return (attachments ?? []).filter(
      a => isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:')
    );
  }

  /**
   * Build the message for the image-interpret call: the interpret prompt as
   * text + every attached image as an image_url part — the writing model
   * never sees the raw binaries.
   */
  buildInterpretMessage(images: NodeAttachmentLike[]): ChatMessage[] {
    // nodeToMessageContent only needs content + attachments; hand-attached
    // images become image_url parts (prompt-record meta is filtered out).
    const content = nodeToMessageContent({
      content: this.imageInterpretPrompt(),
      attachments: images as ChatNode['attachments']
    } as Pick<ChatNode, 'content' | 'attachments'>);
    return [{ role: 'user', content }];
  }

  /**
   * THE image-interpretation rule: images are interpreted ONLY when their
   * descriptions have NOT been stored in the node yet. A node "has stored
   * them" when it carries an `image-description.txt` record whose image
   * signature matches its current data: attachments AND its content already
   * ends with the stored description (the description was merged into the
   * text on a previous send). This prevents re-interpreting + re-merging on
   * every re-send (regenerate / rewrite / branch of an already-interpreted
   * direction).
   *
   * @param node the user node being sent
   * @param draftImages the attachments of the current draft (when editing),
   *   else the node's own attachments.
   */
  needsImageInterpretation(
    node: Pick<ChatNode, 'content' | 'attachments'>,
    draftImages?: NodeAttachmentLike[] | null
  ): boolean {
    const images = this.imageAttachments(draftImages ?? node.attachments);
    if (images.length === 0) return false;
    const stored = parseStoredImageDescription(node.attachments);
    if (!stored || !stored.description.trim()) return true;
    const sig = imageSetSignature(images);
    if (JSON.stringify(sig) !== JSON.stringify([...(stored.images ?? [])].sort())) return true;
    // The description must actually be part of the stored text.
    const content = (node.content ?? '').trim();
    return !content.includes(stored.description.trim());
  }

  /**
   * Build the stored image-description record attachment. It is a text
   * record (like prompt-N.txt) that is EXCLUDED from LLM context, so it never
   * travels to a model — it only marks "these images were interpreted and
   * their description is part of this node's text".
   */
  buildImageDescriptionRecord(
    images: NodeAttachmentLike[],
    description: string
  ): NodeAttachmentLike {
    const rec = { images: imageSetSignature(images), description };
    return {
      id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: IMAGE_DESCRIPTION_RECORD,
      mimeType: 'text/plain',
      size: description.length + rec.images.length * 32,
      dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(JSON.stringify(rec))}`
    };
  }

  /**
   * Merge a fresh image description into the direction text (no UI prefix) —
   * the exact text that is sent to the writing model and persisted on the
   * node so it lives in the history.
   */
  mergeDirectionWithDescription(directionText: string, description: string): string {
    const dir = (directionText ?? '').trim();
    const desc = (description ?? '').trim();
    if (!desc) return dir;
    return dir ? `${dir}\n\n${desc}` : desc;
  }

  /** Drop a stored image-description record from an attachment list. */
  withoutImageDescriptionRecord(attachments: NodeAttachmentLike[] | undefined | null): NodeAttachmentLike[] {
    return (attachments ?? []).filter(a => !isImageDescriptionRecord(a));
  }
}
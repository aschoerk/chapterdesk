import { Injectable, inject } from '@angular/core';
import { ChatNode, NodeAttachment } from '../../models/chat';
import { isImageMime, resolvedMime } from '../llm/llm-message';
import { ChatService } from './chat.service';

/** One image attachment found in a chat, with the node it lives on. */
export interface ChatImageEntry {
  /** The image attachment itself (data URL + name + mime). */
  attachment: NodeAttachment;
  /** Id of the node the image is attached to. */
  nodeId: string;
  /** Role of the node the image is attached to. */
  nodeRole: ChatNode['role'];
  /** Short human-readable label for the node (first line of its content). */
  nodeLabel: string;
}

/** First line of a node's content, trimmed, capped for display. */
function nodeLabel(node: ChatNode): string {
  const text = (node.content ?? '').trim();
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return node.role === 'user' ? 'Direction' : 'Chapter';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

/**
 * Collects the images that are attached to nodes of the current chat, so the
 * Illustrate / Create-image dialogs can offer them as reference images ("add
 * images found in the current chat, so the model can use them as reference").
 */
@Injectable({ providedIn: 'root' })
export class ChatImagesService {
  private readonly chatService = inject(ChatService);

  /** All image attachments in the CURRENT chat, in node order. */
  imagesInCurrentChat(): ChatImageEntry[] {
    const chatId = this.chatService.currentChatId();
    if (!chatId) return [];
    return this.imagesInChat(chatId);
  }

  /** All image attachments in `chatId`, in node order. */
  imagesInChat(chatId: string): ChatImageEntry[] {
    const out: ChatImageEntry[] = [];
    for (const node of this.chatService.nodes()) {
      if (node.chatId !== chatId) continue;
      for (const a of node.attachments ?? []) {
        if (!isImageMime(resolvedMime(a))) continue;
        out.push({
          attachment: a,
          nodeId: node.id,
          nodeRole: node.role,
          nodeLabel: nodeLabel(node)
        });
      }
    }
    return out;
  }
}
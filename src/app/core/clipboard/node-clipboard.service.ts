import { Injectable, computed, inject, signal } from '@angular/core';
import { Chat, ChatNode, NodeAttachment, NodeRole } from '../../models/chat';
import { ChatService } from '../chat/chat.service';

/**
 * Client-side clipboard for ChatNodes.
 *
 * Lets the user copy / cut a section (or a section with its whole following
 * text) and paste it into another place of the same chat or into a different
 * chat on the same client. The payload survives reloads/chat switches via
 * localStorage — it never leaves the browser.
 *
 * Paste semantics: the copied subtree is re-created node by node under the
 * chosen target parent, remapping parent pointers (same replay logic as the
 * bundle importer). Only the current content is copied; version history
 * (previousVersionId) is intentionally not carried over.
 */
export type ClipboardAction = 'copy' | 'cut';

const LS_KEY = 'chat.nodeClipboard.v1';
const FORMAT = 'chapterdesk.nodeClipboard';
const VERSION = 1;

/** Serializable node held on the clipboard. `id` is the source id and is only
 *  used to remap `parentId` when pasting. */
export interface ClipboardNode {
  id: string;
  parentId: string | null;
  role: NodeRole;
  content: string;
  thinking?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  attachments?: NodeAttachment[];
  chatParametersId?: string | null;
  /** Exclude from the LLM context (history) — see ChatNode.excludeFromContext. */
  excludeFromContext?: boolean;
  /** One-shot context node — see ChatNode.excludeAfterSend. */
  excludeAfterSend?: boolean;
}

export interface ClipboardEntry {
  format: typeof FORMAT;
  version: typeof VERSION;
  action: ClipboardAction;
  sourceChatId: string | null;
  nodes: ClipboardNode[];
}

/** Options for {@link NodeClipboardService.extractSequence}. */
export interface ExtractOptions {
  /** Title of the new story (default: the source story's title). */
  title?: string;
  /**
   * Also extract the VISIBLE SUBTREE: everything that hangs below the
   * selection on the active path (the visible continuation), so the new story
   * continues past the cut instead of stopping at it. Nodes in other branches
   * are never taken along — only what is visible.
   */
  withVisibleSubtree?: boolean;
}

function toClipboardNode(n: ChatNode): ClipboardNode {
  return {
    id: n.id,
    parentId: n.parentId,
    role: n.role,
    content: n.content ?? '',
    thinking: n.thinking ?? null,
    modelId: n.modelId ?? null,
    providerId: n.providerId ?? null,
    attachments: n.attachments ?? [],
    chatParametersId: n.chatParametersId ?? null,
    excludeFromContext: n.excludeFromContext ?? false,
    excludeAfterSend: n.excludeAfterSend ?? false,
  };
}

function isClipboardEntry(v: unknown): v is ClipboardEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<ClipboardEntry>;
  return (
    e.format === FORMAT &&
    e.version === VERSION &&
    (e.action === 'copy' || e.action === 'cut') &&
    Array.isArray(e.nodes)
  );
}

@Injectable({ providedIn: 'root' })
export class NodeClipboardService {
  private readonly chatService = inject(ChatService);

  /** The current clipboard payload (null = empty). */
  readonly clipboard = signal<ClipboardEntry | null>(this.readFromStorage());

  readonly hasContent = computed(() => this.clipboard() !== null);
  readonly count = computed(() => this.clipboard()?.nodes.length ?? 0);
  readonly rootRole = computed(() => this.clipboard()?.nodes[0]?.role ?? null);
  readonly action = computed(() => this.clipboard()?.action ?? null);

  private readFromStorage(): ClipboardEntry | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return isClipboardEntry(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private save(entry: ClipboardEntry | null): void {
    if (entry) {
      this.clipboard.set(entry);
      localStorage.setItem(LS_KEY, JSON.stringify(entry));
    } else {
      this.clipboard.set(null);
      localStorage.removeItem(LS_KEY);
    }
  }

  private collectSubtree(rootId: string): ChatNode[] {
    const all = this.chatService.nodes();
    const out: ChatNode[] = [];
    const walk = (id: string) => {
      const n = all.find((x) => x.id === id);
      if (!n) return;
      out.push(n);
      all.filter((x) => x.parentId === id).forEach((child) => walk(child.id));
    };
    walk(rootId);
    return out;
  }

  /** Copy a single node (without its following text/branch). */
  copy(node: ChatNode): void {
    this.save({
      format: FORMAT,
      version: VERSION,
      action: 'copy',
      sourceChatId: node.chatId,
      nodes: [toClipboardNode(node)],
    });
  }

  /** Copy a node plus its whole descendant subtree (the continuation). */
  copySubtree(node: ChatNode): void {
    this.save({
      format: FORMAT,
      version: VERSION,
      action: 'copy',
      sourceChatId: node.chatId,
      nodes: this.collectSubtree(node.id).map(toClipboardNode),
    });
  }

  /** Copy an ordered list of nodes WITHOUT their subtrees (navbar multi-selection). */
  copySequence(nodes: ChatNode[]): void {
    if (!nodes.length) return;
    this.save({
      format: FORMAT,
      version: VERSION,
      action: 'copy',
      sourceChatId: nodes[0].chatId,
      nodes: nodes.map(toClipboardNode),
    });
  }

  /** Cut a single node: copy it, then remove it (children stay in the thread). */
  async cut(node: ChatNode): Promise<void> {
    this.copy(node);
    await this.chatService.deleteNode(node.chatId, node.id, { keepChildren: true });
  }

  /** Cut a node + subtree: copy the continuation, then delete it entirely. */
  async cutSubtree(node: ChatNode): Promise<void> {
    this.copySubtree(node);
    await this.chatService.deleteNode(node.chatId, node.id);
  }

  /** Cut an ordered list of nodes (no subtrees): copy them, then remove each. */
  async cutSequence(nodes: ChatNode[]): Promise<void> {
    if (!nodes.length) return;
    this.copySequence(nodes);
    // Topmost-first (path order): children of a removed node attach to its parent.
    for (const node of nodes) {
      await this.chatService.deleteNode(node.chatId, node.id, { keepChildren: true });
    }
  }

  /**
   * EXTRACT: move a selected sequence into a NEW story.
   *
   * Unlike a plain cut (clipboard only) this creates a real new chat, copies
   * the source story's lore to it and re-creates the selected nodes there as
   * the story's starting chain. The original nodes are then removed from the
   * source story.
   *
   * Structural guarantees in the SOURCE story:
   *  – Only the extracted nodes are removed. Children in OTHER branches are
   *    never deleted (they may be parents of their own subtrees).
   *  – When the extracted sequence is not a complete subtree (i.e. some of its
   *    nodes have children outside the extraction), those dangling branches
   *    are re-hung under the PARENT OF THE FIRST EXTRACTED NODE, so the rest of
   *    the story keeps a valid, unsurprising structure.
   *
   * With `withVisibleSubtree` the extraction also takes the visible
   * continuation below the selection (the rest of the active path), so the new
   * story does not end at the cut.
   *
   * The clipboard is deliberately left EMPTY afterwards — extract is not a
   * clipboard operation, the content lives in the new story.
   *
   * Returns the new chat (null when there was nothing to extract).
   */
  async extractSequence(
    nodes: ChatNode[],
    options: ExtractOptions | string = {},
  ): Promise<Chat | null> {
    const opts: ExtractOptions =
      typeof options === 'string' ? { title: options } : options;
    if (!nodes.length) return null;
    const sourceChatId = nodes[0].chatId;
    const sourceChat = this.chatService.chats().find(c => c.id === sourceChatId);
    if (!sourceChat) return null;

    const extracted = opts.withVisibleSubtree
      ? this.withVisibleContinuation(nodes)
      : nodes;
    if (!extracted.length) return null;

    // Parent of the FIRST extracted node — the surviving anchor the dangling
    // branches are re-hung under.
    const anchorParentId = nodes[0].parentId ?? null;
    const extractedIds = new Set(extracted.map(n => n.id));

    // Compute the dangling branches BEFORE creating anything: `addNode`
    // appends the new story's nodes to the shared node state, and the dangling
    // lookup walks that state.
    const dangling = this.danglingChildren(extracted, extractedIds);

    // Snapshot in clipboard form so `createNodes` can remap the parent
    // pointers (same replay logic as paste).
    const entry: ClipboardEntry = {
      format: FORMAT,
      version: VERSION,
      action: 'copy',
      sourceChatId,
      nodes: extracted.map(toClipboardNode),
    };

    const newChat = await this.chatService.createChat(
      opts.title ?? sourceChat.title ?? 'Extracted story',
      sourceChat.projectId ?? null,
    );

    // Copy the story lore (the never-miss world facts) to the new story.
    const lore = sourceChat.lore;
    if (lore) {
      await this.chatService.patchChatMeta(newChat.id, { lore });
    }

    await this.createNodes(newChat.id, entry, null);

    // Re-hang the dangling branches BEFORE deleting anything: children of the
    // extracted set that are not part of it stay in this story. Doing this
    // explicitly (instead of relying on the per-node keepChildren cascade)
    // keeps the outcome independent of the deletion order.
    if (dangling.length) {
      await this.chatService.reparentNodes(
        sourceChatId,
        dangling.map(n => n.id),
        anchorParentId,
      );
    }

    // Remove the extracted nodes from the source story (their children are
    // either extracted too or already re-hung above).
    for (const node of extracted) {
      await this.chatService.deleteNode(sourceChatId, node.id, { keepChildren: true });
    }

    return newChat;
  }

  /**
   * The VISIBLE SUBTREE of a selection: the selected chain plus everything that
   * hangs below it on the ACTIVE PATH (the visible continuation). Other
   * branches are not visible and are therefore never included.
   */
  private withVisibleContinuation(nodes: ChatNode[]): ChatNode[] {
    const firstId = nodes[0]?.id;
    if (!firstId) return nodes;
    const path = this.chatService.getActivePath();
    const start = path.findIndex(n => n.id === firstId);
    if (start < 0) return nodes;
    const tail = path.slice(start);
    // The terminal empty direction is the user's input box, never content:
    // do not drag it into the new story.
    const last = tail[tail.length - 1];
    const visible =
      last && this.chatService.isDraftQuestion(last) ? tail.slice(0, -1) : tail;
    if (!visible.length) return nodes;
    // Safety net: only extend when the selection really is a sub-chain of the
    // visible continuation (it always should be for a navbar selection).
    const selectedIds = new Set(nodes.map(n => n.id));
    const covered = visible.filter(n => selectedIds.has(n.id)).length;
    return covered >= nodes.length ? visible : nodes;
  }

  /**
   * Children of the extracted set whose parent IS extracted but which are NOT
   * extracted themselves — the dangling branches that must survive in the
   * source story.
   */
  private danglingChildren(extracted: ChatNode[], extractedIds: Set<string>): ChatNode[] {
    const out: ChatNode[] = [];
    const seen = new Set<string>();
    for (const node of extracted) {
      for (const child of this.chatService.getChildren(node.id)) {
        if (extractedIds.has(child.id) || seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
      }
    }
    return out;
  }

  clear(): void {
    this.save(null);
  }

  /** Create the copied nodes as new nodes under `parentId`, remapping parent
   *  pointers so the copied chain/tree links are preserved. Returns the root,
   *  the last (deepest) created node and every created root id. */
  private async createNodes(
    chatId: string,
    entry: ClipboardEntry,
    parentId: string | null,
  ): Promise<{ root: ChatNode; last: ChatNode; rootIds: string[] } | null> {
    const idMap = new Map<string, string>();
    let root: ChatNode | null = null;
    let last: ChatNode | null = null;
    const rootIds: string[] = [];
    const pending = entry.nodes.slice();

    while (pending.length) {
      const idx = pending.findIndex((n) => !n.parentId || idMap.has(n.parentId));
      const node = pending.splice(idx < 0 ? 0 : idx, 1)[0];
      const parentKey = node.parentId ?? null;
      const isRoot = parentKey === null || !idMap.has(parentKey);
      const nodeParentId =
        parentKey !== null && idMap.has(parentKey) ? idMap.get(parentKey)! : parentId;

      const created = await this.chatService.addNode(chatId, {
        parentId: nodeParentId,
        role: node.role,
        content: node.content,
        thinking: node.thinking ?? undefined,
        modelId: node.modelId ?? undefined,
        providerId: node.providerId ?? undefined,
        excludeFromContext: node.excludeFromContext ?? undefined,
        excludeAfterSend: node.excludeAfterSend ?? undefined,
        attachments: node.attachments,
        chatParametersId: node.chatParametersId ?? null,
      });
      idMap.set(node.id, created.id);
      if (!root) root = created;
      last = created;
      if (isRoot) rootIds.push(created.id);
    }
    return root && last ? { root, last, rootIds } : null;
  }

  /**
   * Paste the clipboard in the currently selected chat.
   *
   * When `afterNodeId` is given, the pasted sequence is inserted right after
   * that sibling (its parent is the target parent). Otherwise the sequence is
   * appended under `targetParentId` (null = top of the story). Precise ordering
   * is persisted via a sibling reorder.
   */
  async paste(targetParentId: string | null, afterNodeId?: string | null): Promise<ChatNode | null> {
    const entry = this.clipboard();
    const chatId = this.chatService.currentChatId();
    if (!entry || !chatId) return null;

    const parentId = afterNodeId
      ? this.chatService.currentNodes().find(n => n.id === afterNodeId)?.parentId ?? null
      : targetParentId;

    const created = await this.createNodes(chatId, entry, parentId);
    if (!created) return null;
    const { root, rootIds } = created;

    // Insert the sequence after `afterNodeId` (or append at the end of the siblings).
    const siblings = this.chatService
      .getChildren(parentId)
      .filter((n) => !rootIds.includes(n.id))
      .map((n) => n.id);
    let insertAt = siblings.length;
    if (afterNodeId) {
      const i = siblings.findIndex((id) => id === afterNodeId);
      if (i >= 0) insertAt = i + 1;
    }
    const finalOrder = [
      ...siblings.slice(0, insertAt),
      ...rootIds,
      ...siblings.slice(insertAt),
    ];
    await this.chatService.reorderSiblings(chatId, parentId, finalOrder);
    this.chatService.setActiveChild(parentId, root.id);
    return root;
  }

  /**
   * Insert the clipboard chain into the ACTIVE PATH (linear reading order)
   * directly between the two visible nav-bar nodes around the paste button:
   *
   *     leftId → [chain] → rightId
   *
   * The chain's root hangs under `leftId` and `rightId` (the node that used to
   * follow `leftId`) is re-hung under the chain's LAST node, so the visible
   * navbar/tree keeps a continuous chain. When `rightId` is null the chain is
   * simply appended behind `leftId` (leftId → [chain]).
   */
  async insertIntoPath(leftId: string, rightId: string | null): Promise<ChatNode | null> {
    const entry = this.clipboard();
    const chatId = this.chatService.currentChatId();
    if (!entry || !chatId) return null;

    const created = await this.createNodes(chatId, entry, leftId);
    if (!created) return null;
    const { root } = created;

    // The right visible node continues under the chain's last node so the
    // active path stays continuous: leftId → chain → rightId.
    if (rightId && rightId !== leftId) {
      await this.chatService.reparentNodes(chatId, [rightId], created.last.id);
    }

    // Order the chain root first among leftId's children (persisted) and make
    // it the active continuation.
    const siblings = this.chatService.getChildren(leftId).map(n => n.id);
    const finalOrder = [root.id, ...siblings.filter(id => id !== root.id)];
    if (finalOrder.length > 1) {
      await this.chatService.reorderSiblings(chatId, leftId, finalOrder);
    }
    this.chatService.setActiveChild(leftId, root.id);
    return root;
  }

  /**
   * Append the clipboard chain as a PARALLEL BRANCH instead of splicing it
   * into the active path: the chain's root hangs under `leftId` and becomes a
   * sibling of the visible right node (both children of `leftId` — the visible
   * chain `leftId → rightId` is left untouched). Because the right node stays
   * the active continuation, the pasted chain is NOT visible in the navbar
   * when a right node exists. Only when pasted at the very end (no right node)
   * does the chain become the visible continuation of `leftId`.
   */
  async appendIntoPath(leftId: string, rightId: string | null): Promise<ChatNode | null> {
    const entry = this.clipboard();
    const chatId = this.chatService.currentChatId();
    if (!entry || !chatId) return null;

    const created = await this.createNodes(chatId, entry, leftId);
    if (!created) return null;
    const { root } = created;

    // The chain's root becomes a sibling of the visible right node — placed
    // right where the paste button sits (immediately before the right node),
    // or appended at the end of leftId's children when there is none.
    const siblings = this.chatService.getChildren(leftId).map(n => n.id);
    const finalOrder = siblings.filter(id => id !== root.id);
    let insertAt = finalOrder.length;
    if (rightId) {
      const i = finalOrder.indexOf(rightId);
      if (i >= 0) insertAt = i;
    }
    finalOrder.splice(insertAt, 0, root.id);
    if (finalOrder.length > 1) {
      await this.chatService.reorderSiblings(chatId, leftId, finalOrder);
    }

    // Only when pasted at the very end does the chain become the visible
    // continuation; otherwise the existing right node stays active.
    if (!rightId) {
      this.chatService.setActiveChild(leftId, root.id);
    }
    return root;
  }
}
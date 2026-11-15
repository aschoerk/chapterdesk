import { ChatNode } from '../../models/chat';

/**
 * PURE chat-lore helpers (no DI, no services) — the markers, the wrapped
 * content builder, and lore-node detection. Kept OUT of `chat-lore.service.ts`
 * so any service in the chat-tree dependency chain (reader / writer / …) can
 * use them WITHOUT creating a circular import: this module imports only the
 * node model.
 */

/**
 * Markers that wrap the raw chat-lore text when it is materialized as a node,
 * so the model unmistakably treats it as LORE/canon rather than story prose.
 */
export const LORE_NODE_PREFIX =
  '[Current chat-lore — fixed canon that must be respected and never contradicted]';
export const LORE_NODE_SUFFIX = '[/End of chat-lore]';

/**
 * Markers of the TEMPORARY lore section used by the Elaborate dialog: the
 * matching chapter description (+ n following ones) of the chapter plan. It is
 * shipped with ONE send only, exactly like the lore node itself.
 */
export const LORE_EXTRA_PREFIX =
  '[Chapter plan for this chapter — fixed canon that must be respected]';
export const LORE_EXTRA_SUFFIX = '[/End of chapter plan]';

/**
 * Build the lore node content: the raw lore text wrapped in a prefix AND a
 * suffix, so the LLM accepts it as current chat-lore.
 *
 * `extra` is a TEMPORARY addition for this single send only (the Elaborate
 * dialog passes the matching chapter-plan slice: the chapter's description
 * plus the following ones). It gets its own wrapper so the model can tell the
 * permanent lore from the plan excerpt. Empty when both parts are empty.
 */
export function buildLoreNodeContent(
  lore: string | null | undefined,
  extra?: string | null
): string {
  const parts: string[] = [];
  const text = (lore ?? '').trim();
  if (text) parts.push(`${LORE_NODE_PREFIX}\n${text}\n${LORE_NODE_SUFFIX}`);
  const plan = (extra ?? '').trim();
  if (plan) parts.push(`${LORE_EXTRA_PREFIX}\n${plan}\n${LORE_EXTRA_SUFFIX}`);
  return parts.join('\n\n');
}

/**
 * True when a node is one of our materialized chat-lore nodes — either the
 * permanent lore part or the temporary chapter-plan section (a send may carry
 * only the plan when the chat has no lore text).
 *
 * A node is lore when its ROLE is `lore` (the post-migration form) OR when it
 * still carries the canon/plan markers (legacy `user`-role lore nodes, and
 * any node that has not been migrated yet).
 */
export function isChatLoreNode(
  node: Pick<ChatNode, 'role' | 'content'> | null | undefined
): boolean {
  if (!node || typeof node.content !== 'string') return false;
  if (node.role === 'lore') return true;
  if (node.role !== 'user') return false;
  const hasLore = node.content.includes(LORE_NODE_PREFIX) && node.content.includes(LORE_NODE_SUFFIX);
  const hasExtra = node.content.includes(LORE_EXTRA_PREFIX) && node.content.includes(LORE_EXTRA_SUFFIX);
  return hasLore || hasExtra;
}

/**
 * The PERMANENT lore text of a lore node — the raw facts between the canon
 * markers, with any TEMPORARY chapter-plan section stripped. Used to tell
 * whether two lore nodes carry the SAME canon: the nav-bar shows only the
 * first appearance of each distinct lore text and hides identical repeats
 * until the content changes. Returns '' when the node carries no permanent
 * lore (a plan-only node).
 */
export function loreTextOf(
  node: Pick<ChatNode, 'role' | 'content'> | null | undefined
): string {
  if (!node || typeof node.content !== 'string') return '';
  const start = node.content.indexOf(LORE_NODE_PREFIX);
  if (start < 0) {
    // A role-'lore' node without the legacy markers (content kept raw) is
    // itself the lore text.
    return node.role === 'lore' ? node.content.trim() : '';
  }
  const after = start + LORE_NODE_PREFIX.length;
  const end = node.content.indexOf(LORE_NODE_SUFFIX, after);
  if (end < 0) return '';
  return node.content.slice(after, end).trim();
}
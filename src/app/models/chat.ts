export type NodeRole = 'system' | 'user' | 'assistant' | 'structural';

/**
 * Normalized, provider-agnostic token usage / cost of one LLM call. Mirrors
 * the server's `NodeUsageSummary` and the normalized `ParsedUsage` figures
 * parsed from provider usage blocks (`src/app/core/llm/usage.ts`).
 */
export interface NodeUsageSummary {
  /** Prompt / input tokens. */
  input?: number;
  /** Completion / output tokens. */
  output?: number;
  /** Cached (prompt-cache hit) input tokens, when the provider reports them. */
  cached?: number;
  /** Total tokens, when the provider reports them. */
  total?: number;
  /** Total USD cost of the call, when the provider reports it. */
  cost?: number;
}

export interface Project {
  id: string;
  name: string;
  greeting: string;
  systemPrompt: string;
  defaultModelId: string | null;
  chatParametersId?: string | null;
  avatar: string;
  personaIds: string[];
  /** Required primary topic this environment belongs to. */
  mainTopicId?: string | null;
  topicIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Topic {
  id: string;
  name: string;
  description: string;
  defaultModelId: string | null;
  chatParametersId?: string | null;
  defaultSystemPrompt: string;
  icon: string;
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  title: string;
  projectId?: string | null;
  chatParametersId?: string | null;
  /** Per-story lore: a small text of never-miss world facts, editable from the chat UI. */
  lore?: string | null;
  /** When true, newly created direction nodes are automatically excluded from the LLM context after they were sent the first time. */
  autoExcludeDirections?: boolean;
  node_number: number;
  created_at: string;
  updated_at: string;
  /** Summed input tokens over the current nodes of this chat (persisted server-side). */
  promptTokens?: number | null;
  /** Summed output tokens over the current nodes of this chat. */
  completionTokens?: number | null;
  /** Summed cached input tokens over the current nodes of this chat. */
  cachedTokens?: number | null;
  /** Summed total tokens over the current nodes of this chat. */
  totalTokens?: number | null;
  /** Summed USD cost over the current nodes of this chat. */
  totalCost?: number | null;
}

export interface NodeAttachment {
  id: string;           // local uuid
  name: string;         // original filename
  mimeType: string;     // e.g. "image/png", "application/pdf"
  size: number;         // bytes
  dataUrl: string;      // data:…;base64,…  (kept for images & small files)
}

export interface ChatNode {
  id: string;
  chatId: string;
  parentId: string | null;
  role: NodeRole;
  content: string;
  thinking?: string | null;
  modelId?: string | null;
  /** Cached (prompt-cache hit) input tokens, when the provider reported them. */
  cachedTokens?: number | null;
  /** Total tokens, when the provider reported them. */
  totalTokens?: number | null;
  /** Total USD cost of the call, when the provider reported it. */
  totalCost?: number | null;
  providerId?: string | null;
  version: number;
  previousVersionId?: string | null;
  isCurrent: boolean;
  createdAt: string;
  updatedAt?: string | null;
  /** When set, the node is in the trash (soft-deleted) and hidden from normal lists. */
  deletedAt?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  attachments?: NodeAttachment[];
  chatParametersId?: string | null;
  /** Position among its siblings (1-based). Older rows carry no position and sort after positioned ones. */
  position?: number | null;
  /** When set, the node is stored + shown but EXCLUDED from the message stream sent to the LLM while it is in history. The active (final) question is always sent regardless. */
  excludeFromContext?: boolean;
  /** One-shot: the node is included in the LLM context ONCE, then automatically marked `excludeFromContext` (used for the chat-lore node, which documents "sent once" then stops re-shipping). */
  excludeAfterSend?: boolean;
}

export interface CreateNodeRequest {
  parentId?: string | null;
  role: NodeRole;
  content: string;
  thinking?: string;
  modelId?: string;
  providerId?: string;
  attachments?: NodeAttachment[];
  chatParametersId?: string | null;
  /** Optional explicit position among siblings (used by multi-paste reordering). */
  position?: number | null;
  /** Exclude from the LLM context (history) — see ChatNode.excludeFromContext. */
  excludeFromContext?: boolean;
  /** One-shot context node — see ChatNode.excludeAfterSend. */
  excludeAfterSend?: boolean;
}

export interface Persona {
  id: string;
  name: string;
  shortName: string;
  description: string;
  avatar: string;
  /** Required primary topic this persona belongs to. */
  mainTopicId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Multimodal content accepted by modern chat APIs */
type MessageContent =
  | string
  | Array<{ type: string; text?: string; image_url?: { url: string } }>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}




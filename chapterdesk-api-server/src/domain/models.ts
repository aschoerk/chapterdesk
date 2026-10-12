export type NodeRole = 'system' | 'user' | 'assistant' | 'structural';

export interface NodeAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
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
  /** When true, a direction node is automatically excluded from the LLM context after it was sent the first time. */
  autoExcludeDirections?: boolean;
  node_number: number;
  created_at: string;
  updated_at: string;
}

export interface ChatNode {
  id: string;
  chatId: string;
  parentId: string | null;
  role: NodeRole;
  content: string;
  thinking?: string | null;
  modelId?: string | null;
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
  /** When set, the node is stored + shown but EXCLUDED from the message stream sent to the LLM (while it is in history — an auto-excluded continue/elaborate direction is still sent the first time it is the current question). */
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
  mainTopicId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatParameters {
  id: string;
  name: string;
  temperature: number | null;
  topK: number | null;
  topM: number | null;
  topP?: number | null;
  stream: boolean | null;
  thinking: boolean | null;
  thinkingLevel: ThinkingLevel | null;
  reasoningEffort?: ThinkingLevel | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatParametersDraft {
  name?: string;
  temperature: number | null;
  topK: number | null;
  topM: number | null;
  stream: boolean | null;
  thinking: boolean | null;
  thinkingLevel: ThinkingLevel | null;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openrouter' | 'openai' | 'custom';
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface ModelArchitecture {
  modality?: string;
  input_modalities: string[];
  output_modalities: string[];
  tokenizer?: string;
  instruct_type?: string | null;
}

export interface ModelEntry {
  id: string;
  displayName: string;
  modelId: string;
  providerId: string;
  type: 'fetched' | 'preset' | 'discontinued';
  enabled: boolean;
  chatParametersId?: string | null;
  object?: 'model';
  created?: number;
  ownedBy?: string;
  shutdownDate?: string | null;
  canonicalSlug?: string;
  description?: string;
  contextLength?: number;
  architecture?: ModelArchitecture;
  supportedParameters?: string[];
  pricing_prompt?: string;
  pricing_completion?: string;
  pricing_input_cache_read?: string;
  supported_parameters?: string[];
}

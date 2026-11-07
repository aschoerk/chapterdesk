import type { ModelArchitecture, ModelEntry, NodeAttachment, ProviderConfig, ReadingMark } from './models.js';

export interface CreateProjectRequest {
  name: string;
  greeting: string;
  systemPrompt?: string;
  defaultModelId?: string | null;
  chatParametersId?: string | null;
  avatar?: string;
  personaIds?: string[];
  mainTopicId?: string | null;
  topicId?: string | null;
  topicIds?: string[];
}

export type UpdateProjectRequest = Partial<{
  name: string;
  greeting: string;
  systemPrompt: string;
  defaultModelId: string | null;
  chatParametersId: string | null;
  avatar: string;
  personaIds: string[];
  mainTopicId: string | null;
  topicId: string | null;
  topicIds: string[];
  attachments: NodeAttachment[];
}>;

export interface PatchChatRequest {
  title?: string;
  projectId?: string | null;
  chatParametersId?: string | null;
  /** Per-story lore text (nullable to clear). */
  lore?: string | null;
  /** Per-chat mode: auto-exclude a direction node after it was sent the first time. */
  autoExcludeDirections?: boolean;
  /** Persistent reading marks (positions / selections + notes) — replaces the list. */
  readingMarks?: ReadingMark[];
  /** Names already handled by the "Replace names" dialog — replaces the list. */
  handledNames?: string[];
}

export interface BranchQuestionRequest {
  content: string;
  modelId?: string;
  providerId?: string;
  attachments?: NodeAttachment[];
}

export interface CreatePersonaRequest {
  name: string;
  shortName: string;
  description?: string;
  avatar?: string;
  mainTopicId?: string | null;
}

export type UpdatePersonaRequest = Partial<{
  name: string;
  shortName: string;
  description: string;
  avatar: string;
  mainTopicId: string | null;
}>;

export interface CreateTopicRequest {
  name: string;
  description?: string;
  defaultModelId?: string | null;
  chatParametersId?: string | null;
  defaultSystemPrompt?: string;
  icon?: string;
  projectIds?: string[];
}

export type UpdateTopicRequest = Partial<{
  name: string;
  description: string;
  defaultModelId: string | null;
  chatParametersId: string | null;
  defaultSystemPrompt: string;
  icon: string;
}>;

export type CreateProviderRequest = Omit<ProviderConfig, 'id'>;
export type UpdateProviderRequest = Partial<Omit<ProviderConfig, 'id'>>;

export interface CreateModelRequest {
  displayName: string;
  modelId: string;
  providerId: string;
  type: 'fetched' | 'preset' | 'discontinued';
  enabled: boolean;
  architecture?: ModelArchitecture;
  contextLength?: number;
  description?: string;
}

export type UpdateModelRequest = Partial<Omit<ModelEntry, 'id'>>;

export interface ToggleModelResponse {
  id: string;
  enabled: boolean;
}

export interface PatchNodeRequest {
  content?: string;
  thinking?: string;
  attachments?: NodeAttachment[];
  modelId?: string;
  providerId?: string;
  parentId?: string | null;
  position?: number | null;
  /** Exclude from the LLM context (history) — see ChatNode.excludeFromContext. */
  excludeFromContext?: boolean;
  /** One-shot context node — see ChatNode.excludeAfterSend. */
  excludeAfterSend?: boolean;
}

// ---------------------------------------------------------------------------
// Editable prompt templates (versioned, stored in the database).
// ---------------------------------------------------------------------------

export interface CreatePromptVersionRequest {
  promptId: string;
  name: string;
  text: string;
  scope: 'user' | 'topic';
  topicId?: string | null;
}

export type UpdatePromptVersionRequest = Partial<{
  name: string;
  text: string;
}>;

export interface SetPromptSelectionRequest {
  promptId: string;
  scope: 'user' | 'topic';
  topicId?: string | null;
  versionId: string;
}

// ---------------------------------------------------------------------------
// Name dictionary ("Replace names" dialog).
// ---------------------------------------------------------------------------

export interface CreateNameEntryRequest {
  name: string;
  language?: string | null;
  category?: 'male' | 'female' | 'surname' | 'place' | 'brand' | null;
  /** Legacy gender; when category is absent it is used to derive it. */
  gender?: 'male' | 'female' | null;
}

export type UpdateNameEntryRequest = Partial<{
  name: string;
  language: string | null;
  category: 'male' | 'female' | 'surname' | 'place' | 'brand' | null;
  gender: 'male' | 'female' | null;
}>;

/** Upsert a persisted replacement (same `from` + language overwrites `to`). */
export interface CreateNameReplacementRequest {
  from: string;
  to: string;
  language?: string | null;
}

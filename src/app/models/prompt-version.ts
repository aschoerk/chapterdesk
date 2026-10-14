/**
 * Editable prompt templates stored in the database (backend), versioned.
 *
 * A prompt template (e.g. `structure.title`) has a built-in default that lives
 * in `models/prompt-default.ts`. Users can store NAMED VERSIONS of a template
 * text in the database — either globally (`scope = 'user'`) or bound to one
 * topic (`scope = 'topic'`). The ACTIVE version is chosen by a selection:
 *
 *   user  → wins everywhere;
 *   topic → used when the chat belongs to a topic (its environment's main
 *           topic) and no user selection exists;
 *   none  → the built-in default.
 */

export type PromptScope = 'user' | 'topic';

/** A named, stored template text. */
export interface PromptVersion {
  id: string;
  /** Template id, e.g. `structure.title` (matches PromptDefaultDef.id). */
  promptId: string;
  /** User-chosen version name, e.g. "Dark style". */
  name: string;
  text: string;
  /** 'user' = global override; 'topic' = bound to topicId. */
  scope: PromptScope;
  /** Topic the version belongs to (null when scope = 'user'). */
  topicId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The active version for one (prompt, scope[, topic]). */
export interface PromptSelection {
  promptId: string;
  scope: PromptScope;
  topicId: string | null;
  versionId: string;
  updatedAt: string;
}

export interface CreatePromptVersionRequest {
  promptId: string;
  name: string;
  text: string;
  scope: PromptScope;
  topicId?: string | null;
}

export interface UpdatePromptVersionRequest {
  name?: string;
  text?: string;
}

export interface SetPromptSelectionRequest {
  promptId: string;
  scope: PromptScope;
  topicId?: string | null;
  versionId: string;
}
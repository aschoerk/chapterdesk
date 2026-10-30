/**
 * Versioned general texts stored in the database (backend).
 *
 * Long-form texts that shape the LLM context (topic system prompts,
 * environment definitions, environment greetings, persona descriptions) are
 * versioned in an append-only log. Whenever a tracked attribute actually
 * changes, the PREVIOUS content is recorded as a new version entry so the
 * history can be compared and restored.
 */

export type TextVersionEntityType = 'topic' | 'project' | 'persona';

export type TextVersionAttribute =
  | 'defaultSystemPrompt'
  | 'systemPrompt'
  | 'greeting'
  | 'description';

/** One recorded snapshot of a versioned text attribute. */
export interface TextVersion {
  id: string;
  /** Entity the text belongs to: 'topic' | 'project' | 'persona'. */
  entityType: TextVersionEntityType;
  entityId: string;
  /** Which field of the entity this version captures. */
  entityAttribute: TextVersionAttribute;
  /** 1-based version number, sequential per (entityType, entityId, entityAttribute). */
  versionNumber: number;
  /** When this version superseded / captured the recorded content. */
  datetime: string;
  /** The content that was active BEFORE the change (this version's snapshot). */
  oldContent: string;
}

export interface RestoreTextVersionResult {
  /** Entity / attribute the restored text belongs to. */
  entityType: TextVersionEntityType;
  entityId: string;
  entityAttribute: TextVersionAttribute;
  /** The content that is now active after restoration. */
  value: string;
  /** Newest version row recording the pre-restore content (null when unchanged). */
  undoVersion: TextVersion | null;
}

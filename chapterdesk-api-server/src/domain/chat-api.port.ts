import type {
  Chat,
  ChatNode,
  ChatParameters,
  ChatParametersDraft,
  CreateNodeRequest,
  ModelEntry,
  NameEntry,
  NameReplacement,
  NodeAttachment,
  NodeUsageSummary,
  Persona,
  Project,
  PromptScope,
  PromptSelection,
  PromptVersion,
  ProviderConfig,
  RestoreTextVersionResult,
  TextVersion,
  TextVersionAttribute,
  TextVersionEntityType,
  Topic
} from './models.js';
import type {
  BranchQuestionRequest,
  CreateModelRequest,
  CreateNameEntryRequest,
  CreateNameReplacementRequest,
  CreatePersonaRequest,
  CreateProjectRequest,
  CreatePromptVersionRequest,
  CreateProviderRequest,
  CreateTopicRequest,
  PatchChatRequest,
  PatchNodeRequest,
  SetPromptSelectionRequest,
  ToggleModelResponse,
  UpdateModelRequest,
  UpdateNameEntryRequest,
  UpdatePersonaRequest,
  UpdateProjectRequest,
  UpdateProviderRequest,
  UpdatePromptVersionRequest,
  UpdateTopicRequest
} from './requests.js';

/**
 * Same contract as src/app/api/chat-api.port.ts in the Angular app.
 */
export interface ChatApiPort {
  getProjects(): Promise<Project[]>;
  createProject(data: CreateProjectRequest): Promise<Project>;
  updateProject(id: string, data: UpdateProjectRequest): Promise<Project>;
  deleteProject(id: string, deleteChats?: boolean): Promise<void>;

  getChats(): Promise<Chat[]>;
  searchChatIds(q: string): Promise<string[]>;
  createChat(title: string, projectId?: string | null): Promise<Chat>;
  cloneChat(chatId: string): Promise<Chat>;
  deleteChat(id: string): Promise<void>;
  patchChat(id: string, data: PatchChatRequest): Promise<Chat>;

  getNodes(chatId: string): Promise<ChatNode[]>;
  createNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode>;
  /** Reorder siblings under a parent by assigning positions in the given order. */
  reorderSiblings(
    chatId: string,
    parentId: string | null,
    orderedNodeIds: string[],
  ): Promise<ChatNode[]>;
  editAssistant(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
    thinking?: string,
    /** Normalized token usage / cost of the call that produced this answer
     *  (persisted onto the node so per-node + per-chat figures survive
     *  reloads / other browsers). Absent for manual edits. */
    usage?: NodeUsageSummary,
  ): Promise<ChatNode>;
  editUser(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode>;
  branchUser(chatId: string, nodeId: string, data: BranchQuestionRequest): Promise<ChatNode>;
  patchNode(chatId: string, nodeId: string, data: PatchNodeRequest): Promise<ChatNode>;
  /**
   * Persist per-node token usage / cost onto the current nodes of a chat (in
   * place, WITHOUT versioning) and recompute + store the chat's summed totals
   * from those nodes. Returns the updated chat. Used by the sidebar's "Σ"
   * button to backfill the server from the browser LLM log.
   */
  saveChatUsage(
    chatId: string,
    nodes: { nodeId: string; usage?: NodeUsageSummary }[],
  ): Promise<Chat>;
  deleteNode(chatId: string, nodeId: string, options?: { keepChildren?: boolean }): Promise<void>;
  /** Deleted branch roots (soft-deleted nodes whose parent is not deleted). */
  getDeletedNodes(chatId: string): Promise<ChatNode[]>;
  /** Move a soft-deleted branch back into the live tree. */
  restoreNode(chatId: string, nodeId: string): Promise<void>;
  /** Permanently remove a soft-deleted branch and all its descendants. */
  purgeNode(chatId: string, nodeId: string): Promise<void>;

  getPersonas(): Promise<Persona[]>;
  createPersona(data: CreatePersonaRequest): Promise<Persona>;
  updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona>;
  deletePersona(id: string): Promise<void>;

  getTopics(): Promise<Topic[]>;
  createTopic(data: CreateTopicRequest): Promise<Topic>;
  updateTopic(id: string, data: UpdateTopicRequest): Promise<Topic>;
  deleteTopic(id: string): Promise<Topic | void>;
  addProjectToTopic(topicId: string, projectId: string): Promise<Topic>;
  removeProjectFromTopic(topicId: string, projectId: string): Promise<Topic>;

  getProviders(): Promise<ProviderConfig[]>;
  createProvider(data: CreateProviderRequest): Promise<ProviderConfig>;
  updateProvider(id: string, data: UpdateProviderRequest): Promise<ProviderConfig>;
  deleteProvider(id: string): Promise<void>;

  getModels(): Promise<ModelEntry[]>;
  createModel(data: CreateModelRequest): Promise<ModelEntry>;
  updateModel(id: string, data: UpdateModelRequest): Promise<ModelEntry>;
  deleteModel(id: string): Promise<void>;
  toggleModelEnabled(id: string): Promise<ToggleModelResponse>;

  getChatParameters(): Promise<ChatParameters[]>;
  getChatParameter(id: string): Promise<ChatParameters>;
  createChatParameters(data: ChatParametersDraft): Promise<ChatParameters>;
  updateChatParameters(id: string, data: ChatParametersDraft): Promise<ChatParameters>;
  deleteChatParameters(id: string): Promise<void>;

  // Editable prompt templates (versioned, stored in the database).

  /** All stored prompt versions (user + every topic). */
  getPromptVersions(): Promise<PromptVersion[]>;
  createPromptVersion(data: CreatePromptVersionRequest): Promise<PromptVersion>;
  updatePromptVersion(id: string, data: UpdatePromptVersionRequest): Promise<PromptVersion>;
  deletePromptVersion(id: string): Promise<void>;
  /** All active prompt selections (user + every topic). */
  getPromptSelections(): Promise<PromptSelection[]>;
  /** Upsert the active version for (promptId, scope, topicId). */
  setPromptSelection(data: SetPromptSelectionRequest): Promise<PromptSelection>;
  /** Clear the active version for (promptId, scope, topicId) → falls through. */
  deletePromptSelection(
    promptId: string,
    scope: PromptScope,
    topicId?: string | null,
  ): Promise<void>;

  // Name dictionary (used by the "Replace names" dialog).

  /** All stored name entries (the dictionary replacements are chosen from). */
  getNames(): Promise<NameEntry[]>;
  createNameEntry(data: CreateNameEntryRequest): Promise<NameEntry>;
  updateNameEntry(id: string, data: UpdateNameEntryRequest): Promise<NameEntry>;
  deleteNameEntry(id: string): Promise<void>;
  /**
   * Bulk-insert name entries (dedup by name, case-insensitive). Used to seed
   * the dictionary from a bundled name list (e.g. the zxcvbn frequency
   * lists) in a single transaction instead of thousands of individual calls.
   */
  importNameEntries(entries: CreateNameEntryRequest[]): Promise<NameEntry[]>;

  // Persisted name replacements (from → to) learned by the dialog.

  /** All remembered replacements, in alphabetical `from` order. */
  getNameReplacements(): Promise<NameReplacement[]>;
  /**
   * Upsert a replacement: an existing entry with the same `from` (case- and
   * ß-insensitive) for the same language gets its `to` overwritten.
   */
  saveNameReplacement(data: CreateNameReplacementRequest): Promise<NameReplacement>;
  deleteNameReplacement(id: string): Promise<void>;

  // Versioned general texts (compare / restore).

  /**
   * All recorded versions for an entity (optionally narrowed to one attribute),
   * newest first. New versions are appended automatically whenever a tracked
   * attribute (topic.defaultSystemPrompt, project.systemPrompt, project.greeting,
   * persona.description) actually changes.
   */
  getTextVersions(
    entityType: TextVersionEntityType,
    entityId: string,
    entityAttribute?: TextVersionAttribute,
  ): Promise<TextVersion[]>;
  /**
   * Restore an attribute to the content captured by the given version. The
   * pre-restore value is itself appended as a new version first, so the
   * restore stays reversible.
   */
  restoreTextVersion(id: string): Promise<RestoreTextVersionResult>;
  /** Remove a single recorded version entry. */
  deleteTextVersion(id: string): Promise<void>;
}

export type PersistenceKind = 'memory' | 'sqlite' | 'firebase';

export interface PersistencePort extends ChatApiPort {
  readonly kind: PersistenceKind;
  init(): Promise<void>;
  close(): Promise<void>;
}

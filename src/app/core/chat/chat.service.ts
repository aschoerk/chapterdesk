import { Injectable, inject } from '@angular/core';
import { Chat, ChatNode, CreateNodeRequest, NodeAttachment, NodeUsageSummary } from '../../models/chat';
import { NodeEditSession } from './node-edit-session';
import { ChatViewPrefsService } from './chat-view-prefs.service';
import { ChatOperationService } from './chat-operation.service';
import { ChatTreeStateService } from './chat-tree-state.service';
import { ChatTreeReaderService } from './chat-tree-reader.service';
import { ChatTreeWriterService } from './chat-tree-writer.service';
import { ChatLoreService } from './chat-lore.service';

/**
 * Re-export the extracted module-level helpers so existing importers keep
 * working (e.g. flows.spec imports `buildLoreNodeContent` / `isChatLoreNode`
 * from `./chat.service`).
 */
export { buildLoreNodeContent, isChatLoreNode } from './chat-lore.service';
export { hasImageAttachment } from './chat-tree-writer.service';

const LS_CHAT = 'chat.currentChatId';

/**
 * Application facade over the chat-tree domain.
 *
 * The implementation lives in small, single-responsibility services layered on
 * top of `ChatTreeStateService` (the signal store):
 *   – ChatTreeReaderService  — read-only navigation / queries
 *   – ChatTreeWriterService  — node + chat mutations, draft housekeeping, trash
 *   – ChatLoreService        — lore materialization + one-shot exclusion
 *   – ChatViewPrefsService   — UI view preferences + scroll memory
 *   – ChatOperationService   — generation + multi-call operation lifecycle
 *
 * ChatService keeps the SAME public surface it has always had, so every
 * existing consumer (components, pages, orchestration flows — they all inject
 * `ChatService` and call the same members) works unchanged. Only `selectChat`
 * (which needs the `NodeEditSession` leave-guard) and `restoreCurrentChat`
 * retain real logic; everything else is a one-line delegation to the owning
 * service.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly editSession = inject(NodeEditSession);
  private readonly viewPrefs = inject(ChatViewPrefsService);
  private readonly operations = inject(ChatOperationService);
  private readonly state = inject(ChatTreeStateService);
  private readonly reader = inject(ChatTreeReaderService);
  private readonly writer = inject(ChatTreeWriterService);
  private readonly lore = inject(ChatLoreService);

  // ------------------------------------------------------------- tree state

  /** Writer-lock flag (state lives in the store). */
  get elaborating(): boolean { return this.state.elaborating; }
  set elaborating(v: boolean) { this.state.elaborating = v; }

  /** The shared tree signals — SAME instances the store owns. */
  readonly chats = this.state.chats;
  readonly nodes = this.state.nodes;
  readonly currentChatId = this.state.currentChatId;
  readonly deletedNodes = this.state.deletedNodes;
  readonly chatsByProject = this.reader.chatsByProject;
  readonly currentNodes = this.reader.currentNodes;

  // --------------------------------------------------- read-only navigation

  getActiveChildId(parentId: string | null): string | null {
    return this.reader.getActiveChildId(parentId);
  }
  getActiveChild(parentId: string | null): ChatNode | null {
    return this.reader.getActiveChild(parentId);
  }
  getActivePath(): ChatNode[] {
    return this.reader.getActivePath();
  }
  getPathToNode(nodeId: string): ChatNode[] {
    return this.reader.getPathToNode(nodeId);
  }
  getChildren(parentId: string | null): ChatNode[] {
    return this.reader.getChildren(parentId);
  }
  getSiblingsOf(node: ChatNode): ChatNode[] {
    return this.reader.getSiblingsOf(node);
  }
  getPriorVersions(node: ChatNode): ChatNode[] {
    return this.reader.getPriorVersions(node);
  }
  newestChild(parentId: string | null): ChatNode | null {
    return this.reader.newestChild(parentId);
  }
  isDraftQuestion(node: ChatNode): boolean {
    return this.reader.isDraftQuestion(node);
  }

  // ---------------------------------------------------------- tree writes

  updateNodes(updateFn: (value: ChatNode[]) => ChatNode[]): void {
    this.writer.updateNodes(updateFn);
  }
  setActiveChild(parentId: string | null, childId: string): void {
    this.writer.setActiveChild(parentId, childId);
  }
  restoreMostRecentPath(): void {
    this.writer.restoreMostRecentPath();
  }
  loadNodes(chatId: string): Promise<void> {
    return this.writer.loadNodes(chatId);
  }
  fetchNodes(chatId: string): Promise<ChatNode[]> {
    return this.writer.fetchNodes(chatId);
  }
  addNode(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    return this.writer.addNode(chatId, data);
  }
  createNodeForImport(chatId: string, data: CreateNodeRequest): Promise<ChatNode> {
    return this.writer.createNodeForImport(chatId, data);
  }
  persistQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[],
    modelId?: string,
    providerId?: string
  ): Promise<ChatNode> {
    return this.writer.persistQuestion(chatId, nodeId, content, attachments, modelId, providerId);
  }
  patchNode(
    chatId: string,
    nodeId: string,
    data: {
      content?: string;
      thinking?: string;
      attachments?: NodeAttachment[];
      modelId?: string;
      providerId?: string;
      parentId?: string | null;
      excludeFromContext?: boolean;
      excludeAfterSend?: boolean;
    }
  ): Promise<ChatNode> {
    return this.writer.patchNode(chatId, nodeId, data);
  }
  branchQuestion(
    chatId: string,
    nodeId: string,
    content: string,
    modelId?: string,
    providerId?: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    return this.writer.branchQuestion(chatId, nodeId, content, modelId, providerId, attachments);
  }
  editAssistant(chatId: string, nodeId: string, content: string,
                attachments?: NodeAttachment[],
                thinking?: string,
                usage?: NodeUsageSummary): Promise<ChatNode> {
    return this.writer.editAssistant(chatId, nodeId, content, attachments, thinking, usage);
  }
  editUser(
    chatId: string,
    nodeId: string,
    content: string,
    attachments?: NodeAttachment[]
  ): Promise<ChatNode> {
    return this.writer.editUser(chatId, nodeId, content, attachments);
  }
  deleteNode(
    chatId: string,
    nodeId: string,
    options?: { keepChildren?: boolean }
  ): Promise<void> {
    return this.writer.deleteNode(chatId, nodeId, options);
  }
  reparentNodes(chatId: string, nodeIds: string[], newParentId: string | null): Promise<void> {
    return this.writer.reparentNodes(chatId, nodeIds, newParentId);
  }
  reorderSiblings(
    chatId: string,
    parentId: string | null,
    orderedNodeIds: string[],
  ): Promise<void> {
    return this.writer.reorderSiblings(chatId, parentId, orderedNodeIds);
  }
  saveChatUsage(chatId: string, nodes: { nodeId: string; usage?: NodeUsageSummary }[]): Promise<Chat | null> {
    return this.writer.saveChatUsage(chatId, nodes);
  }

  // ------------------------------------------------------- draft housekeeping

  ensureDraftAtLeaf(chatId: string): Promise<void> {
    return this.writer.ensureDraftAtLeaf(chatId);
  }
  ensureDraftUnderUserLeaf(chatId: string): Promise<void> {
    return this.writer.ensureDraftUnderUserLeaf(chatId);
  }

  // ------------------------------------------------------------------ lore

  ensureLoreNodeBefore(chatId: string, directionNodeId: string): Promise<void> {
    return this.lore.ensureLoreNodeBefore(chatId, directionNodeId);
  }
  markSentOnceExcluded(chatId: string, nodeId: string): Promise<void> {
    return this.lore.markSentOnceExcluded(chatId, nodeId);
  }

  // ------------------------------------------------------------------ trash

  loadDeletedNodes(chatId: string): Promise<void> {
    return this.writer.loadDeletedNodes(chatId);
  }
  restoreBranch(chatId: string, nodeId: string): Promise<void> {
    return this.writer.restoreBranch(chatId, nodeId);
  }
  purgeBranch(chatId: string, nodeId: string): Promise<void> {
    return this.writer.purgeBranch(chatId, nodeId);
  }

  // ------------------------------------------------------------------ chats

  loadChats(): Promise<void> {
    return this.writer.loadChats();
  }
  createChat(title = 'New Chat', projectId: string | null = null): Promise<Chat> {
    return this.writer.createChat(title, projectId);
  }
  cloneChat(chatId: string): Promise<Chat> {
    return this.writer.cloneChat(chatId);
  }
  deleteChat(id: string): Promise<void> {
    return this.writer.deleteChat(id);
  }
  reassignChat(chatId: string, projectId: string | null): Promise<Chat> {
    return this.writer.reassignChat(chatId, projectId);
  }
  reassignChatParams(chatId: string, chatParametersId: string | null): Promise<Chat> {
    return this.writer.reassignChatParams(chatId, chatParametersId);
  }
  patchChatMeta(
    chatId: string,
    changes: { lore?: string | null; autoExcludeDirections?: boolean }
  ): Promise<Chat> {
    return this.writer.patchChatMeta(chatId, changes);
  }
  updateChatTitle(id: string, title: string): Promise<void> {
    return this.writer.updateChatTitle(id, title);
  }
  applyProjectDelete(projectId: string, deleteChats: boolean): void {
    this.writer.applyProjectDelete(projectId, deleteChats);
  }

  // -------------------------------------------------- view preferences

  readonly followStreaming = this.viewPrefs.followStreaming;
  readonly followThinking = this.viewPrefs.followThinking;
  readonly alwaysOpenAtLeaf = this.viewPrefs.alwaysOpenAtLeaf;
  readonly paceAfterComplete = this.viewPrefs.paceAfterComplete;
  readonly streamSpeedUnit = this.viewPrefs.streamSpeedUnit;
  readonly streamSpeed = this.viewPrefs.streamSpeed;

  setFollowStreaming(on: boolean) { this.viewPrefs.setFollowStreaming(on); }
  setFollowThinking(on: boolean) { this.viewPrefs.setFollowThinking(on); }
  setAlwaysOpenAtLeaf(on: boolean) { this.viewPrefs.setAlwaysOpenAtLeaf(on); }
  setPaceAfterComplete(on: boolean) { this.viewPrefs.setPaceAfterComplete(on); }
  setStreamSpeedUnit(unit: 'char' | 'word') { this.viewPrefs.setStreamSpeedUnit(unit); }
  setStreamSpeed(rate: number) { this.viewPrefs.setStreamSpeed(rate); }

  getSavedScroll(chatId: string | null | undefined): number | null {
    return this.viewPrefs.getSavedScroll(chatId);
  }
  saveScroll(chatId: string | null | undefined, top: number): void {
    this.viewPrefs.saveScroll(chatId, top);
  }
  scrollToNode(nodeId: string) {
    this.viewPrefs.scrollToNode(nodeId);
  }

  // ------------------------------------------- generation + operation lifecycle

  readonly generatingNodeId = this.operations.generatingNodeId;
  readonly operationLabel = this.operations.operationLabel;
  readonly isIllustrating = this.operations.isIllustrating;
  readonly batchProgress = this.operations.batchProgress;
  readonly gracefulStop = this.operations.gracefulStop;

  beginOperation(label: string): AbortSignal { return this.operations.beginOperation(label); }
  endOperation(): void { this.operations.endOperation(); }
  isOperationCancelled(): boolean { return this.operations.isOperationCancelled(); }
  shouldStopAfterCurrentStep(): boolean { return this.operations.shouldStopAfterCurrentStep(); }
  requestGracefulStop(): void { this.operations.requestGracefulStop(); }
  clearGeneration(): void { this.operations.clearGeneration(); }
  startGeneration(nodeId: string): AbortSignal { return this.operations.startGeneration(nodeId); }
  stopGeneration(): void { this.operations.stopGeneration(); }
  isGenerating(nodeId: string): boolean { return this.operations.isGenerating(nodeId); }

  // ------------------------------------------------------------- selection

  async selectChat(chatId: string): Promise<void> {
    if (chatId === this.state.currentChatId()) return;

    if (!(await this.editSession.canLeaveChat(chatId))) {
      return; // tree, path, localStorage untouched
    }
    if (chatId) {
      localStorage.setItem(LS_CHAT, chatId);
    } else {
      localStorage.removeItem(LS_CHAT);
    }
    this.state.currentChatId.set(chatId);
    this.state.activeChildMap.set({});
    await this.writer.loadNodes(chatId);
    await this.writer.loadDeletedNodes(chatId);
    this.writer.restoreMostRecentPath();
    await this.writer.ensureDraftAtLeaf(chatId);
    await this.writer.ensureDraftUnderUserLeaf(chatId);
  }

  restoreCurrentChat(): void {
    const saved = localStorage.getItem(LS_CHAT);
    if (saved && this.state.chats().some(c => c.id === saved)) {
      void this.selectChat(saved);
    } else {
      localStorage.removeItem(LS_CHAT);
    }
  }
}
import {Component, inject, signal, OnInit, computed, HostListener} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat/chat.service';
import { Router } from '@angular/router';
import { LastModelService } from '../../core/settings/last-model.service';
import { SettingsService } from '../../core/settings/settings.service';
import {Chat, ChatNode, Project, Topic} from '../../models/chat';
import {CHAT_API} from '../../api/chat-api.token';
import { AvatarViewComponent } from '../avatar-view/avatar-view.component';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { buildSeedNodeDrafts } from '../../core/llm/llm-context';
import {ProjectService} from '../../core/settings/project.service';
import {PersonaService} from '../../core/persona.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { TopicSelectionService } from '../../core/settings/topic-selection.service';
import { SortPreferencesService, SortMode } from '../../core/settings/sort-preferences.service';
import { ChatUsageService } from '../../core/chat/chat-usage.service';
import { StoryClipboardService } from '../../core/clipboard/story-clipboard.service';
import { NodeVersionDiffDialogService } from '../../core/dialogs/node-version-diff-dialog.service';
import { resolveCurrentTopic } from '../../core/llm/llm-context';
import { isPromptRecordAttachment } from '../../core/llm/llm-message';
import type { ParsedUsage } from '../../core/llm/usage';

const LS_EXPANDED_KEY = 'chat-client.projects.expanded';
/** localStorage-backed sort preference key for this (sidebar) page. */
const SORT_PAGE = 'sidebar';

interface ChatComparison {
  structureIdentical: boolean;
  olderVersionsIdentical: boolean;
  contentsIdentical: boolean;
  attachmentsIdentical: boolean;
}

type SidebarContextTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'unassigned' }
  | { kind: 'chat'; chat: Chat };

type SidebarContextAction =
  | 'project-edit' | 'project-create' | 'project-delete' | 'project-paste'
  | 'chat-rename' | 'chat-unassign' | 'chat-reassign' | 'chat-clone' | 'chat-delete' | 'chat-cost'
  | 'chat-prepend-system' | 'chat-fix-count' | 'chat-attach-orphans' | 'chat-remove-excluded'
  | 'chat-reader-variants'
  | 'selection-copy' | 'selection-cut' | 'selection-delete' | 'selection-clear'
  | 'clipboard-cancel' | 'selection-compare' | 'selection-reader-compare';

interface SidebarContextItem {
  action: SidebarContextAction;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface SidebarContextMenuState {
  x: number;
  y: number;
  target: SidebarContextTarget;
}

@Component({
  selector: 'side-bar',
  standalone: true,
  imports: [CommonModule, FormsModule, AvatarViewComponent],
  templateUrl: './side-bar.component.html',
  styleUrls: ['./side-bar.component.css']
})
export class SideBarComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly personaService = inject(PersonaService);

  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(I18nService);
  private readonly api = inject(CHAT_API);
  private readonly topicSelection = inject(TopicSelectionService);
  private readonly sortPrefs = inject(SortPreferencesService);
  private readonly usage = inject(ChatUsageService);
  private readonly storyClipboard = inject(StoryClipboardService);
  private readonly textDiff = inject(NodeVersionDiffDialogService);

  /** Reactive alias so the template can use `clipboard.hasContent()` etc. */
  readonly clipboard = this.storyClipboard;

  readonly projects = this.projectService.projects;
  readonly currentChatId = this.chatService.currentChatId;
  readonly chatsByProject = this.chatService.chatsByProject;
  readonly enabledModels = this.settings.enabledModels;
  readonly searchQuery = signal('');
  readonly searchInContent = signal(
    localStorage.getItem('chat.sidebar.searchInContent') === '1'
  );
  readonly contentHitIds = signal<Set<string>>(new Set());
  private contentSearchTimer: ReturnType<typeof setTimeout> | null = null;
  readonly currentPersona = this.personaService.currentPersona;
  readonly topics = this.projectService.topics;

  readonly expanded = signal<Record<string, boolean>>({});
  readonly editingProjectId = signal<string | null>(null);
  readonly editName = signal('');
  readonly editSystemPrompt = signal('');
  readonly editDefaultModelId = signal<string | null>(null);
  // Project list sorting (harmonized with the Topics / Projects pages and
  // persisted per page via SortPreferencesService; defaults to newest first).
  readonly sortMode = this.sortPrefs.modeFor(SORT_PAGE);
  /** true: A→Z, false: Z→A */
  readonly alphaAsc = this.sortPrefs.alphaAscFor(SORT_PAGE);
  /** true: most recent first, false: oldest first */
  readonly updatedDesc = this.sortPrefs.updatedDescFor(SORT_PAGE);
  /**
   * The project pinned to the top by the last sort-button press (the "current"
   * project at that moment). Pinning only happens on an explicit sort action,
   * not just because a chat got opened.
   */
  readonly pinnedProjectId = signal<string | null>(null);
  readonly reassigningChatId = signal<string | null>(null);
  readonly editingChatId = signal<string | null>(null);
  readonly titleDraft = signal('');
  /** Persisted per-chat cost totals (updated by the "Σ" button in each chat row). */
  private readonly chatCosts = signal<Record<string, ParsedUsage | null>>({});
  readonly selectedTopicId = this.topicSelection.selectedTopicId;

  // ------------------------------------------------------------------
  // Story multi-selection (Ctrl+click, like the navbar) + move/cut/paste
  // ------------------------------------------------------------------

  /** Ordered ids of the stories selected on the sidebar (Ctrl+click toggles). */
  readonly selectedChatIds = signal<string[]>([]);
  readonly hasSelection = computed(() => this.selectedChatIds().length > 0);
  readonly selectedCount = computed(() => this.selectedChatIds().length);
  readonly chatComparison = signal<ChatComparison | null>(null);
  readonly comparingChats = signal(false);
  readonly contextMenu = signal<SidebarContextMenuState | null>(null);

  /**
   * Environment key currently hovered as a drag&drop target
   * (`'__unassigned__'` for the unassigned block). Null = none.
   */
  readonly dropTargetKey = signal<string | null>(null);
  /** Depth counter per environment key so nested dragenter/dragleave don't flicker. */
  private readonly dropDepth = new Map<string, number>();
  private draggingChatIds: string[] | null = null;
  /** Guard: a click event that can follow a drop must not toggle expansion. */
  private dropGuardUntil = 0;

  isChatSelected(id: string): boolean {
    return this.selectedChatIds().includes(id);
  }

  isCutChat(id: string): boolean {
    return this.storyClipboard.isCutChat(id);
  }

  /**
   * Plain click → open the story; Ctrl/Cmd+click → toggle multi-selection
   * (mirrors the navbar behaviour).
   */
  onChatItemClick(event: MouseEvent, chat: Chat): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.toggleChatSelection(chat.id);
      return;
    }
    void this.selectChat(chat);
  }

  toggleChatSelection(id: string): void {
    this.chatComparison.set(null);
    this.selectedChatIds.update(cur =>
      cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
    );
  }

  clearSelection(): void {
    this.selectedChatIds.set([]);
    this.chatComparison.set(null);
  }

  openContextMenu(event: MouseEvent, target: SidebarContextTarget): void {
    event.preventDefault();
    event.stopPropagation();
    const items = this.contextItems(target);
    if (!items.length) {
      this.closeContextMenu();
      return;
    }
    const width = 250;
    const height = Math.min(items.length * 38 + 12, window.innerHeight - 16);
    this.contextMenu.set({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      target
    });
  }

  contextItems(target: SidebarContextTarget): SidebarContextItem[] {
    const items: SidebarContextItem[] = [];
    if (target.kind === 'project') {
      items.push(
        { action: 'project-edit', label: this.i18n.t('sidebar.editEnvironment') },
        { action: 'project-create', label: this.i18n.t('sidebar.newStory') }
      );
      if (this.clipboard.hasContent()) {
        items.push({ action: 'project-paste', label: this.pasteHereTitle(target.project.id) });
      }
      items.push({ action: 'project-delete', label: this.i18n.t('sidebar.deleteBook'), danger: true, separatorBefore: true });
    } else if (target.kind === 'unassigned') {
      if (this.clipboard.hasContent()) {
        items.push({ action: 'project-paste', label: this.pasteHereTitle(null) });
      }
    } else {
      if (target.chat.projectId) {
        items.push({ action: 'chat-unassign', label: this.i18n.t('sidebar.moveUnassigned') });
      }
      items.push(
        { action: 'chat-rename', label: this.i18n.t('sidebar.renameStory') },
        { action: 'chat-reassign', label: this.i18n.t('sidebar.moveEnvironment') },
        { action: 'chat-clone', label: this.i18n.t('sidebar.cloneStory') },
        { action: 'chat-cost', label: this.i18n.t('sidebar.sumTotalCost') },
        ...(target.chat.projectId
          ? [{ action: 'chat-prepend-system' as const, label: this.i18n.t('sidebar.prependSystemPrompt') }]
          : []),
        { action: 'chat-fix-count', label: this.i18n.t('sidebar.repairNodeNumber') },
        { action: 'chat-attach-orphans', label: this.i18n.t('sidebar.attachRootNodesToSystem') },
        { action: 'chat-remove-excluded', label: this.i18n.t('sidebar.removeExcludedNodes'), danger: true },
        ...(this.selectedChatIds().length === 0
          ? [{ action: 'chat-reader-variants' as const, label: this.i18n.t('sidebar.compareChatVariants') }]
          : []),
        { action: 'chat-delete', label: this.i18n.t('common.delete'), danger: true, separatorBefore: true }
      );
    }

    if (this.selectedChatIds().length) {
      items.push(
        { action: 'selection-copy', label: this.i18n.t('sidebar.copySelected'), separatorBefore: items.length > 0 },
        { action: 'selection-cut', label: this.i18n.t('sidebar.cutSelected') },
        { action: 'selection-delete', label: this.i18n.t('common.delete'), danger: true },
        { action: 'selection-clear', label: this.i18n.t('sidebar.clearSelection') }
      );
      if (this.selectedCount() === 2) {
        items.push(
          { action: 'selection-compare', label: this.i18n.t('sidebar.compareSelected') },
          { action: 'selection-reader-compare', label: this.i18n.t('sidebar.compareReaderViews') }
        );
      }
    }
    if (this.clipboard.hasContent()) {
      items.push({ action: 'clipboard-cancel', label: this.i18n.t('sidebar.cancelClipboard'), separatorBefore: items.length > 0 });
    }
    return items.filter(item => item.label);
  }

  async runContextAction(action: SidebarContextAction): Promise<void> {
    const state = this.contextMenu();
    if (!state) return;
    const { target } = state;
    const event = {
      stopPropagation: () => {},
      preventDefault: () => {}
    } as Event;
    this.closeContextMenu();

    switch (action) {
      case 'project-edit': if (target.kind === 'project') this.editProject(target.project, event); break;
      case 'project-create': if (target.kind === 'project') await this.createChatForProject(target.project, event); break;
      case 'project-delete': if (target.kind === 'project') await this.deleteProject(target.project, event); break;
      case 'project-paste': await this.pasteIntoEnv(target.kind === 'project' ? target.project.id : null); break;
      case 'chat-rename': if (target.kind === 'chat') this.startEditChatTitle(target.chat, event); break;
      case 'chat-unassign': if (target.kind === 'chat') await this.unassignChat(target.chat, event); break;
      case 'chat-reassign': if (target.kind === 'chat') this.toggleReassign(target.chat.id, event); break;
      case 'chat-clone': if (target.kind === 'chat') await this.cloneChat(target.chat, event); break;
      case 'chat-delete': if (target.kind === 'chat') await this.deleteChat(target.chat, event); break;
      case 'chat-cost': if (target.kind === 'chat') await this.recomputeChatCost(target.chat.id, event); break;
      case 'chat-prepend-system': if (target.kind === 'chat') await this.prependProjectSystemPrompt(target.chat); break;
      case 'chat-fix-count': if (target.kind === 'chat') await this.repairChatNodeNumber(target.chat); break;
      case 'chat-attach-orphans': if (target.kind === 'chat') await this.attachOrphanRootsToSystemPrompt(target.chat); break;
      case 'chat-remove-excluded': if (target.kind === 'chat') await this.removeExcludedNodes(target.chat); break;
      case 'chat-reader-variants': if (target.kind === 'chat') await this.compareChatReaderVariants(target.chat); break;
      case 'selection-copy': this.copySelectedStories(); break;
      case 'selection-cut': this.cutSelectedStories(); break;
      case 'selection-delete': await this.deleteSelectedStories(); break;
      case 'selection-clear': this.clearSelection(); break;
      case 'clipboard-cancel': this.cancelClipboard(); break;
      case 'selection-compare': await this.compareSelectedChats(); break;
      case 'selection-reader-compare': await this.compareSelectedReaderViews(); break;
    }
  }

  closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  @HostListener('document:keydown', ['$event'])
  onContextMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.contextMenu()) {
      event.preventDefault();
      this.closeContextMenu();
    }
  }

  @HostListener('window:resize')
  @HostListener('document:scroll')
  onContextMenuViewportChange(): void {
    this.closeContextMenu();
  }

  /** Compare the full persisted section trees, ignoring generated record ids. */
  async compareSelectedChats(): Promise<void> {
    const ids = this.selectedChatIds();
    if (ids.length !== 2 || this.comparingChats()) return;
    this.comparingChats.set(true);
    this.chatComparison.set(null);
    try {
      const [left, right] = await Promise.all(ids.map(id => this.chatService.fetchNodes(id)));
      this.chatComparison.set(compareChatNodes(left, right));
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.compareFailed', { error: err?.message || err }));
    } finally {
      this.comparingChats.set(false);
    }
  }

  async prependProjectSystemPrompt(chat: Chat): Promise<void> {
    if (!chat.projectId) return;
    const project = this.projectService.getProject(chat.projectId);
    if (!project) return;
    const topic = resolveCurrentTopic(
      project.id,
      project.mainTopicId,
      this.selectedTopicId(),
      this.topics()
    );
    const prompt = topic?.defaultSystemPrompt?.trim();
    if (!prompt) {
      alert(this.i18n.t('sidebar.noEnvironmentPrompt'));
      return;
    }
    const nodes = await this.chatService.fetchNodes(chat.id);
    const currentRoots = nodes.filter(node => node.isCurrent && !node.deletedAt && !node.parentId);
    const existing = currentRoots.find(node => node.role === 'system');
    if (existing) {
      if ((existing.content ?? '') !== prompt) {
        await this.chatService.patchNode(chat.id, existing.id, { content: prompt });
      }
    } else {
      const rootNodes = currentRoots;
      const position = Math.min(...rootNodes.map(node => node.position ?? Number.MAX_SAFE_INTEGER), 1);
      const systemNode = await this.chatService.addNode(chat.id, {
        parentId: null,
        role: 'system',
        content: prompt,
        position: Number.isFinite(position) && position !== Number.MAX_SAFE_INTEGER ? position : 1
      });
      if (rootNodes.length) {
        await this.chatService.reparentNodes(chat.id, rootNodes.map(node => node.id), systemNode.id);
        this.chatService.setActiveChild(systemNode.id, rootNodes[0].id);
      }
      this.chatService.setActiveChild(null, systemNode.id);
    }
    await this.chatService.repairChatNodeCount(chat.id, (await this.chatService.fetchNodes(chat.id)).length);
  }

  async repairChatNodeNumber(chat: Chat): Promise<void> {
    const count = (await this.chatService.fetchNodes(chat.id)).length;
    await this.chatService.repairChatNodeCount(chat.id, count);
  }

  async removeExcludedNodes(chat: Chat): Promise<void> {
    const nodes = await this.chatService.fetchNodes(chat.id);
    const excludedIds = new Set(nodes
      .filter(node => !node.deletedAt && node.isCurrent && node.excludeFromContext)
      .map(node => node.id));
    if (!excludedIds.size) return;

    // Delete top-down and promote descendants so removing an excluded section
    // never silently removes ordinary story text beneath it.
    const depth = (node: ChatNode): number => {
      let result = 0;
      let parentId = node.parentId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        result++;
        parentId = nodes.find(parent => parent.id === parentId)?.parentId ?? null;
      }
      return result;
    };
    const excluded = nodes
      .filter(node => excludedIds.has(node.id))
      .sort((a, b) => depth(a) - depth(b));
    for (const node of excluded) {
      await this.api.deleteNode(chat.id, node.id, { keepChildren: true });
    }

    const remaining = await this.chatService.fetchNodes(chat.id);
    await this.chatService.repairChatNodeCount(chat.id, remaining.length);
    if (this.currentChatId() === chat.id) {
      await this.chatService.loadNodes(chat.id);
      this.chatService.restoreMostRecentPath();
      await this.chatService.ensureDraftAtLeaf(chat.id);
    }
  }

  async attachOrphanRootsToSystemPrompt(chat: Chat): Promise<void> {
    const nodes = await this.chatService.fetchNodes(chat.id);
    const project = chat.projectId ? this.projectService.getProject(chat.projectId) : undefined;
    const topic = project ? resolveCurrentTopic(project.id, project.mainTopicId, this.selectedTopicId(), this.topics()) : undefined;
    const prompt = topic?.defaultSystemPrompt?.trim() || '';
    const rootSystem = nodes.find(node => !node.deletedAt && node.isCurrent && !node.parentId && node.role === 'system');
    const roots = nodes.filter(node => !node.deletedAt && node.isCurrent && !node.parentId);
    const orphans = nodes.filter(node => !node.deletedAt && node.isCurrent && node.parentId && !nodes.some(parent => parent.id === node.parentId));
    const attachIds = [...new Set([
      ...roots.filter(node => node.id !== rootSystem?.id).map(node => node.id),
      ...orphans.map(node => node.id)
    ])];
    if (!attachIds.length) return;

    let systemNode = rootSystem;
    if (!systemNode) {
      systemNode = await this.chatService.addNode(chat.id, {
        parentId: null,
        role: 'system',
        content: prompt,
        position: 1
      });
    } else if (prompt && !systemNode.content.trim()) {
      await this.chatService.patchNode(chat.id, systemNode.id, { content: prompt });
    }
    await this.chatService.reparentNodes(chat.id, attachIds, systemNode.id);
    this.chatService.setActiveChild(null, systemNode.id);
    const firstAttached = attachIds[0];
    if (firstAttached) this.chatService.setActiveChild(systemNode.id, firstAttached);
    await this.chatService.repairChatNodeCount(chat.id, (await this.chatService.fetchNodes(chat.id)).length);
  }

  async compareSelectedReaderViews(): Promise<void> {
    const ids = this.selectedChatIds();
    if (ids.length !== 2) return;
    const [leftNodes, rightNodes] = await Promise.all(ids.map(id => this.chatService.fetchNodes(id)));
    const leftChat = this.chatService.chats().find(chat => chat.id === ids[0]);
    const rightChat = this.chatService.chats().find(chat => chat.id === ids[1]);
    const leftDocuments = this.readerDocuments(leftNodes, leftChat, ids[0]);
    const rightDocuments = this.readerDocuments(rightNodes, rightChat, ids[1]);
    void this.textDiff.open({
      title: this.i18n.t('sidebar.readerCompareTitle'),
      newText: rightDocuments[0]?.text ?? '',
      originalLabel: leftChat?.title ?? ids[0],
      modifiedLabel: rightChat?.title ?? ids[1],
      texts: leftDocuments,
      modifiedTexts: rightDocuments,
      readOnly: true
    });
  }

  async compareChatReaderVariants(chat: Chat): Promise<void> {
    const nodes = await this.chatService.fetchNodes(chat.id);
    const documents = this.readerDocuments(nodes, chat, chat.id);
    if (documents.length < 2) return;
    void this.textDiff.open({
      title: this.i18n.t('sidebar.compareChatVariantsTitle', { title: chat.title }),
      newText: documents[0].text,
      originalLabel: chat.title,
      modifiedLabel: chat.title,
      texts: documents,
      modifiedTexts: documents,
      readOnly: true
    });
  }

  private readerDocuments(nodes: ChatNode[], chat: Chat | undefined, id: string) {
    // Match the navbar's switchable tree: only current nodes participate,
    // siblings follow their stored navbar position, and every selectable
    // terminal path remains an option (including an empty draft sibling).
    const currentNodes = nodes.filter(node => !node.deletedAt && node.isCurrent);
    const byParent = new Map<string | null, ChatNode[]>();
    const byId = new Map(currentNodes.map(node => [node.id, node]));
    for (const node of currentNodes) {
      const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : null;
      const siblings = byParent.get(parentId) ?? [];
      siblings.push(node);
      byParent.set(parentId, siblings);
    }
    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
    }

    const paths: ChatNode[][] = [];
    const walk = (node: ChatNode, path: ChatNode[], ancestors: Set<string>) => {
      if (ancestors.has(node.id)) return;
      const nextPath = [...path, node];
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(node.id);
      const children = byParent.get(node.id) ?? [];
      if (!children.length) {
        paths.push(nextPath);
        return;
      }
      for (const child of children) walk(child, nextPath, nextAncestors);
    };
    for (const root of byParent.get(null) ?? []) walk(root, [], new Set());

    const documents = paths.map(path => path.map(node => {
      const role = node.role === 'user' ? this.i18n.t('reader.roleUser') : this.i18n.t('reader.roleAssistant');
      const meta = [role, node.modelId, `v${node.version}`].filter(Boolean).join(' · ');
      const content = node.content?.trim() ?? '';
      const files = (node.attachments ?? []).filter(attachment => !isPromptRecordAttachment(attachment))
        .map(attachment => `Attachment: ${attachment.name}`);
      return [`<!-- ${meta} -->`, content, ...files].filter(Boolean).join('\n\n');
    }).filter(Boolean).join('\n\n'));
    const title = chat?.title ?? id;
    if (!documents.length) documents.push('');
    return documents.map((text, index) => ({
      id: `${id}:reader:${index}`,
      label: `${title} · ${this.i18n.t('sidebar.readerVariant', { current: index + 1, total: documents.length })}`,
      text
    }));
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]!);
  }

  /** Copy the selected stories (they can be pasted/duplicated elsewhere). */
  copySelectedStories(): void {
    const ids = this.selectedChatIds();
    if (!ids.length) return;
    try {
      this.storyClipboard.copy(ids);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.copyFailed', { error: err?.message || err }));
    }
  }

  /**
   * Cut (stage a move). The stories are NOT removed here — they only move to
   * the target environment when the user pastes them there. If no paste
   * happens the stories stay untouched, and "Cancel" drops the staging.
   */
  cutSelectedStories(): void {
    const ids = this.selectedChatIds();
    if (!ids.length) return;
    try {
      this.storyClipboard.cut(ids);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.cutFailed', { error: err?.message || err }));
    }
  }

  /** Cancel a staged cut/copy: nothing is moved or deleted. */
  cancelClipboard(): void {
    this.storyClipboard.clear();
  }

  async deleteSelectedStories(): Promise<void> {
    const ids = this.selectedChatIds();
    if (!ids.length) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('sidebar.deleteSelectedTitle'),
      message: this.i18n.t('sidebar.deleteSelectedMsg', { count: ids.length }),
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    try {
      for (const id of ids) {
        await this.chatService.deleteChat(id);
        this.usage.clearStored(id);
      }
      this.clearSelection();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.deleteSelectedFailed', { error: err?.message || err }));
    }
  }

  /** Paste the clipboard (cut → move, copy → clone) into an environment. */
  async pasteIntoEnv(projectId: string | null, event?: Event): Promise<void> {
    event?.stopPropagation();
    const key = this.envKey(projectId);
    try {
      const pasted = await this.storyClipboard.pasteInto(projectId);
      if (pasted && !this.isExpanded(key)) {
        this.toggleExpanded(key);
      }
      this.clearSelection();
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.pasteFailed', { error: err?.message || err }));
    }
  }

  pasteHereTitle(projectId: string | null): string {
    const n = this.storyClipboard.count();
    if (n <= 0) return this.i18n.t('sidebar.pasteHere');
    const stories = this.i18n.t(n === 1 ? 'sidebar.storyWord' : 'sidebar.storiesWord');
    const where = projectId
      ? this.projects().find(p => p.id === projectId)?.name
      : this.i18n.t('sidebar.unfiled');
    return this.i18n.t('sidebar.pasteHereTitle', { count: n, stories, where: where ?? '' });
  }

  clipboardInfoLabel(): string {
    const n = this.storyClipboard.count();
    return this.storyClipboard.action() === 'cut'
      ? this.i18n.t('sidebar.cutStaged', { count: n })
      : this.i18n.t('sidebar.copyStaged', { count: n });
  }

  clipboardInfoTitle(): string {
    const n = this.storyClipboard.count();
    return this.storyClipboard.action() === 'cut'
      ? this.i18n.t('sidebar.cutStagedHint', { count: n })
      : this.i18n.t('sidebar.copyStagedHint', { count: n });
  }

  // --- drag & drop: real move of the marked stories onto an environment -----

  private envKey(projectId: string | null): string {
    return projectId ?? '__unassigned__';
  }

  private projectIdForKey(key: string): string | null {
    return key === '__unassigned__' ? null : key;
  }

  isDropTarget(key: string): boolean {
    return this.dropTargetKey() === key;
  }

  onChatDragStart(event: DragEvent, chat: Chat): void {
    if (this.editingChatId() === chat.id) return;
    const ids = this.selectedChatIds().includes(chat.id)
      ? this.selectedChatIds()
      : [chat.id];
    this.draggingChatIds = [...ids];
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(this.draggingChatIds));
  }

  onChatDragEnd(): void {
    this.resetDragState();
  }

  onDragEnter(key: string): void {
    const depth = (this.dropDepth.get(key) ?? 0) + 1;
    this.dropDepth.set(key, depth);
    this.dropTargetKey.set(key);
  }

  onDragLeave(key: string): void {
    const depth = (this.dropDepth.get(key) ?? 1) - 1;
    if (depth <= 0) {
      this.dropDepth.delete(key);
      if (this.dropTargetKey() === key) this.dropTargetKey.set(null);
    } else {
      this.dropDepth.set(key, depth);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault(); // allow the drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  async onDropEnvironment(key: string, event: DragEvent): Promise<void> {
    event.preventDefault();
    // Read the ids from the dataTransfer FIRST (it survives the drag), falling
    // back to the ids captured at dragstart, before the drag state is cleared.
    const ids = this.readDragIds(event) ?? this.draggingChatIds;
    this.resetDragState();

    if (!ids?.length) return;
    const targetProjectId = this.projectIdForKey(key);
    try {
      await this.moveChats(ids, targetProjectId);
      this.clearSelection();
      if (!this.isExpanded(key)) {
        this.toggleExpanded(key);
      }
      // Suppress the click that a browser can synthesize right after a drop,
      // so the (collapsed) target header doesn't collapse again immediately.
      this.dropGuardUntil = Date.now() + 350;
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.moveFailed', { error: err?.message || err }));
    }
  }

  private readDragIds(event: DragEvent): string[] | null {
    try {
      const raw = event.dataTransfer?.getData('text/plain');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
        return parsed as string[];
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Reassign the given stories to `targetProjectId` — the actual move. */
  private async moveChats(chatIds: string[], targetProjectId: string | null): Promise<void> {
    for (const chatId of chatIds) {
      const chat = this.chatService.chats().find(c => c.id === chatId);
      if (chat && chat.projectId !== targetProjectId) {
        await this.chatService.reassignChat(chatId, targetProjectId);
      }
    }
  }

  private resetDragState(): void {
    this.draggingChatIds = null;
    this.dropDepth.clear();
    this.dropTargetKey.set(null);
  }

  /** Prevent the browser from navigating / dropping anywhere else. */
  @HostListener('document:dragover', ['$event'])
  onDocDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  @HostListener('document:drop', ['$event'])
  onDocDrop(event: DragEvent): void {
    event.preventDefault();
    this.resetDragState();
  }

  selectTopicFilter(id: string) {
    this.topicSelection.selectTopic(id || 'all');
  }

  setSearchQuery(q: string) {
    this.searchQuery.set(q);
    this.scheduleContentSearch();
  }

  setSearchInContent(on: boolean) {
    this.searchInContent.set(on);
    localStorage.setItem('chat.sidebar.searchInContent', on ? '1' : '0');
    this.scheduleContentSearch(true);
  }

  private scheduleContentSearch(immediate = false) {
    if (this.contentSearchTimer) clearTimeout(this.contentSearchTimer);
    const run = async () => {
      const q = this.searchQuery().trim();
      if (!this.searchInContent() || !q) {
        this.contentHitIds.set(new Set());
        return;
      }
      try {
        const ids = await this.api.searchChatIds(q);
        this.contentHitIds.set(new Set(ids));
      } catch {
        this.contentHitIds.set(new Set());
      }
    };
    if (immediate) void run();
    else this.contentSearchTimer = setTimeout(() => void run(), 280);
  }

  private chatMatchesQuery(chat: Chat, q: string): boolean {
    if (!q) return true;
    if ((chat.title || '').toLowerCase().includes(q)) return true;
    return this.searchInContent() && this.contentHitIds().has(chat.id);
  }

  filteredProjects = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const topicId = this.selectedTopicId();
    let list = this.projects();

    if (topicId && topicId !== 'all') {
      const topic = this.topics().find(t => t.id === topicId);
      if (topic) {
        const idSet = new Set(topic.projectIds);
        list = list.filter(p => idSet.has(p.id));
      }
    }

    if (q) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        this.getChatsForProject(p.id).length > 0
      );
    }

    // Apply the selected sort mode (same as Topics / Projects pages).
    list = [...list];
    if (this.sortMode() === 'alpha') {
      list.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name, this.i18n.localeId());
        return this.alphaAsc() ? cmp : -cmp;
      });
    } else {
      list.sort((a, b) => this.projectTime(b) - this.projectTime(a));
      if (!this.updatedDesc()) list.reverse();
    }

    // A project that was pinned by pressing a sort button stays on top.
    const pinnedId = this.pinnedProjectId();
    if (pinnedId) {
      const pinned = list.find(p => p.id === pinnedId);
      if (pinned) {
        return [pinned, ...list.filter(p => p.id !== pinnedId)];
      }
    }
    return list;
  });

  /** The project that owns the currently open chat, or null. */
  readonly currentProjectId = computed<string | null>(() => {
    const chatId = this.chatService.currentChatId();
    if (!chatId) return null;
    const chat = this.chatService.chats().find(c => c.id === chatId);
    return chat?.projectId || null;
  });

  async ngOnInit() {
    await Promise.all([
      this.projectService.loadProjects(),
      this.chatService.loadChats(),
      this.personaService.loadPersonas(),
      this.projectService.loadTopics(),
      this.settings.loadAll()
    ]);
    this.loadExpandedState();
    this.scrollToActiveChat();
  }

  private loadExpandedState() {
    try {
      const raw = localStorage.getItem(LS_EXPANDED_KEY);
      if (raw) this.expanded.set(JSON.parse(raw));
    } catch { /* ignore */ }
  }

  private persistExpanded() {
    try {
      localStorage.setItem(LS_EXPANDED_KEY, JSON.stringify(this.expanded()));
    } catch { /* ignore */ }
  }

  isExpanded(projectId: string): boolean {
    return this.expanded()[projectId];
  }

  toggleExpanded(projectId: string, event?: Event) {
    // A click that can follow a HTML5 drag&drop must not toggle expansion.
    if (Date.now() < this.dropGuardUntil) return;
    event?.stopPropagation();
    this.expanded.update(m => ({
      ...m,
      [projectId]: !this.isExpanded(projectId)
    }));
    this.persistExpanded();
  }

  toggleSort(mode: SortMode): void {
    // An explicit sort press pins the current (last opened) project to the top.
    this.pinnedProjectId.set(this.currentProjectId());

    if (this.sortMode() === mode) {
      if (mode === 'alpha') this.sortPrefs.setAlphaAsc(SORT_PAGE, !this.alphaAsc());
      else this.sortPrefs.setUpdatedDesc(SORT_PAGE, !this.updatedDesc());
    } else {
      // First click always starts with the primary direction.
      this.sortPrefs.setMode(SORT_PAGE, mode);
      if (mode === 'alpha') this.sortPrefs.setAlphaAsc(SORT_PAGE, true);
      else this.sortPrefs.setUpdatedDesc(SORT_PAGE, true);
    }
  }

  alphaLabel(): string {
    return this.sortMode() === 'alpha' && !this.alphaAsc() ? 'Z–A' : 'A–Z';
  }

  alphaSortTitleKey(): string {
    if (this.sortMode() !== 'alpha') return 'sort.alpha';
    return this.alphaAsc() ? 'sort.alphaAZ' : 'sort.alphaZA';
  }

  updatedSortTitleKey(): string {
    if (this.sortMode() !== 'updated') return 'sort.updated';
    return this.updatedDesc() ? 'sort.updatedNew' : 'sort.updatedOld';
  }

  /**
   * Effective age key for an environment in the "by age" sort mode.
   *
   * Environments are ordered by the age of their stories: when sorting by
   * newest first we use the environment's youngest chat, when sorting by
   * oldest first we use its oldest chat. That way an environment rises / falls
   * with the activity of its chats (the project row itself keeps its own
   * updatedAt, which the backend does not touch when a chat changes).
   * Environments without chats fall back to their own updated/created stamp.
   */
  private projectTime(p: Project): number {
    const fallback = new Date(p.updatedAt || p.createdAt).getTime() || 0;
    const times = (this.chatsByProject().get(p.id) || [])
      .map(c => new Date(c.updated_at || c.created_at).getTime())
      .filter(t => t > 0);
    if (!times.length) return fallback;
    // Use the youngest chat when ordering newest-first, the oldest chat when
    // ordering oldest-first (the caller sorts descending and reverses for the
    // oldest-first direction, so both directions come out correct).
    return this.updatedDesc()
      ? times.reduce((a, b) => Math.max(a, b))
      : times.reduce((a, b) => Math.min(a, b));
  }

  editProject(project: Project, event?: Event) {
    event?.stopPropagation();
    void this.router.navigate(['/projects'], { queryParams: { editProject: project.id } });
  }

  editCurrentTopic(event?: Event) {
    event?.stopPropagation();
    const topicId = this.selectedTopicId();
    if (!topicId || topicId === 'all') return;
    void this.router.navigate(['/projects'], { queryParams: { editTopic: topicId } });
  }

  startEditChatTitle(chat: Chat, event?: Event) {
    event?.stopPropagation();
    this.reassigningChatId.set(null);
    this.editingChatId.set(chat.id);
    this.titleDraft.set(chat.title || '');
  }

  cancelEditChatTitle() {
    this.editingChatId.set(null);
  }

  async saveChatTitle(chat: Chat) {
    if (this.editingChatId() !== chat.id) return;
    const title = this.titleDraft().trim();
    this.editingChatId.set(null);
    if (!title || title === chat.title) return;
    await this.chatService.updateChatTitle(chat.id, title);
  }

  startEditProject(project: Project, event?: Event) {
    event?.stopPropagation();
    this.editingProjectId.set(project.id);
    this.editName.set(project.name);
    this.editSystemPrompt.set(project.systemPrompt || '');
    this.editDefaultModelId.set(project.defaultModelId);
  }

  async deleteProject(project: Project, event: Event) {
    event.stopPropagation();

    const chatCount = this.getChatsForProject(project.id).length;
    const message = chatCount === 0
      ? this.i18n.t('sidebar.deleteEnvEmpty', { name: project.name })
      : this.i18n.t('sidebar.deleteEnvWithStories', {
        name: project.name,
        count: chatCount,
        stories: this.i18n.t(chatCount === 1 ? 'sidebar.storyWord' : 'sidebar.storiesWord')
      });

    const ok = await this.confirm.ask({
      title: this.i18n.t('sidebar.deleteEnvTitle'),
      message,
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;

    const deleteChats = chatCount > 0;
    await this.projectService.deleteProject(project.id, deleteChats);

    this.expanded.update(m => {
      const next = { ...m };
      delete next[project.id];
      return next;
    });
    this.persistExpanded();
  }

  toggleReassign(chatId: string, event: Event) {
    event.stopPropagation();
    this.reassigningChatId.update(id => (id === chatId ? null : chatId));
  }

  async onReassign(chat: Chat, newProjectId: string | null) {
    await this.chatService.reassignChat(chat.id, newProjectId);
    this.reassigningChatId.set(null);
  }

  async unassignChat(chat: Chat, event: Event) {
    event.stopPropagation();
    if (chat.projectId == null) return;
    await this.chatService.reassignChat(chat.id, null);
  }

  otherProjects(currentProjectId: string | null): Project[] {
    return this.filteredProjects().filter(p => p.id !== currentProjectId);
  }

  async createChatForProject(project: Project, event?: Event) {
    event?.stopPropagation();

    const title = this.i18n.t('sidebar.newChatTitle', { name: project.name });
    const chat = await this.chatService.createChat(title, project.id);

    const drafts = buildSeedNodeDrafts({
      project,
      topics: this.topics(),
      currentTopicId: this.selectedTopicId(),
      getPersona: id => this.personaService.getPersona(id),
      currentUserPersona: this.currentPersona()
    });

    let currentParentNodeId: string | null = null;
    for (const draft of drafts) {
      const created = await this.chatService.addNode(chat.id, {
        parentId: currentParentNodeId,
        role: draft.role,
        content: draft.content
      });
      currentParentNodeId = created.id;
    }

    if (project.defaultModelId) {
      this.lastModelService.setSelectedModel(project.defaultModelId);
      this.lastModelService.saveLastUsedModel(project.defaultModelId);
    } else if (this.lastModelService.lastUsedModelId()) {
      this.lastModelService.setLastModel(this.lastModelService.lastUsedModelId());
    } else {
      this.lastModelService.setSelectedModel('');
    }

    if (!this.isExpanded(project.id)) {
      this.toggleExpanded(project.id);
    }
    await this.chatService.selectChat(chat.id);
  }

  async selectChat(chat: Chat) {
    await this.chatService.selectChat(chat.id);
    this.lastModelService.setLastUsedModel();

    const projectKey = chat.projectId ?? '__unassigned__';
    if (!this.isExpanded(projectKey)) {
      this.expanded.update(m => ({ ...m, [projectKey]: true }));
      this.persistExpanded();
    }
    this.scrollToActiveChat();
  }

  private scrollToActiveChat() {
    setTimeout(() => {
      const active = document.querySelector('.chat-item.active');
      active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 50);
  }

  async cloneChat(chat: Chat, event: Event) {
    event.stopPropagation();
    try {
      const copy = await this.chatService.cloneChat(chat.id);
      const projectKey = copy.projectId ?? '__unassigned__';
      if (!this.isExpanded(projectKey)) {
        this.expanded.update(m => ({ ...m, [projectKey]: true }));
        this.persistExpanded();
      }
      await this.selectChat(copy);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('sidebar.cloneFailed', { error: err?.message || err }));
    }
  }

  async deleteChat(chat: Chat, event: Event) {
    event.stopPropagation();
    const ok = await this.confirm.ask({
      title: this.i18n.t('sidebar.deleteStoryTitle'),
      message: this.i18n.t('sidebar.deleteStoryMsg', { title: chat.title }),
      confirmLabel: this.i18n.t('common.delete'),
      cancelLabel: this.i18n.t('common.cancel'),
      danger: true
    });
    if (!ok) return;
    await this.chatService.deleteChat(chat.id);
    this.usage.clearStored(chat.id);
  }

  collapseAll(event?: Event) {
    event?.stopPropagation();
    const next: Record<string, boolean> = {};
    for (const p of this.projects()) {
      next[p.id] = false;
    }
    this.expanded.set(next);
    this.persistExpanded();
  }

  getChatsForProject(projectId: string | null): Chat[] {
    const q = this.searchQuery().trim().toLowerCase();
    let chats = this.chatsByProject().get(projectId) || [];
    if (q) chats = chats.filter(c => this.chatMatchesQuery(c, q));
    return [...chats].sort((a, b) => {
      const ta = new Date(a.updated_at || a.created_at).getTime();
      const tb = new Date(b.updated_at || b.created_at).getTime();
      return tb - ta;
    });
  }

  getChatCount(projectId: string | null): number {
    return this.getChatsForProject(projectId).length;
  }

  /**
   * Total cost label of a chat (e.g. "$0.0042"), or '' when no cost is known.
   * Prefers the PERSISTED chat total (`chat.totalCost`, shared across
   * browsers), falling back to the local snapshot from the "Σ" button or the
   * localStorage record for legacy chats.
   */
  chatCostLabel(chatId: string): string {
    const chat = this.chatService.chats().find(c => c.id === chatId);
    const persisted = chat?.totalCost;
    if (typeof persisted === 'number' && Number.isFinite(persisted) && persisted > 0) {
      return this.formatCost(persisted);
    }
    const totals = this.chatCosts()[chatId] ?? this.usage.storedTotals(chatId);
    if (!totals?.cost) return '';
    return this.formatCost(totals.cost);
  }

  /**
   * The "Σ" button of a chat row: add up the chat's token usage / cost from
   * the browser LLM log, PERSIST the per-node usage + chat totals to the
   * server (so they survive reloads and other browsers) and refresh the
   * shown field.
   */
  async recomputeChatCost(chatId: string, event: Event) {
    event.stopPropagation();
    const nodes = this.usage.nodeUsagesForChat(chatId);
    const chat = await this.chatService.saveChatUsage(chatId, nodes);
    const totals = chat ? this.usage.usageFromNode(chat) : this.usage.chatTotals(chatId);
    const next = { ...this.chatCosts() };
    if (totals?.cost) next[chatId] = totals;
    else delete next[chatId];
    this.chatCosts.set(next);
  }

  /** USD cost label with adaptive precision (same as the /logs page). */
  formatCost(cost: number): string {
    if (!Number.isFinite(cost)) return '';
    const digits = cost >= 1 ? 2 : cost >= 0.01 ? 4 : 6;
    return this.i18n.formatNumber(cost, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  formatWhen(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return this.i18n.formatDate(date, { dateStyle: 'short', timeStyle: 'short' });
  }

  modelLabel(id: string | null | undefined): string {
    if (!id) return this.i18n.t('common.none');
    const model = this.enabledModels().find(m => m.id === id || m.modelId === id);
    return model?.displayName || id;
  }

  projectTooltip(project: Project): string {
    const chats = this.getChatCount(project.id);
    return [
      project.name,
      this.i18n.t(chats === 1 ? 'sidebar.storiesCountOne' : 'sidebar.storiesCountMany', { count: chats }),
      this.i18n.t('sidebar.created', { when: this.formatWhen(project.createdAt) }),
      this.i18n.t('sidebar.updated', { when: this.formatWhen(project.updatedAt) }),
      this.i18n.t('sidebar.defaultModel', { model: this.modelLabel(project.defaultModelId) })
    ].join('\n');
  }

  chatTooltip(chat: Chat): string {
    const beats = chat.node_number ?? 0;
    return [
      chat.title || this.i18n.t('sidebar.untitledStory'),
      this.i18n.t(beats === 1 ? 'sidebar.beatsOne' : 'sidebar.beatsMany', { count: beats }),
      this.i18n.t('sidebar.created', { when: this.formatWhen(chat.created_at) }),
      this.i18n.t('sidebar.updated', { when: this.formatWhen(chat.updated_at) })
    ].join('\n');
  }

  isCurrentProject(projectId: string | null): boolean {
    return this.currentProjectId() === (projectId || null);
  }

  getAnswerCount(_chat: Chat): number {
    return 2;
  }

  async goToPersonas() {
    await this.router.navigate(['/personas']);
  }
}

function compareChatNodes(left: ChatNode[], right: ChatNode[]): ChatComparison {
  type ProjectionMode = 'structure' | 'versions' | 'content' | 'attachments';
  const project = (nodes: ChatNode[], mode: ProjectionMode) => {
    const byParent = new Map<string | null, ChatNode[]>();
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      const siblings = byParent.get(node.parentId) ?? [];
      siblings.push(node);
      byParent.set(node.parentId, siblings);
    }

    const visited = new Set<string>();
    let invalid = false;
    const groupsForParent = (parentId: string | null, ancestors: Set<string>): unknown[] => {
      const siblings = byParent.get(parentId) ?? [];
      const siblingIds = new Set(siblings.map(node => node.id));
      const nextVersion = new Map<string, ChatNode>();
      for (const node of siblings) {
        if (node.previousVersionId && siblingIds.has(node.previousVersionId)) {
          nextVersion.set(node.previousVersionId, node);
        }
      }

      const roots = siblings.filter(node => !node.previousVersionId || !siblingIds.has(node.previousVersionId));
      const used = new Set<string>();
      const groups: ChatNode[][] = [];
      const addChain = (root: ChatNode) => {
        const chain: ChatNode[] = [];
        let current: ChatNode | undefined = root;
        while (current && !used.has(current.id)) {
          used.add(current.id);
          chain.push(current);
          current = nextVersion.get(current.id);
        }
        if (chain.length) groups.push(chain);
      };
      roots.forEach(addChain);
      siblings.filter(node => !used.has(node.id))
        .sort((a, b) => a.version - b.version)
        .forEach(addChain);

      // Siblings are an unordered set for comparison purposes. Canonicalize
      // each branch by its selected comparison data rather than relying on
      // position, insertion order, or database IDs to align its counterpart.
      const projected = groups.map(group => group.map(node => {
        if (ancestors.has(node.id) || visited.has(node.id)) {
          invalid = true;
          return { cycle: true };
        }
        visited.add(node.id);
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(node.id);
        const result: Record<string, unknown> = {
          role: node.role,
          children: groupsForParent(node.id, nextAncestors)
        };
        if (mode !== 'versions') result['current'] = node.isCurrent;
        if (mode === 'versions') result['version'] = node.version ?? 1;
        if ((mode === 'content' && node.isCurrent) || (mode === 'versions' && !node.isCurrent)) {
          result['content'] = node.content ?? '';
        }
        if ((mode === 'attachments' && node.isCurrent) || (mode === 'versions' && !node.isCurrent)) {
          result['attachments'] = (node.attachments ?? []).map(({ id: _id, ...attachment }) => attachment);
        }
        return result;
      }));
      projected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return projected;
    };

    const shape = groupsForParent(null, new Set());
    return { shape, valid: !invalid && visited.size === nodes.length };
  };

  const leftStructure = project(left, 'structure');
  const rightStructure = project(right, 'structure');
  const structureIdentical = leftStructure.valid && rightStructure.valid &&
    JSON.stringify(leftStructure.shape) === JSON.stringify(rightStructure.shape);
  const leftVersions = project(left, 'versions');
  const rightVersions = project(right, 'versions');
  const olderVersionsIdentical = structureIdentical && leftVersions.valid && rightVersions.valid &&
    JSON.stringify(leftVersions.shape) === JSON.stringify(rightVersions.shape);
  const leftContent = project(left, 'content');
  const rightContent = project(right, 'content');
  const contentsIdentical = structureIdentical && leftContent.valid && rightContent.valid &&
    JSON.stringify(leftContent.shape) === JSON.stringify(rightContent.shape);
  const leftAttachments = project(left, 'attachments');
  const rightAttachments = project(right, 'attachments');
  const attachmentsIdentical = structureIdentical && leftAttachments.valid && rightAttachments.valid &&
    JSON.stringify(leftAttachments.shape) === JSON.stringify(rightAttachments.shape);
  return { structureIdentical, olderVersionsIdentical, contentsIdentical, attachmentsIdentical };
}

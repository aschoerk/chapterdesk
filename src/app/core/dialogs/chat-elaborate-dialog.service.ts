import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatService } from '../chat/chat.service';
import { ProjectService } from '../settings/project.service';
import { PromptDefaultsService } from '../prompts/prompt-defaults.service';

/** Per-chat continuation state remembered for the Elaborate dialog. */
export interface ElaborateState {
  lastChapter: number;
  characters: string;
  hints: string;
  prefix: string;
}

/**
 * Owns the open state of the Elaborate dialog (first/last chapter + names +
 * prefix + hints + stick-to-last + model) and its per-chat localStorage
 * persistence — the dialog STATE that used to live inside ChatComponent.
 * Mirrors the dialog services in this folder (IllustrateDialogService /
 * PrependDialogService / LightboxService): the state lives here; the LLM
 * orchestration that `confirmElaborate()` runs stays in the component and
 * reads/writes through this service.
 */
@Injectable({ providedIn: 'root' })
export class ChatElaborateDialogService {
  /** Per-chat Elaborate continuation state (localStorage). */
  private static readonly LS_ELABORATE = 'chat-client.elaborate.byChatId';

  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly promptDefaults = inject(PromptDefaultsService);

  readonly show = signal(false);
  readonly first = signal(1);
  readonly last = signal(1);
  readonly names = signal('');
  readonly prefix = signal('');
  readonly hints = signal('');
  /** When checked, the dialog ignores First/Last and re-elaborates the chapter
   *  that was last elaborated, chaining onto its already generated text. */
  readonly stickLast = signal(false);
  /** Model used for every elaboration. Initialised to the model of the most
   *  recent assistant answer; can be overridden in the dialog. */
  readonly modelId = signal<string>('');

  /**
   * Live preview of the FIRST elaboration prompt that confirmElaborate() will
   * send — mirrors its template/vars selection (topic-scoped), so the user
   * sees the actual prompt before confirming. Reactive to every dialog input.
   */
  readonly preview = computed<{
    text: string;
    templateLabel: string;
    count: number;
  } | null>(() => {
    const chatId = this.chatService.currentChatId();
    if (!chatId) return null;
    const topicId = this.topicId(chatId);
    const prefix = this.prefix().trim();
    const hints = this.hintsText();
    const names = this.names()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // Chapter actually used for the FIRST prompt ("stick to last" resolves to
    // the stored last chapter of this chat, like confirmElaborate() does).
    let first = Math.max(this.first(), 1);
    let last = this.last();
    if (this.stickLast()) {
      const state = this.loadState(chatId);
      const stick = state.lastChapter > 0 ? state.lastChapter : Math.max(last, 1);
      first = stick;
      last = stick;
    }

    const template = names.length > 0 ? 'structure.elaborate-view' : 'structure.elaborate';
    const vars = {
      chapter: `${prefix}${first}`,
      hints,
      ...(names.length > 0 ? { name: names[0], isFirst: !this.stickLast() } : {})
    };
    const text = this.promptDefaults.render(template, vars, topicId);
    const chapters = Math.max(last - first + 1, 1);
    const count = names.length > 0 ? names.length * chapters : chapters;
    return {
      text,
      templateLabel: this.promptDefaults.def(template)?.label ?? template,
      count
    };
  });

  /** Per-chat continuation state for the Elaborate dialog. */
  loadState(chatId: string): ElaborateState {
    try {
      const raw = localStorage.getItem(ChatElaborateDialogService.LS_ELABORATE);
      const map = raw ? JSON.parse(raw) : {};
      const entry = map?.[chatId];
      if (entry && typeof entry.lastChapter === 'number' && Number.isFinite(entry.lastChapter)) {
        return {
          lastChapter: Math.max(0, Math.floor(entry.lastChapter)),
          characters: typeof entry.characters === 'string' ? entry.characters : '',
          hints: typeof entry.hints === 'string' ? entry.hints : '',
          prefix: typeof entry.prefix === 'string' ? entry.prefix : '',
        };
      }
    } catch {
      /* corrupted / blocked storage — start fresh */
    }
    return { lastChapter: 0, characters: '', hints: '', prefix: '' };
  }

  saveState(chatId: string, state: ElaborateState): void {
    try {
      const raw = localStorage.getItem(ChatElaborateDialogService.LS_ELABORATE);
      const map = raw ? JSON.parse(raw) : {};
      map[chatId] = state;
      localStorage.setItem(ChatElaborateDialogService.LS_ELABORATE, JSON.stringify(map));
    } catch {
      /* best-effort; never block elaboration on storage failure */
    }
  }

  /** The dialog hints formatted for the `{{hints}}` template placeholder
   *  (empty string when no hints were given, so empty templates stay clean). */
  hintsText(): string {
    const hints = this.hints().trim();
    return hints ? `\nFollow these hints from the user: ${hints}` : '';
  }

  /** Topic-scoped prompt versions apply to the chat's environment topic. */
  topicId(chatId: string | null): string | null {
    const chat = chatId
      ? this.chatService.chats().find(c => c.id === chatId) ?? null
      : null;
    const project = chat?.projectId
      ? this.projectService.getProject(chat.projectId) ?? null
      : null;
    return this.projectService
      .topicForProject(project?.id, this.projectService.topics())?.id ?? null;
  }

  /** Toggle "stick to last chapter". While checked the First/Last fields are
   *  disabled and shown as the single chapter last elaborated for this chat;
   *  unchecking restores the default continuation (= last elaborated + 1). */
  onStickLastToggle(checked: boolean, chatId: string | null): void {
    this.stickLast.set(!!checked);
    if (!chatId) return;
    const state = this.loadState(chatId);
    if (checked) {
      const stick = state.lastChapter > 0
        ? state.lastChapter
        : Math.max(this.last(), 1);
      this.first.set(stick);
      this.last.set(stick);
      // Sticking to the last chapter re-elaborates existing text, so any
      // characters/hints only make sense for fresh chapters — clear them.
      this.names.set('');
      this.hints.set('');
    } else {
      const next = Math.max(state.lastChapter + 1, 1);
      this.first.set(next);
      this.last.set(next);
    }
  }

  /** Close the dialog (used by Cancel and Escape). */
  close(): void {
    this.show.set(false);
  }
}
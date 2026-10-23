import { Injectable, inject } from '@angular/core';
import { Chat } from '../../../../models/chat';
import { ProjectService } from '../../../settings/project.service';

/**
 * The per-run PROMPT-TOPIC scope shared by the request-builder services.
 *
 * The runners call `setPromptTopic(topicIdForChat(chat))` once at the start of
 * every `run()`; every prompt-building method (in `prompts.ts`) and the
 * interpret-prompt (`messages.ts`) read `promptTopic` to resolve topic-scoped
 * prompt versions. Keeping this mutable per-run state in its own tiny service
 * lets the model/message/prompt builders be independent injectables without a
 * god-class or hand-passed state.
 */
@Injectable({ providedIn: 'root' })
export class ContextTopicService {
  private readonly projectService = inject(ProjectService);

  private _promptTopic: string | null = null;

  /** The topic whose prompt versions apply to the request currently being built. */
  get promptTopic(): string | null {
    return this._promptTopic;
  }

  /** Set the topic used to resolve topic-scoped prompt versions. */
  setPromptTopic(topicId: string | null): void {
    this._promptTopic = topicId;
  }

  /** Topic bound to a chat's environment (its main topic), or null. */
  topicIdForChat(chat: Chat | null): string | null {
    if (!chat) return null;
    const project = chat.projectId
      ? this.projectService.getProject(chat.projectId) ?? null
      : null;
    if (!project) return null;
    const topic = this.projectService.topicForProject(project.id, this.projectService.topics());
    return topic?.id ?? null;
  }
}
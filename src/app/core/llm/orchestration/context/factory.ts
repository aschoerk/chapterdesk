import { Injectable, inject } from '@angular/core';
import { Chat, ChatMessage, ChatNode } from '../../../../models/chat';
import { ModelEntry } from '../../../../models/chat-config';
import type { UsecaseContext } from '../types';
import type { BuildContext, ModelRef, NodeAttachmentLike } from './types';
import { ContextTopicService } from './topic';
import { ContextModelResolverService } from './models';
import { ContextMessageBuilderService } from './messages';
import { ContextPromptBuilderService } from './prompts';

/**
 * LlmUsecaseContextFactory — facade of the decomposed request builder.
 *
 * The implementation lives in four single-responsibility services:
 *   – ContextTopicService       (per-run prompt-topic scope state)
 *   – ContextModelResolverService (model/provider resolution + request extras)
 *   – ContextMessageBuilderService (chat-thread messages + image interpretation)
 *   – ContextPromptBuilderService  (instruction / prompt-template builders)
 *
 * It keeps the SAME public surface the original `UsecaseContextFactory` had,
 * so every existing consumer (the use-case runners, the flows, the
 * orchestration barrel) works unchanged.
 */
@Injectable({ providedIn: 'root' })
export class UsecaseContextFactory {
  private readonly topicService = inject(ContextTopicService);
  private readonly models = inject(ContextModelResolverService);
  private readonly messages = inject(ContextMessageBuilderService);
  private readonly prompts = inject(ContextPromptBuilderService);

  // -------------------------------------------------------------- topic scope

  /** Set the topic used to resolve topic-scoped prompt versions. */
  setPromptTopic(topicId: string | null): void {
    this.topicService.setPromptTopic(topicId);
  }

  /** Topic bound to a chat's environment (its main topic), or null. */
  topicIdForChat(chat: Chat | null): string | null {
    return this.topicService.topicIdForChat(chat);
  }

  // ------------------------------------------------------------- build context

  /** Build a static use-case context from a build request. */
  buildContext(build: BuildContext): UsecaseContext {
    return {
      chat: build.chat as Chat,
      node: build.node as ChatNode,
      usecase: build.usecase,
      vars: build.vars
    };
  }

  // ------------------------------------------------------------ model resolvers

  /** Provider of a model, or null. */
  providerFor(model: ModelEntry | null | undefined) {
    return this.models.providerFor(model);
  }

  /** Resolve the RENDERING (image) model. */
  resolveImageModel(modelId?: string | null, providerId?: string | null): ModelRef | null {
    return this.models.resolveImageModel(modelId, providerId);
  }

  /** Resolve the WRITING model for a plain text send. */
  resolveWriteModel(node: ChatNode | null, modelId?: string | null, providerId?: string | null): ModelRef | null {
    return this.models.resolveWriteModel(node, modelId, providerId);
  }

  /** Resolve the RENDERING model (image-create task / fallback). */
  resolveRenderModel(): ModelRef | null {
    return this.models.resolveRenderModel();
  }

  /** Resolve the PLANNING model (text model that derives picture descriptions). */
  resolvePlanModel(render: ModelRef, node: ChatNode | null): ModelRef {
    return this.models.resolvePlanModel(render, node);
  }

  /** Resolve the IMAGE-INTERPRET model. */
  resolveInterpretModel(): ModelRef | null {
    return this.models.resolveInterpretModel();
  }

  /** Image-mode request extras (non-streaming, no temp/thinking). */
  resolveExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    return this.models.resolveExtras(model, chat);
  }

  /** Full text-send request extras (temp/thinking/stream). */
  resolveTextExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    return this.models.resolveTextExtras(model, chat);
  }

  // ------------------------------------------------------------------ messages

  /** Context messages up to (and including) the node on the active path. */
  buildContextMessagesUpTo(chatId: string, nodeId: string | null): ChatMessage[] {
    return this.messages.buildContextMessagesUpTo(chatId, nodeId);
  }

  /** Context messages from the last `assistantCount` ASSISTANT beats. */
  buildContextMessagesWindow(chatId: string, nodeId: string | null, assistantCount: number): ChatMessage[] {
    return this.messages.buildContextMessagesWindow(chatId, nodeId, assistantCount);
  }

  /** Strip media parts → text-only messages. */
  textOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
    return this.messages.textOnlyMessages(messages);
  }

  /** Full chat up to (and including) the current node as messages. */
  buildSendMessages(chatId: string, nodeId: string | null, contentOverride?: string): ChatMessage[] {
    return this.messages.buildSendMessages(chatId, nodeId, contentOverride);
  }

  /** Extended send-message builder (extra pre-final messages + topic system prompt). */
  buildSendMessagesEx(opts: {
    chatId: string;
    nodeId: string | null;
    contentOverride?: string;
    beforeFinal?: ChatMessage[];
  }): ChatMessage[] {
    return this.messages.buildSendMessagesEx(opts);
  }

  /** Topic system prompt for a chat, or null. */
  topicSystemPrompt(chat: Chat | null): string | null {
    return this.messages.topicSystemPrompt(chat);
  }

  // -------------------------------------------------------- image interpretation

  /** The image-interpret prompt template. */
  imageInterpretPrompt(): string {
    return this.messages.imageInterpretPrompt();
  }

  /** The data-URL image attachments of a node/draft. */
  imageAttachments(attachments: NodeAttachmentLike[] | undefined | null): NodeAttachmentLike[] {
    return this.messages.imageAttachments(attachments);
  }

  /** Build the image-interpret message (prompt + image_url parts). */
  buildInterpretMessage(images: NodeAttachmentLike[]): ChatMessage[] {
    return this.messages.buildInterpretMessage(images);
  }

  /** THE image-interpretation rule (interpret only when not stored). */
  needsImageInterpretation(
    node: Pick<ChatNode, 'content' | 'attachments'>,
    draftImages?: NodeAttachmentLike[] | null
  ): boolean {
    return this.messages.needsImageInterpretation(node, draftImages);
  }

  /** Build the stored image-description record attachment. */
  buildImageDescriptionRecord(images: NodeAttachmentLike[], description: string): NodeAttachmentLike {
    return this.messages.buildImageDescriptionRecord(images, description);
  }

  /** Merge a fresh image description into the direction text. */
  mergeDirectionWithDescription(directionText: string, description: string): string {
    return this.messages.mergeDirectionWithDescription(directionText, description);
  }

  /** Drop a stored image-description record from an attachment list. */
  withoutImageDescriptionRecord(attachments: NodeAttachmentLike[] | undefined | null): NodeAttachmentLike[] {
    return this.messages.withoutImageDescriptionRecord(attachments);
  }

  // ------------------------------------------------------------------ prompts

  /** The image-create task prompt (or its built-in default). */
  drawingInstruction(): string {
    return this.prompts.drawingInstruction();
  }

  /** Style-wrapped drawing instruction. */
  styledDrawingInstruction(style: string | undefined): string {
    return this.prompts.styledDrawingInstruction(style);
  }

  /** Instruction for a structure-generation task. */
  structureInstruction(task: 'title' | 'overview' | 'headings'): string {
    return this.prompts.structureInstruction(task);
  }

  /** The language-check instruction. */
  englishCheckInstruction(): string {
    return this.prompts.englishCheckInstruction();
  }

  /** The chapter-description-list instruction. */
  chapterDescriptionsInstruction(): string {
    return this.prompts.chapterDescriptionsInstruction();
  }

  /** The rewrite-selection instruction. */
  rewriteInstruction(): string {
    return this.prompts.rewriteInstruction();
  }

  /** The story-scope instruction for the planning model. */
  illustrationScopeText(historyMode?: import('../types').UsecaseVars['historyMode'], historyNodes?: number): string {
    return this.prompts.illustrationScopeText(historyMode, historyNodes);
  }

  /** The planner instruction (image.planning template). */
  picturePlanningInstruction(total: number, extra?: string, scope?: string): string {
    return this.prompts.picturePlanningInstruction(total, extra, scope);
  }

  /** The SCENE-oriented planner instruction (image.planning-scenes template). */
  pictureScenePlanningInstruction(total: number, extra?: string, scope?: string): string {
    return this.prompts.pictureScenePlanningInstruction(total, extra, scope);
  }

  /** The one-shot storyboard prompt (image.one-shot template). */
  oneShotStoryboardPrompt(basePrompt: string, descriptions: string[], total: number, extra?: string): string {
    return this.prompts.oneShotStoryboardPrompt(basePrompt, descriptions, total, extra);
  }

  /** The SCENE-oriented one-shot storyboard prompt (image.one-shot-scenes template). */
  oneShotScenesPrompt(basePrompt: string, descriptions: string[], total: number, extra?: string): string {
    return this.prompts.oneShotScenesPrompt(basePrompt, descriptions, total, extra);
  }

  /** The pure-picture en-block prompt (image.pure template). */
  purePicturesPrompt(sceneInstruction: string, descriptions: string[], total: number, extra?: string): string {
    return this.prompts.purePicturesPrompt(sceneInstruction, descriptions, total, extra);
  }

  /** Per-scene storyboard instruction (image.storyboard template). */
  storyboardInstruction(index: number, total: number, extra?: string): string {
    return this.prompts.storyboardInstruction(index, total, extra);
  }
}
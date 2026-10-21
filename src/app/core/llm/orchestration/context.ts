import { inject, Injectable } from '@angular/core';
import { Chat, ChatMessage, ChatNode } from '../../../models/chat';
import { ModelEntry, ProviderConfig } from '../../../models/chat-config';
import { ResolvedChatParameters } from '../../../models/chat-parameters';
import { ChatParametersService } from '../../chat-parameters.service';
import { ChatService } from '../../chat.service';
import { GenerationSettingsService } from '../../generation-settings.service';
import { ProjectService } from '../../project.service';
import { PromptDefaultsService } from '../../prompt-defaults.service';
import { SettingsService } from '../../settings.service';
import { canInterpretImages, canGenerateImages } from '../../../models/chat-config';
import { messageText, nodeToMessageContent, isImageMime, resolvedMime, decodeDataUrlToText } from '../llm-message';
import type { UsecaseContext, UsecaseVars } from './types';

/**
 * Name of the stored image-description record attachment. When a user node
 * carries this record (and its image signature matches the node's current
 * data: image attachments), the image descriptions are ALREADY part of the
 * node's text — interpretation must NOT run again.
 */
export const IMAGE_DESCRIPTION_RECORD = 'image-description.txt';
const IMAGE_DESCRIPTION_RECORD_RE = /^image-description\.txt$/i;

/** True when an attachment is the stored image-description record. */
export function isImageDescriptionRecord(a: Pick<NodeAttachmentLike, 'name'>): boolean {
  return IMAGE_DESCRIPTION_RECORD_RE.test(a?.name ?? '');
}

/** Stable signature of an image set (used to detect already-interpreted). */
function imageSetSignature(images: NodeAttachmentLike[]): string[] {
  return [...images]
    .map(img => {
      const data = img?.dataUrl ?? '';
      const comma = data.indexOf(',');
      const payload = comma >= 0 ? data.slice(comma + 1) : data;
      // Small, stable fingerprint per image: mime | length | tail-24.
      return `${img?.mimeType ?? 'image'}|${payload.length}|${payload.slice(-24)}`;
    })
    .sort();
}

/** The stored image-description record (parsed), or null. */
export interface StoredImageDescription {
  images: string[];
  description: string;
}

function parseStoredImageDescription(attachments: NodeAttachmentLike[] | undefined | null): StoredImageDescription | null {
  const rec = (attachments ?? []).find(isImageDescriptionRecord);
  if (!rec) return null;
  try {
    const text = decodeDataUrlToText(rec.dataUrl);
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      images: Array.isArray(parsed.images) ? parsed.images.map(String) : [],
      description: typeof parsed.description === 'string' ? parsed.description : ''
    };
  } catch {
    return null;
  }
}

/**
 * One resolved model + provider pair (rendering or planning role).
 */
export interface ModelRef {
  model: ModelEntry;
  provider: ProviderConfig;
}

export interface BuildContext {
  chat: Chat | null;
  node: ChatNode | null;
  usecase: UsecaseContext['usecase'];
  vars: UsecaseVars;
}

/**
 * LlmUsecaseContextFactory — builds the static use-case context (chat + node
 * + vars), resolves a rendering/planning model and provider, and provides all
 * the MESSAGE / PROMPT building helpers the 5 use cases need. It is the
 * "request builder" of the new layer: it knows templates and context, never
 * the transport or the chat mutation. It reuses existing services only.
 */
@Injectable({ providedIn: 'root' })
export class UsecaseContextFactory {
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly parameters = inject(ChatParametersService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);

  /**
   * The topic whose prompt versions apply to the request currently being
   * built. Set by the runners from the request's chat (its environment's main
   * topic) at the start of each `run()`. Null = no topic scope.
   */
  private promptTopic: string | null = null;

  /** Set the topic used to resolve topic-scoped prompt versions. */
  setPromptTopic(topicId: string | null): void {
    this.promptTopic = topicId;
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

  /** Enabled image-capable models, sorted by display name. */
  private enabledImageModels(): ModelEntry[] {
    return this.settings.enabledModels().filter(canGenerateImages);
  }

  /** Enabled image-INTERPRET models (planner fallback), if any. */
  private enabledInterpretModels(): ModelEntry[] {
    return this.settings.enabledModels().filter(canInterpretImages);
  }

  /** Provider of a model, or null. */
  providerFor(model: ModelEntry | null | undefined): ProviderConfig | null {
    if (!model) return null;
    return this.settings.providers().find(p => p.id === model.providerId) ?? null;
  }

  /**
   * Resolve the RENDERING (image) model: prefers an explicit dialog choice
   * (`modelId`/`providerId`, e.g. from the Illustrate dialog), falling back
   * to the configured image-create task / first enabled image-capable model.
   *
   * The explicitly chosen model ALWAYS wins once it is enabled — even when
   * the accompanying `providerId` is stale/empty (a remembered dialog choice
   * whose provider was renamed/removed): in that case the model's OWN
   * provider is used. Silently dropping the chosen model for a stale provider
   * id would swap it for the settings default, which users experience as
   * "the model I selected is ignored".
   */
  resolveImageModel(modelId?: string | null, providerId?: string | null): ModelRef | null {
    if (modelId) {
      const m = this.settings.enabledModels().find(
        mm => mm.modelId === modelId || mm.id === modelId
      );
      if (m) {
        // Prefer the caller's provider when it still resolves; otherwise use
        // the model's own provider. Only when neither exists (model enabled
        // but provider gone) do we fall through to the task default.
        const p = (providerId && this.settings.providers().some(pp => pp.id === providerId))
          ? this.settings.providers().find(pp => pp.id === providerId)!
          : this.providerFor(m);
        if (p) return { model: m, provider: p };
      }
    }
    return this.resolveRenderModel();
  }

  /**
   * Resolve the WRITING model for a plain text send (`append`, structural
   * flows): an explicit override (e.g. a model chosen in a dialog) wins;
   * otherwise the current node's own model when resolvable, else the first
   * enabled model.
   */
  resolveWriteModel(node: ChatNode | null, modelId?: string | null, providerId?: string | null): ModelRef | null {
    if (modelId) {
      const explicit = this.settings.enabledModels().find(m => m.modelId === modelId || m.id === modelId);
      if (explicit) {
        const provider = providerId
          ? this.settings.providers().find(p => p.id === providerId)
          : this.providerFor(explicit);
        if (provider) return { model: explicit, provider };
      }
    }
    const nodeModelId = node?.modelId;
    let model = nodeModelId
      ? this.settings.enabledModels().find(m => m.modelId === nodeModelId || m.id === nodeModelId)
      : null;
    if (!model) model = this.generation.modelFor('default');
    if (!model) model = this.settings.enabledModels()[0] ?? null;
    if (!model) return null;
    const provider = this.providerFor(model);
    return provider ? { model, provider } : null;
  }

  /**
   * Resolve the RENDERING model: the configured "image-create" task model,
   * falling back to the first enabled image-capable model.
   */
  resolveRenderModel(): ModelRef | null {
    let model = this.generation.modelFor('image-create');
    let provider = this.generation.providerFor('image-create');
    if (!model || !provider) {
      const fallback = this.enabledImageModels()[0] ?? null;
      model = fallback;
      provider = fallback ? this.providerFor(fallback) : null;
    }
    return model && provider ? { model, provider } : null;
  }

  /**
   * Resolve the PLANNING model (text model that derives picture
   * descriptions): 1. the node's own writing model if still resolvable;
   * 2. the image-interpret / language-check task; 3. the rendering model.
   */
  resolvePlanModel(render: ModelRef, node: ChatNode | null): ModelRef {
    const nodeModelId = node?.modelId;
    const nodeModel = nodeModelId
      ? this.settings.enabledModels().find(m => m.modelId === nodeModelId || m.id === nodeModelId)
      : null;
    if (nodeModel && nodeModel.id !== render.model.id) {
      const provider = this.providerFor(nodeModel);
      if (provider) return { model: nodeModel, provider };
    }
    for (const kind of ['image-interpret', 'language-check'] as const) {
      const model = this.generation.modelFor(kind);
      const provider = this.generation.providerFor(kind);
      if (model && provider) return { model, provider };
    }
    return render;
  }

  /** Build a static use-case context from a build request. */
  buildContext(build: BuildContext): UsecaseContext {
    return {
      chat: build.chat as Chat,
      node: build.node as ChatNode,
      usecase: build.usecase,
      vars: build.vars
    };
  }

  /**
   * Resolve the parameters (temperature/thinking/…) + request extras for a
   * model in the CURRENT chat, mirroring the legacy resolution.
   */
  async resolveExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    const resolved = await this.resolveForChat(model, chat);
    const extras = this.toLlmExtras(resolved);
    // Image generation is non-streaming, single completion.
    delete extras['temperature'];
    delete extras['top_k'];
    delete extras['top_p'];
    delete extras['include_reasoning'];
    delete extras['reasoning'];
    return extras;
  }

  /**
   * Resolve FULL text extras (temperature, thinking, stream) for a plain
   * text send (`append`). Keeps everything the legacy text path sends.
   */
  async resolveTextExtras(model: ModelEntry, chat: Chat | null): Promise<Record<string, unknown>> {
    const resolved = await this.resolveForChat(model, chat);
    return this.toLlmExtras(resolved);
  }

  /**
   * Resolve the IMAGE-INTERPRET model (describes attached images before a
   * send): the configured "image-interpret" task model, falling back to the
   * first enabled model that can take image input. Null when none exists.
   */
  resolveInterpretModel(): ModelRef | null {
    let model = this.generation.modelFor('image-interpret');
    let provider = this.generation.providerFor('image-interpret');
    if (!model || !provider) {
      const fallback = this.settings.enabledModels().find(canInterpretImages) ?? null;
      model = fallback;
      provider = fallback ? this.providerFor(fallback) : null;
    }
    return model && provider ? { model, provider } : null;
  }

  /** The image-interpret prompt template (image.interpret default/override). */
  imageInterpretPrompt(): string {
    return this.promptDefaults.effective('image.interpret', this.promptTopic);
  }

  /**
   * The image attachments of a node/draft that should be interpreted:
   * data-URL images only (the only ones the client can send to a model).
   */
  imageAttachments(attachments: NodeAttachmentLike[] | undefined | null): NodeAttachmentLike[] {
    return (attachments ?? []).filter(
      a => isImageMime(resolvedMime(a)) && a.dataUrl?.startsWith('data:')
    );
  }

  /**
   * Build the message for the image-interpret call: the interpret prompt as
   * text + every attached image as an image_url part — the writing model
   * never sees the raw binaries.
   */
  buildInterpretMessage(images: NodeAttachmentLike[]): ChatMessage[] {
    // nodeToMessageContent only needs content + attachments; hand-attached
    // images become image_url parts (prompt-record meta is filtered out).
    const content = nodeToMessageContent({
      content: this.imageInterpretPrompt(),
      attachments: images as ChatNode['attachments']
    } as Pick<ChatNode, 'content' | 'attachments'>);
    return [{ role: 'user', content }];
  }

  /**
   * THE image-interpretation rule: images are interpreted ONLY when their
   * descriptions have NOT been stored in the node yet. A node "has stored
   * them" when it carries an `image-description.txt` record whose image
   * signature matches its current data: attachments AND its content already
   * ends with the stored description (the description was merged into the
   * text on a previous send). This prevents re-interpreting + re-merging on
   * every re-send (regenerate / rewrite / branch of an already-interpreted
   * direction).
   *
   * @param node the user node being sent
   * @param draftImages the attachments of the current draft (when editing),
   *   else the node's own attachments.
   */
  needsImageInterpretation(
    node: Pick<ChatNode, 'content' | 'attachments'>,
    draftImages?: NodeAttachmentLike[] | null
  ): boolean {
    const images = this.imageAttachments(draftImages ?? node.attachments);
    if (images.length === 0) return false;
    const stored = parseStoredImageDescription(node.attachments);
    if (!stored || !stored.description.trim()) return true;
    const sig = imageSetSignature(images);
    if (JSON.stringify(sig) !== JSON.stringify([...(stored.images ?? [])].sort())) return true;
    // The description must actually be part of the stored text.
    const content = (node.content ?? '').trim();
    return !content.includes(stored.description.trim());
  }

  /**
   * Build the stored image-description record attachment. It is a text
   * record (like prompt-N.txt) that is EXCLUDED from LLM context, so it never
   * travels to a model — it only marks "these images were interpreted and
   * their description is part of this node's text".
   */
  buildImageDescriptionRecord(
    images: NodeAttachmentLike[],
    description: string
  ): NodeAttachmentLike {
    const rec: StoredImageDescription = { images: imageSetSignature(images), description };
    return {
      id: newIdOrEmpty(),
      name: IMAGE_DESCRIPTION_RECORD,
      mimeType: 'text/plain',
      size: rec.description.length + rec.images.length * 32,
      dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(JSON.stringify(rec))}`
    };
  }

  /**
   * Merge a fresh image description into the direction text (no UI prefix) —
   * the exact text that is sent to the writing model and persisted on the
   * node so it lives in the history.
   */
  mergeDirectionWithDescription(directionText: string, description: string): string {
    const dir = (directionText ?? '').trim();
    const desc = (description ?? '').trim();
    if (!desc) return dir;
    return dir ? `${dir}\n\n${desc}` : desc;
  }

  /** Drop a stored image-description record from an attachment list. */
  withoutImageDescriptionRecord(attachments: NodeAttachmentLike[] | undefined | null): NodeAttachmentLike[] {
    return (attachments ?? []).filter(a => !isImageDescriptionRecord(a));
  }

  private async resolveForChat(model: ModelEntry, chat: Chat | null): Promise<ResolvedChatParameters> {
    const project = chat?.projectId ? this.projectService.getProject(chat.projectId) ?? null : null;
    const topic = this.projectService.topicForProject(project?.id, this.projectService.topics()) ?? null;
    await this.parameters.loadMany([
      model.chatParametersId,
      topic?.chatParametersId,
      project?.chatParametersId,
      chat?.chatParametersId
    ]);
    return this.parameters.resolveForChat({ model, topic, project, chat });
  }

  /** Port of the legacy toLlmExtras(). */
  private toLlmExtras(resolved: ResolvedChatParameters): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    if (resolved.temperature != null) extras['temperature'] = resolved.temperature;
    if (resolved.topK != null) extras['top_k'] = resolved.topK;
    if (resolved.topM != null) extras['top_p'] = resolved.topM;
    extras['stream'] = resolved.stream ?? true;
    if (resolved.thinking === false) {
      extras['include_reasoning'] = false;
      return extras;
    }
    if (resolved.thinking === true || resolved.thinkingLevel) {
      extras['include_reasoning'] = true;
      if (resolved.thinkingLevel && resolved.thinkingLevel !== 'none') {
        extras['reasoning'] = { effort: resolved.thinkingLevel };
      } else if (resolved.thinkingLevel === 'none') {
        extras['include_reasoning'] = false;
      } else {
        extras['reasoning'] = { enabled: true };
      }
    }
    return extras;
  }

  /** The task prompt (or its built-in default) for the image-create task. */
  drawingInstruction(): string {
    return this.generation.get('image-create').prompt.trim()
      || this.promptDefaults.effective('image.create', this.promptTopic);
  }

  /** Style-wrapped drawing instruction. */
  styledDrawingInstruction(style: string | undefined): string {
    const base = this.drawingInstruction();
    return style && style.trim()
      ? `${base}\n\nStyle: ${style.trim()}`
      : base;
  }

  /**
   * Instruction for a structure-generation task (`structure.title` /
   * `structure.overview` / `structure.headings`): the per-task prompt override
   * when configured, else the editable prompt default.
   */
  structureInstruction(task: 'title' | 'overview' | 'headings'): string {
    const prompt = this.generation.get(task).prompt.trim();
    if (prompt) return prompt;
    if (task === 'title') return this.promptDefaults.effective('structure.title', this.promptTopic);
    if (task === 'overview') return this.promptDefaults.effective('structure.overview', this.promptTopic);
    return this.promptDefaults.effective('structure.headings', this.promptTopic);
  }

  /** The language-check instruction (config override or built-in default). */
  englishCheckInstruction(): string {
    const prompt = this.generation.get('language-check').prompt.trim();
    return prompt || this.promptDefaults.effective('language.check', this.promptTopic);
  }

  /**
   * Instruction for the chapter-description-list task (editable prompt
   * default). The concrete parameters (chapter count, sentences per
   * description, first chapter number, goal) are appended by the flow as
   * structured lines.
   */
  chapterDescriptionsInstruction(): string {
    return this.promptDefaults.effective('structure.chapterDescriptions', this.promptTopic);
  }

  /** The rewrite-selection instruction (editable prompt default). */
  rewriteInstruction(): string {
    return this.promptDefaults.effective('language.rewrite', this.promptTopic);
  }

  /** Topic system prompt for a chat (reuses legacy helper conceptually). */
  topicSystemPrompt(chat: Chat | null): string | null {
    const projectId = chat?.projectId;
    if (!projectId) return null;
    const parts = this.projectService.topics()
      .filter(t => t.projectIds?.includes(projectId) && t.defaultSystemPrompt?.trim())
      .map(t => t.defaultSystemPrompt.trim());
    return parts.length ? parts.join('\n\n') : null;
  }

  /** Context messages up to (and including) the node on the active path. */
  buildContextMessagesUpTo(chatId: string, nodeId: string | null): ChatMessage[] {
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    const out: ChatMessage[] = [];
    for (const n of path) {
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      // Meta/excluded nodes (auto-continue, elaborate instructions, lore
      // documentation) are shown in the UI but never re-shipped as history.
      // The FINAL node is excluded from this rule: it is the question being
      // answered and is always sent (see buildSendMessagesEx).
      if (n.id !== nodeId && n.excludeFromContext) continue;
      const content = nodeToMessageContent(n);
      if (!content) continue;
      out.push({ role: n.role, content });
    }
    return out;
  }

  /**
   * Context messages from the last `assistantCount` ASSISTANT beats of the
   * active path up to (and including) `nodeId` — a bounded window instead of
   * the complete chat. The window size is measured in ASSISTANT nodes only
   * ("last N beats" = the last N chapters; a chapter's own user direction
   * travels with it but never counts toward N). The same filtering as
   * {@link buildContextMessagesUpTo} applies (excluded / empty-content nodes
   * are skipped). A `assistantCount` <= 0 falls back to the whole path.
   */
  buildContextMessagesWindow(chatId: string, nodeId: string | null, assistantCount: number): ChatMessage[] {
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    if (!assistantCount || assistantCount <= 0) return this.buildContextMessagesUpTo(chatId, nodeId);
    // The window keeps the LAST `assistantCount` assistant chapters. Anything
    // before the window boundary (leading assistant beats there are too old to
    // count) is excluded; the slice begins right after it, so the first kept
    // assistant brings its own direction into the window.
    const assistants = path.reduce((n, node) => n + (node.role === 'assistant' ? 1 : 0), 0);
    const skip = Math.max(0, assistants - assistantCount);
    let startIdx = 0;
    if (skip > 0) {
      let skipped = 0;
      for (let i = 0; i < path.length; i++) {
        if (path[i].role === 'assistant') {
          skipped += 1;
          if (skipped === skip) { startIdx = i + 1; break; }
        }
      }
    }
    const slice = path.slice(startIdx);
    const out: ChatMessage[] = [];
    for (const n of slice) {
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      if (n.id !== nodeId && n.excludeFromContext) continue;
      const content = nodeToMessageContent(n);
      if (!content) continue;
      out.push({ role: n.role, content });
    }
    return out;
  }

  /** Strip media parts → text-only messages (for text planning/rendering). */
  textOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return m;
      const text = messageText(m).trim();
      return { role: m.role, content: text };
    });
  }

  /**
   * The story scope the pictures should cover, as a short instruction for the
   * PLANNING (text) model — so it knows exactly how many beats it derives
   * pictures for. This matters most in pure picture mode, where the derived
   * descriptions ARE everything the image model sees:
   * - 'window': the last `historyNodes` beats up to and including the current
   *   one (the model must cover exactly those beats, not the whole story).
   * - otherwise ('single' / 'full'): the current beat, with the COMPLETE story
   *   text up to it as the established context.
   */
  illustrationScopeText(historyMode?: UsecaseVars['historyMode'], historyNodes?: number): string {
    if (historyMode === 'window' && historyNodes && historyNodes > 1) {
      return `Generate the picture(s) for the last ${historyNodes} story beats up to and including the current one — cover only those ${historyNodes} beats, do not reach back into the story before them.`;
    }
    return 'Generate the picture for the current beat. The full story text up to this beat is the established context — use it as context, but depict the current beat.';
  }

  /** The planner instruction (from the image.planning template). */
  picturePlanningInstruction(total: number, extra?: string, scope?: string): string {
    let base = this.promptDefaults.render('image.planning', { total }, this.promptTopic);
    if (scope?.trim()) base += `\n\n${scope.trim()}`;
    return extra?.trim() ? `${base}\n\nRules that apply to every picture:\n${extra.trim()}` : base;
  }

  /**
   * The SCENE-oriented planner instruction (from the image.planning-scenes
   * template). Used by `planned-scenes` as its planning prefix: it derives
   * fewer static stills and more alive, action-bearing scenes.
   */
  pictureScenePlanningInstruction(total: number, extra?: string, scope?: string): string {
    let base = this.promptDefaults.render('image.planning-scenes', { total }, this.promptTopic);
    if (scope?.trim()) base += `\n\n${scope.trim()}`;
    return extra?.trim() ? `${base}\n\nRules that apply to every picture:\n${extra.trim()}` : base;
  }

  /**
   * The FULL chat up to (and including) the current node as normal messages,
   * with the current node's text as the final USER message. Used by the
   * `append` use case (normal send + history). When `contentOverride` is
   * given (e.g. a composer draft), it replaces the current node's content.
   * The final node is ALWAYS included (even when empty, the override or an
   * empty user turn is still the question being answered).
   */
  buildSendMessages(chatId: string, nodeId: string | null, contentOverride?: string): ChatMessage[] {
    return this.buildSendMessagesEx({ chatId, nodeId, contentOverride });
  }

  /**
   * Extended variant of {@link buildSendMessages}: supports injecting extra
   * user message(s) immediately BEFORE the final question. The topic system
   * prompt is only injected once when the thread has none.
   *
   * HISTORY IS ALWAYS TEXT-ONLY: images/files attached to past nodes are never
   * sent to the LLM. They are only ever visible as their auto-generated
   * textual description inside the node content (see `append-with-images`),
   * so the binaries never leak into a request.
   */
  buildSendMessagesEx(opts: {
    chatId: string;
    nodeId: string | null;
    contentOverride?: string;
    /** Extra messages inserted right before the final user question. */
    beforeFinal?: ChatMessage[];
  }): ChatMessage[] {
    const { chatId, nodeId, contentOverride, beforeFinal } = opts;
    if (!nodeId) return [];
    const path = this.chatService.getPathToNode(nodeId);
    const out: ChatMessage[] = [];
    // All nodes EXCEPT the final one — Empties are dropped. History nodes are
    // reduced to TEXT (image_url/file parts stripped) so attached images are
    // never re-sent; the content that carries their description survives.
    for (let i = 0; i < path.length - 1; i++) {
      const n = path[i];
      if (n.chatId !== chatId) continue;
      if (n.role !== 'system' && n.role !== 'user' && n.role !== 'assistant') continue;
      // Excluded meta / lore-documentation nodes are skipped in history. The
      // final node is always included (it is the question being answered), so
      // an auto-excluded continue/elaborate direction is still sent exactly
      // once while it is the current question.
      if (n.excludeFromContext) continue;
      const text = messageText({ role: n.role, content: nodeToMessageContent(n) }).trim();
      if (!text) continue;
      out.push({ role: n.role, content: text });
    }
    // Optional in-between context (e.g. the auto-generated image description).
    if (beforeFinal) {
      for (const m of beforeFinal) {
        const text = typeof m.content === 'string' ? m.content.trim() : '';
        if (text) out.push({ role: 'user', content: text });
      }
    }
    // The final node is the question — always included.
    const last = path[path.length - 1];
    if (last && last.chatId === chatId) {
      // Text attachments are inlined into the FINAL user message too, mirroring
      // the history rule, so a text file attached to the current question is
      // actually sent. Binary/image parts stay excluded: the writing path is
      // text-only (hand-attached images are interpreted up front instead).
      const hasOverride = contentOverride !== undefined && contentOverride !== null;
      const override = (contentOverride ?? '').trim();
      const fullText = messageText({ role: last.role, content: nodeToMessageContent(last) }).trim();
      const ownText = (last.content ?? '').trim();
      let finalText: string;
      if (hasOverride) {
        // Keep the override (e.g. typed draft or interpreted text), then append
        // any inlined text attachments so they are not lost on the leaf.
        finalText = override;
        if (ownText && fullText.startsWith(ownText)) {
          const suffix = fullText.slice(ownText.length).trim();
          if (suffix) finalText = `${finalText}\n\n${suffix}`;
        } else if (fullText) {
          finalText = `${finalText}\n\n${fullText}`;
        }
      } else {
        finalText = fullText;
      }
      // An empty director is still a valid user turn (the model sees it and
      // answers from history), but as a bare user message.
      const user: ChatMessage = { role: 'user', content: finalText || '(no text)' };
      out.push(user);
    }
    // Topic system-prompt parity (legacy streamAnswer.withTopicSystemPrompt):
    // inject the topic's defaultSystemPrompt when the thread has none. Done at
    // the REQUEST BUILDER so every text use case gets the topic voice, not
    // just `append`.
    if (!out.some(m => m.role === 'system')) {
      const chat = this.chatService.chats().find(c => c.id === chatId) ?? null;
      const sys = this.topicSystemPrompt(chat);
      if (sys) out.unshift({ role: 'system', content: sys });
    }
    return out;
  }

  /** The one-shot storyboard prompt (from the image.one-shot template). */
  oneShotStoryboardPrompt(basePrompt: string, descriptions: string[], total: number, extra?: string): string {
    let text = basePrompt ? `${basePrompt}\n\n` : '';
    text += this.promptDefaults.render('image.one-shot', { total }, this.promptTopic);
    if (descriptions.length > 0) {
      text += `\n\nThe exact scenes to render (one image per scene, in this order):\n`;
      descriptions.forEach((p, i) => { text += `${i + 1}. ${p}\n`; });
    }
    if (extra?.trim()) text += `\n\nAdditional storyboard rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /**
   * The SCENE-oriented one-shot storyboard prompt (from the
   * image.one-shot-scenes template). Used by `planned-scenes` as its render
   * template: the derived scenes are action-bearing, so the en-block request
   * tells the model to capture each scene's action rather than flattening it
   * into a frozen, static photograph.
   */
  oneShotScenesPrompt(basePrompt: string, descriptions: string[], total: number, extra?: string): string {
    let text = basePrompt ? `${basePrompt}\n\n` : '';
    text += this.promptDefaults.render('image.one-shot-scenes', { total }, this.promptTopic);
    if (descriptions.length > 0) {
      text += `\n\nThe exact scenes to render (one image per scene, in this order):\n`;
      descriptions.forEach((p, i) => { text += `${i + 1}. ${p}\n`; });
    }
    if (extra?.trim()) text += `\n\nAdditional storyboard rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /** The pure-picture en-block prompt (from the image.pure template). */
  purePicturesPrompt(sceneInstruction: string, descriptions: string[], total: number, extra?: string): string {
    let text = sceneInstruction ? `${sceneInstruction}\n\n` : '';
    const numbered = descriptions
      .map((d, i) => `${i + 1}. ${d.trim()}`)
      .join('\n') + (descriptions.length ? '\n' : '');
    text += this.promptDefaults.render('image.pure', { total, descriptions: numbered }, this.promptTopic);
    if (extra?.trim()) text += `\n\nAdditional rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /** Per-scene storyboard instruction (from the image.storyboard template). */
  storyboardInstruction(index: number, total: number, extra?: string): string {
    const base = this.promptDefaults.render('image.storyboard', { index: index + 1, total }, this.promptTopic);
    return extra?.trim() ? `${base}\n\nRules for every picture:\n${extra.trim()}` : base;
  }
}

/** Small structural alias so callers don't depend on NodeAttachment directly. */
export type NodeAttachmentLike = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

/** Short local id for synthesized attachments (record files). */
function newIdOrEmpty(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type { ChatNode }; // re-export for convenience
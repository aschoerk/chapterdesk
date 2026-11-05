import type { Express, NextFunction, Request, Response } from 'express';
import type { PersistencePort } from '../domain/chat-api.port.js';
import type {
  ChatNode,
  ChatParameters,
  ChatParametersDraft,
  CreateNodeRequest,
  NodeUsageSummary,
  TextVersionAttribute,
  TextVersionEntityType,
  ThinkingLevel,
} from '../domain/models.js';
import type {
  BranchQuestionRequest,
  CreateModelRequest,
  CreateNameEntryRequest,
  CreatePersonaRequest,
  CreateProjectRequest,
  CreatePromptVersionRequest,
  CreateProviderRequest,
  CreateTopicRequest,
  PatchChatRequest,
  PatchNodeRequest,
  SetPromptSelectionRequest,
  UpdateModelRequest,
  UpdateNameEntryRequest,
  UpdatePersonaRequest,
  UpdateProjectRequest,
  UpdateProviderRequest,
  UpdatePromptVersionRequest,
  UpdateTopicRequest,
} from '../domain/requests.js';
import { badRequest, notFound } from './http-error.js';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function wrap(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value === 'string' && value.length > 0) return value;
  throw badRequest(`missing route param ${name}`);
}

// ---------------------------------------------------------------------------
// Chat parameters input normalisation (mirrors chat-server-js chatParameters.js)
// ---------------------------------------------------------------------------

const THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function toNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolOrNull(value: unknown): boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  return Boolean(value);
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | null {
  if (value === undefined || value === null || value === '') return null;
  const level = String(value).trim().toLowerCase();
  if ((THINKING_LEVELS as readonly string[]).includes(level)) return level as ThinkingLevel;
  const aliases: Record<string, string> = {
    off: 'none',
    disabled: 'none',
    min: 'minimal',
    med: 'medium',
    max: 'high',
    default: 'medium',
  };
  const alias = aliases[level];
  return alias ? (alias as ThinkingLevel) : null;
}

function own(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

function nestedParams(body: unknown): Record<string, unknown> {
  const record = (body ?? {}) as Record<string, unknown>;
  if (
    record.chatParameters &&
    typeof record.chatParameters === 'object' &&
    !Array.isArray(record.chatParameters)
  ) {
    return record.chatParameters as Record<string, unknown>;
  }
  return record;
}

/**
 * Turn a request body into a full ChatParametersDraft. Accepts both the
 * OpenAI-style aliases (top_k, top_p, reasoning_effort, …) and camelCase.
 * When `existing` is given, fields not present in the body are carried over
 * from it (partial PATCH semantics).
 */
function buildChatParametersDraft(
  body: unknown,
  existing?: ChatParameters | null,
): ChatParametersDraft {
  const src = nestedParams(body);
  const temperature = own(src, ['temperature', 'Temperature'])
    ? toNumberOrNull(src.temperature ?? src.Temperature)
    : existing?.temperature ?? null;
  const topK = own(src, ['topK', 'top_k'])
    ? toNumberOrNull(src.topK ?? src.top_k)
    : existing?.topK ?? null;
  const hasTopM = own(src, ['topM', 'top_m', 'topP', 'top_p']);
  const topM = hasTopM
    ? toNumberOrNull(src.topM ?? src.top_m ?? src.topP ?? src.top_p)
    : existing?.topM ?? null;
  const stream = own(src, ['stream']) ? toBoolOrNull(src.stream) : existing?.stream ?? null;
  const thinking = own(src, ['thinking', 'reasoning', 'includeThoughts'])
    ? toBoolOrNull(src.thinking ?? src.reasoning ?? src.includeThoughts)
    : existing?.thinking ?? null;
  const hasLevel = own(src, ['thinkingLevel', 'thinking_level', 'reasoningEffort', 'reasoning_effort']);
  const thinkingLevel = hasLevel
    ? normalizeThinkingLevel(
        src.thinkingLevel ?? src.thinking_level ?? src.reasoningEffort ?? src.reasoning_effort,
      )
    : existing?.thinkingLevel ?? null;
  return {
    name: src.name !== undefined ? String(src.name) : existing?.name,
    temperature,
    topK,
    topM,
    stream,
    thinking,
    thinkingLevel,
  };
}

// ---------------------------------------------------------------------------
// Chat parameter ownership (projects / topics / chats / chat_nodes / models)
// ---------------------------------------------------------------------------

type OwnerType = 'model' | 'topic' | 'project' | 'chat' | 'chat_node';
const OWNER_TYPES: OwnerType[] = ['model', 'topic', 'project', 'chat', 'chat_node'];

async function listOwners(
  api: PersistencePort,
  parameterId: string,
): Promise<{ type: OwnerType; id: string }[]> {
  const owners: { type: OwnerType; id: string }[] = [];
  for (const project of await api.getProjects()) {
    if (project.chatParametersId === parameterId) owners.push({ type: 'project', id: project.id });
  }
  for (const topic of await api.getTopics()) {
    if (topic.chatParametersId === parameterId) owners.push({ type: 'topic', id: topic.id });
  }
  for (const chat of await api.getChats()) {
    if (chat.chatParametersId === parameterId) owners.push({ type: 'chat', id: chat.id });
  }
  for (const model of await api.getModels()) {
    if (model.chatParametersId === parameterId) owners.push({ type: 'model', id: model.id });
  }
  for (const chat of await api.getChats()) {
    for (const node of await api.getNodes(chat.id)) {
      if (node.chatParametersId === parameterId) owners.push({ type: 'chat_node', id: node.id });
    }
  }
  return owners;
}

async function findOwnerParameter(
  api: PersistencePort,
  ownerType: OwnerType,
  ownerId: string,
): Promise<ChatParameters | null> {
  let chatParametersId: string | null | undefined;
  if (ownerType === 'project') {
    chatParametersId = (await api.getProjects()).find((p) => p.id === ownerId)?.chatParametersId;
  } else if (ownerType === 'topic') {
    chatParametersId = (await api.getTopics()).find((t) => t.id === ownerId)?.chatParametersId;
  } else if (ownerType === 'chat') {
    chatParametersId = (await api.getChats()).find((c) => c.id === ownerId)?.chatParametersId;
  } else if (ownerType === 'model') {
    chatParametersId = (await api.getModels()).find((m) => m.id === ownerId)?.chatParametersId;
  } else if (ownerType === 'chat_node') {
    for (const chat of await api.getChats()) {
      for (const node of await api.getNodes(chat.id)) {
        if (node.id === ownerId) chatParametersId = node.chatParametersId;
      }
    }
  }
  if (!chatParametersId) return null;
  return (await api.getChatParameters()).find((p) => p.id === chatParametersId) ?? null;
}

export function registerChatApiRoutes(app: Express, api: PersistencePort): void {
  app.get(
    '/api/projects',
    wrap(async (_req, res) => {
      res.json(await api.getProjects());
    }),
  );
  app.get(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const id = param(req, 'id');
      const project = (await api.getProjects()).find((entry) => entry.id === id);
      if (!project) throw notFound('project', id);
      res.json(project);
    }),
  );
  app.post(
    '/api/projects',
    wrap(async (req, res) => {
      res.status(201).json(await api.createProject(req.body as CreateProjectRequest));
    }),
  );
  app.put(
    '/api/projects/:id',
    wrap(async (req, res) => {
      res.json(await api.updateProject(param(req, 'id'), req.body as UpdateProjectRequest));
    }),
  );
  app.delete(
    '/api/projects/:id',
    wrap(async (req, res) => {
      await api.deleteProject(param(req, 'id'), req.query.deleteChats === 'true');
      res.status(204).end();
    }),
  );

  app.get(
    '/api/chats',
    wrap(async (_req, res) => {
      res.json(await api.getChats());
    }),
  );
  app.get(
    '/api/chats/search-ids',
    wrap(async (req, res) => {
      res.json(await api.searchChatIds(String(req.query.q ?? '')));
    }),
  );
  app.get(
    '/api/chats/:id',
    wrap(async (req, res) => {
      const id = param(req, 'id');
      const chat = (await api.getChats()).find((entry) => entry.id === id);
      if (!chat) throw notFound('chat', id);
      res.json(chat);
    }),
  );
  app.post(
    '/api/chats',
    wrap(async (req, res) => {
      const body = req.body as {
        title: string;
        projectId?: string | null;
        chatParametersId?: string | null;
        chatParameters?: unknown;
      };
      let chatParametersId = body.chatParametersId ?? null;
      // Nested chatParameters object: create a parameter set and attach it.
      if (body.chatParameters && typeof body.chatParameters === 'object') {
        const params = await api.createChatParameters(
          buildChatParametersDraft({ chatParameters: body.chatParameters }),
        );
        chatParametersId = params.id;
      }
      const chat = await api.createChat(body.title, body.projectId ?? null);
      if (chatParametersId) {
        res.status(201).json(await api.patchChat(chat.id, { chatParametersId }));
        return;
      }
      res.status(201).json(chat);
    }),
  );
  app.post(
    '/api/chats/:id/clone',
    wrap(async (req, res) => {
      res.status(201).json(await api.cloneChat(param(req, 'id')));
    }),
  );
  app.patch(
    '/api/chats/:id',
    wrap(async (req, res) => {
      res.json(await api.patchChat(param(req, 'id'), req.body as PatchChatRequest));
    }),
  );
  app.delete(
    '/api/chats/:id',
    wrap(async (req, res) => {
      await api.deleteChat(param(req, 'id'));
      res.status(204).end();
    }),
  );

  app.get(
    '/api/chats/:id/nodes',
    wrap(async (req, res) => {
      res.json(await api.getNodes(param(req, 'id')));
    }),
  );
  app.get(
    '/api/chats/:id/nodes/deleted',
    wrap(async (req, res) => {
      res.json(await api.getDeletedNodes(param(req, 'id')));
    }),
  );
  app.post(
    '/api/chats/:id/nodes',
    wrap(async (req, res) => {
      res.status(201).json(await api.createNode(param(req, 'id'), req.body as CreateNodeRequest));
    }),
  );
  app.post(
    '/api/chats/:id/nodes/reorder',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { parentId?: string | null; orderedNodeIds: string[] };
      res.json(
        await api.reorderSiblings(
          param(req, 'id'),
          body.parentId ?? null,
          Array.isArray(body.orderedNodeIds) ? body.orderedNodeIds : [],
        ),
      );
    }),
  );
  app.post(
    '/api/chats/:id/nodes/:nodeId/edit-assistant',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as {
        content: string;
        attachments?: CreateNodeRequest['attachments'];
        thinking?: string;
        usage?: NodeUsageSummary;
      };
      if (body.content === undefined || body.content === null) throw badRequest('content is required');
      res.status(201).json(
        await api.editAssistant(
          param(req, 'id'),
          param(req, 'nodeId'),
          body.content,
          body.attachments,
          body.thinking,
          body.usage,
        ),
      );
    }),
  );
  app.post(
    '/api/chats/:id/usage',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as {
        nodes?: { nodeId?: string; usage?: NodeUsageSummary }[];
      };
      const nodes = Array.isArray(body.nodes)
        ? body.nodes
            .filter((n) => typeof n?.nodeId === 'string')
            .map((n) => ({ nodeId: n.nodeId as string, usage: n.usage }))
        : [];
      res.json(await api.saveChatUsage(param(req, 'id'), nodes));
    }),
  );
  app.post(
    '/api/chats/:id/nodes/:nodeId/edit-user',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { content: string; attachments?: CreateNodeRequest['attachments'] };
      if (body.content === undefined || body.content === null) throw badRequest('content is required');
      res.status(201).json(
        await api.editUser(param(req, 'id'), param(req, 'nodeId'), body.content, body.attachments),
      );
    }),
  );
  app.post(
    '/api/chats/:id/nodes/:nodeId/branch-user',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as BranchQuestionRequest;
      if (body.content === undefined || body.content === null) throw badRequest('content is required');
      const nodes = await api.getNodes(param(req, 'id'));
      const target = nodes.find((entry) => entry.id === param(req, 'nodeId'));
      if (!target) throw notFound('node', param(req, 'nodeId'));
      if (target.role !== 'user') throw badRequest('Only questions can be branched this way');
      res.status(201).json(
        await api.branchUser(param(req, 'id'), param(req, 'nodeId'), body),
      );
    }),
  );
  app.patch(
    '/api/chats/:id/nodes/:nodeId',
    wrap(async (req, res) => {
      const chatId = param(req, 'id');
      const nodeId = param(req, 'nodeId');
      const data = (req.body ?? {}) as PatchNodeRequest;
      if (data.parentId !== undefined) {
        if (data.parentId === nodeId) throw badRequest('Cannot reparent a node under itself');
        if (data.parentId) {
          const nodes = await api.getNodes(chatId);
          const parent = nodes.find((entry) => entry.id === data.parentId);
          if (!parent) throw badRequest('Parent node not found');
          const seen = new Set<string>();
          let cursor: ChatNode | undefined = parent;
          while (cursor && cursor.parentId) {
            if (cursor.parentId === nodeId || seen.has(cursor.parentId)) {
              throw badRequest('Cannot reparent a node under its descendant');
            }
            seen.add(cursor.parentId);
            cursor = nodes.find((entry) => entry.id === cursor!.parentId);
          }
        }
      }
      res.json(await api.patchNode(chatId, nodeId, data));
    }),
  );
  app.delete(
    '/api/chats/:id/nodes/:nodeId',
    wrap(async (req, res) => {
      const keepChildren = ['1', 'true', 'yes'].includes(
        String(req.query.keepChildren ?? '').toLowerCase(),
      );
      await api.deleteNode(param(req, 'id'), param(req, 'nodeId'), { keepChildren });
      res.status(204).end();
    }),
  );
  app.post(
    '/api/chats/:id/nodes/:nodeId/restore',
    wrap(async (req, res) => {
      await api.restoreNode(param(req, 'id'), param(req, 'nodeId'));
      res.status(204).end();
    }),
  );
  app.delete(
    '/api/chats/:id/nodes/:nodeId/purge',
    wrap(async (req, res) => {
      await api.purgeNode(param(req, 'id'), param(req, 'nodeId'));
      res.status(204).end();
    }),
  );

  app.get(
    '/api/personas',
    wrap(async (_req, res) => {
      res.json(await api.getPersonas());
    }),
  );
  app.get(
    '/api/personas/:id',
    wrap(async (req, res) => {
      const id = param(req, 'id');
      const persona = (await api.getPersonas()).find((entry) => entry.id === id);
      if (!persona) throw notFound('persona', id);
      res.json(persona);
    }),
  );
  app.post(
    '/api/personas',
    wrap(async (req, res) => {
      res.status(201).json(await api.createPersona(req.body as CreatePersonaRequest));
    }),
  );
  app.put(
    '/api/personas/:id',
    wrap(async (req, res) => {
      res.json(await api.updatePersona(param(req, 'id'), req.body as UpdatePersonaRequest));
    }),
  );
  app.delete(
    '/api/personas/:id',
    wrap(async (req, res) => {
      await api.deletePersona(param(req, 'id'));
      res.status(204).end();
    }),
  );

  app.get(
    '/api/topics',
    wrap(async (_req, res) => {
      res.json(await api.getTopics());
    }),
  );
  app.get(
    '/api/topics/:id',
    wrap(async (req, res) => {
      const id = param(req, 'id');
      const topic = (await api.getTopics()).find((entry) => entry.id === id);
      if (!topic) throw notFound('topic', id);
      res.json(topic);
    }),
  );
  app.post(
    '/api/topics',
    wrap(async (req, res) => {
      res.status(201).json(await api.createTopic(req.body as CreateTopicRequest));
    }),
  );
  app.put(
    '/api/topics/:id',
    wrap(async (req, res) => {
      res.json(await api.updateTopic(param(req, 'id'), req.body as UpdateTopicRequest));
    }),
  );
  app.delete(
    '/api/topics/:id',
    wrap(async (req, res) => {
      await api.deleteTopic(param(req, 'id'));
      res.status(204).end();
    }),
  );
  app.post(
    '/api/topics/:id/projects',
    wrap(async (req, res) => {
      const body = req.body as { projectId: string };
      res.json(await api.addProjectToTopic(param(req, 'id'), body.projectId));
    }),
  );
  app.delete(
    '/api/topics/:id/projects/:projectId',
    wrap(async (req, res) => {
      res.json(await api.removeProjectFromTopic(param(req, 'id'), param(req, 'projectId')));
    }),
  );

  app.get(
    '/api/providers',
    wrap(async (_req, res) => {
      res.json(await api.getProviders());
    }),
  );
  app.post(
    '/api/providers',
    wrap(async (req, res) => {
      res.status(201).json(await api.createProvider(req.body as CreateProviderRequest));
    }),
  );
  app.put(
    '/api/providers/:id',
    wrap(async (req, res) => {
      res.json(await api.updateProvider(param(req, 'id'), req.body as UpdateProviderRequest));
    }),
  );
  app.delete(
    '/api/providers/:id',
    wrap(async (req, res) => {
      await api.deleteProvider(param(req, 'id'));
      res.status(204).end();
    }),
  );

  app.get(
    '/api/models',
    wrap(async (_req, res) => {
      res.json(await api.getModels());
    }),
  );
  app.post(
    '/api/models',
    wrap(async (req, res) => {
      res.status(201).json(await api.createModel(req.body as CreateModelRequest));
    }),
  );
  app.put(
    '/api/models/:id',
    wrap(async (req, res) => {
      res.json(await api.updateModel(param(req, 'id'), req.body as UpdateModelRequest));
    }),
  );
  app.delete(
    '/api/models/:id',
    wrap(async (req, res) => {
      await api.deleteModel(param(req, 'id'));
      res.status(204).end();
    }),
  );
  app.patch(
    '/api/models/:id/toggle',
    wrap(async (req, res) => {
      res.json(await api.toggleModelEnabled(param(req, 'id')));
    }),
  );

  app.get(
    '/api/chat-parameters',
    wrap(async (req, res) => {
      const { ownerType, ownerId } = req.query;
      if (ownerType || ownerId) {
        if (!ownerType || !ownerId) {
          throw badRequest('ownerType and ownerId must be provided together');
        }
        if (!(OWNER_TYPES as string[]).includes(String(ownerType))) {
          throw badRequest('ownerType must be one of model, topic, project, chat, chat_node');
        }
        const row = await findOwnerParameter(api, ownerType as OwnerType, String(ownerId));
        res.json(row ? [row] : []);
        return;
      }
      res.json(await api.getChatParameters());
    }),
  );
  app.get(
    '/api/chat-parameters/:id',
    wrap(async (req, res) => {
      res.json(await api.getChatParameter(param(req, 'id')));
    }),
  );
  app.get(
    '/api/chat-parameters/:id/owners',
    wrap(async (req, res) => {
      const id = param(req, 'id');
      await api.getChatParameter(id); // 404 when the set does not exist
      res.json(await listOwners(api, id));
    }),
  );
  app.post(
    '/api/chat-parameters',
    wrap(async (req, res) => {
      res.status(201).json(await api.createChatParameters(buildChatParametersDraft(req.body ?? {})));
    }),
  );
  app.patch(
    '/api/chat-parameters/:id',
    wrap(async (req, res) => {
      const id = param(req, 'id');
      const existing = await api.getChatParameter(id);
      res.json(await api.updateChatParameters(id, buildChatParametersDraft(req.body ?? {}, existing)));
    }),
  );
  app.delete(
    '/api/chat-parameters/:id',
    wrap(async (req, res) => {
      await api.deleteChatParameters(param(req, 'id'));
      res.status(204).end();
    }),
  );

  // Editable prompt templates (versioned, stored in the database).
  //   GET/POST    /api/prompt-versions
  //   PUT/DELETE  /api/prompt-versions/:id
  //   GET         /api/prompt-selections
  //   PUT/DELETE  /api/prompt-selections  (upsert / clear by promptId+scope+topicId)
  const PROMPT_SCOPES = new Set(['user', 'topic']);

  app.get(
    '/api/prompt-versions',
    wrap(async (_req, res) => {
      res.json(await api.getPromptVersions());
    }),
  );
  app.post(
    '/api/prompt-versions',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.promptId !== 'string' || !body.promptId) {
        throw badRequest('promptId (string) is required');
      }
      if (typeof body.name !== 'string') body.name = '';
      if (typeof body.text !== 'string') throw badRequest('text (string) is required');
      if (body.scope !== 'user' && body.scope !== 'topic') body.scope = 'user';
      if (body.scope === 'topic' && typeof body.topicId !== 'string') {
        throw badRequest('topicId (string) is required for scope=topic versions');
      }
      res.status(201).json(await api.createPromptVersion(body as unknown as CreatePromptVersionRequest));
    }),
  );
  app.put(
    '/api/prompt-versions/:id',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.name !== undefined && typeof body.name !== 'string') {
        throw badRequest('name must be a string');
      }
      if (body.text !== undefined && typeof body.text !== 'string') {
        throw badRequest('text must be a string');
      }
      res.json(await api.updatePromptVersion(param(req, 'id'), body as UpdatePromptVersionRequest));
    }),
  );
  app.delete(
    '/api/prompt-versions/:id',
    wrap(async (req, res) => {
      await api.deletePromptVersion(param(req, 'id'));
      res.status(204).end();
    }),
  );

  app.get(
    '/api/prompt-selections',
    wrap(async (_req, res) => {
      res.json(await api.getPromptSelections());
    }),
  );
  app.put(
    '/api/prompt-selections',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.promptId !== 'string' || !body.promptId) {
        throw badRequest('promptId (string) is required');
      }
      if (!PROMPT_SCOPES.has(String(body.scope ?? 'user'))) {
        throw badRequest('scope must be "user" or "topic"');
      }
      if (typeof body.versionId !== 'string' || !body.versionId) {
        throw badRequest('versionId (string) is required');
      }
      const scope = String(body.scope) as CreatePromptVersionRequest['scope'];
      if (scope === 'topic' && typeof body.topicId !== 'string') {
        throw badRequest('topicId (string) is required for scope=topic selections');
      }
      res.json(await api.setPromptSelection(body as unknown as SetPromptSelectionRequest));
    }),
  );
  app.delete(
    '/api/prompt-selections',
    wrap(async (req, res) => {
      const promptId = String(req.query.promptId ?? '');
      const scope = String(req.query.scope ?? 'user');
      if (!promptId) throw badRequest('promptId query param is required');
      if (!PROMPT_SCOPES.has(scope)) throw badRequest('scope must be "user" or "topic"');
      const topicId = req.query.topicId
        ? String(req.query.topicId)
        : null;
      await api.deletePromptSelection(promptId, scope as 'user' | 'topic', topicId);
      res.status(204).end();
    }),
  );

  // Name dictionary (used by the "Replace names" dialog).
  //   GET/POST        /api/names
  //   PUT/DELETE      /api/names/:id
  //   POST            /api/names/import   (line-oriented bulk load)
  // Optional string fields of a name entry. The only classification is the
  // `category` enum (male|female|surname|place|brand); legacy `gender` is
  // accepted and maps to the given-name category.
  type NameOptionalField = Exclude<keyof CreateNameEntryRequest, 'name' | 'category' | 'gender'>;
  const NAME_STRINGS: NameOptionalField[] = ['language'];

  /** Normalize an incoming gender value: 'male'|'female'|null (else null). */
  function normalizeGender(value: unknown): 'male' | 'female' | null {
    return value === 'male' || value === 'female' ? value : null;
  }

  /** Normalize an incoming category value (or null when unknown). */
  function normalizeCategory(value: unknown): CreateNameEntryRequest['category'] {
    return value === 'male' ||
      value === 'female' ||
      value === 'surname' ||
      value === 'place' ||
      value === 'brand'
      ? value
      : null;
  }

  app.get(
    '/api/names',
    wrap(async (_req, res) => {
      res.json(await api.getNames());
    }),
  );
  app.post(
    '/api/names',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw badRequest('name (string) is required');
      }
      const data: CreateNameEntryRequest = { name: body.name.trim() };
      for (const field of NAME_STRINGS) {
        const value = body[field];
        data[field] = typeof value === 'string' && value.trim() ? value.trim() : null;
      }
      if (body.category !== undefined) data.category = normalizeCategory(body.category);
      if (data.category && data.category !== 'surname' && body.gender !== undefined) {
        data.gender = normalizeGender(body.gender);
      }
      res.status(201).json(await api.createNameEntry(data));
    }),
  );
  app.put(
    '/api/names/:id',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
        throw badRequest('name must be a non-empty string');
      }
      const data: UpdateNameEntryRequest = {};
      if (body.name !== undefined) data.name = String(body.name).trim();
      if (body.category !== undefined) data.category = normalizeCategory(body.category);
      if (body.gender !== undefined) data.gender = normalizeGender(body.gender);
      res.json(await api.updateNameEntry(param(req, 'id'), data));
    }),
  );
  app.delete(
    '/api/names/:id',
    wrap(async (req, res) => {
      await api.deleteNameEntry(param(req, 'id'));
      res.status(204).end();
    }),
  );
  app.post(
    '/api/names/import',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.text !== 'string') throw badRequest('text (string) is required');
      const lines = body.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const existing = await api.getNames();
      const known = new Set(existing.map((e) => e.name.toLowerCase()));
      const entries: CreateNameEntryRequest[] = [];
      for (const name of lines) {
        const key = name.toLowerCase();
        if (known.has(key)) continue;
        known.add(key);
        entries.push({ name });
      }
      res.json(await api.importNameEntries(entries));
    }),
  );
  app.post(
    '/api/names/bulk',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { entries?: unknown };
      if (!Array.isArray(body.entries)) throw badRequest('entries (array) is required');
      const entries: CreateNameEntryRequest[] = body.entries
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => {
          const name = typeof e.name === 'string' ? e.name.trim() : '';
          const out: CreateNameEntryRequest = { name };
          if (typeof e.language === 'string' && e.language.trim()) out.language = e.language.trim();
          if (e.category !== undefined) out.category = normalizeCategory(e.category);
          if (e.gender !== undefined) out.gender = normalizeGender(e.gender);
          return out;
        })
        .filter((e) => e.name.length > 0);
      res.json(await api.importNameEntries(entries));
    }),
  );

  // Versioned general texts (compare / restore).
  //   GET    /api/text-versions?entityType=&entityId=[&attribute=]
  //   POST   /api/text-versions/:id/restore
  //   DELETE /api/text-versions/:id
  const TEXT_ENTITY_TYPES = new Set<string>(['topic', 'project', 'persona']);
  const TEXT_ATTRIBUTES = new Set<string>([
    'defaultSystemPrompt',
    'systemPrompt',
    'greeting',
    'description',
  ]);

  app.get(
    '/api/text-versions',
    wrap(async (req, res) => {
      const entityType = String(req.query.entityType ?? '');
      const entityId = String(req.query.entityId ?? '');
      if (!TEXT_ENTITY_TYPES.has(entityType)) {
        throw badRequest('entityType query param must be one of topic, project, persona');
      }
      if (!entityId) throw badRequest('entityId query param is required');
      let attribute: TextVersionAttribute | undefined;
      if (req.query.attribute !== undefined) {
        const attr = String(req.query.attribute);
        if (!TEXT_ATTRIBUTES.has(attr)) {
          throw badRequest(
            'attribute query param must be one of defaultSystemPrompt, systemPrompt, greeting, description',
          );
        }
        attribute = attr as TextVersionAttribute;
      }
      res.json(
        await api.getTextVersions(entityType as TextVersionEntityType, entityId, attribute),
      );
    }),
  );
  app.post(
    '/api/text-versions/:id/restore',
    wrap(async (req, res) => {
      res.json(await api.restoreTextVersion(param(req, 'id')));
    }),
  );
  app.delete(
    '/api/text-versions/:id',
    wrap(async (req, res) => {
      await api.deleteTextVersion(param(req, 'id'));
      res.status(204).end();
    }),
  );
}

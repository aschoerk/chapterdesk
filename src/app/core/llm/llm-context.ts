import {
  Persona,
  Project,
  Topic
} from '../../models/chat';

export interface SeedNodeDraft {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface SeedEnvironmentInput {
  project: Pick<Project, 'id' | 'mainTopicId' | 'systemPrompt' | 'greeting' | 'personaIds'>;
  topics: Array<Pick<Topic, 'id' | 'defaultSystemPrompt' | 'description' | 'projectIds'>>;
  /** The sidebar-selected "current topic": a topic id, or 'all' / 'unassigned' when none. */
  currentTopicId?: string | null;
  getPersona: (id: string) => Persona | undefined;
  currentUserPersona: Persona | null | undefined;
}

/** A topic shape accepted by the current-topic resolution (system prompt + membership). */
export type EnvironmentTopic = SeedEnvironmentInput['topics'][number];

/**
 * Resolve the ONE topic whose system prompt is the "current topic" of an
 * environment: the sidebar-selected topic (`currentTopicId`) when it is
 * connected to the project, else the project's main topic, else the first
 * topic that lists the project. Only the current topic is ever used — other
 * connected member topics are never pooled.
 */
export function resolveCurrentTopic(
  projectId: string | null | undefined,
  mainTopicId: string | null | undefined,
  currentTopicId: string | null | undefined,
  topics: EnvironmentTopic[]
): EnvironmentTopic | undefined {
  if (!projectId) return undefined;
  if (currentTopicId) {
    const selected = topics.find(
      t => t.id === currentTopicId && t.projectIds?.some(id => id === projectId)
    );
    if (selected) return selected;
  }
  if (mainTopicId) {
    const main = topics.find(t => t.id === mainTopicId);
    if (main) return main;
  }
  return topics.find(t => t.projectIds?.some(id => id === projectId));
}

/**
 * Nodes created when a story is opened under an environment (project).
 * Linear chain: optional system → optional user → optional greeting assistant.
 *
 * Only the environment's CURRENT topic contributes a system prompt: the
 * sidebar-selected topic when it is connected to the environment (else the
 * main topic, else the first connected topic). The other member topics are
 * NOT pooled into the system node.
 * The environment contributes `systemPrompt` as the first user beat and
 * `greeting` as the first assistant beat.
 */
export function buildSeedNodeDrafts(input: SeedEnvironmentInput): SeedNodeDraft[] {
  const { project, topics, currentTopicId, getPersona, currentUserPersona } = input;
  const drafts: SeedNodeDraft[] = [];

  const currentTopic = resolveCurrentTopic(project.id, project.mainTopicId, currentTopicId, topics);
  if (currentTopic?.defaultSystemPrompt?.trim()) {
    drafts.push({ role: 'system', content: currentTopic.defaultSystemPrompt.trim() });
  }

  const userParts: string[] = [];
  if (project.systemPrompt?.trim()) {
    userParts.push(project.systemPrompt.trim());
  }

  for (const personaId of project.personaIds ?? []) {
    const persona = getPersona(personaId);
    if (!persona) continue;
    userParts.push(`\n\nnpc is ${persona.name}`);
    if (persona.description?.trim()) {
      userParts.push(persona.description.trim());
    }
  }

  const userPersona = currentUserPersona ?? null;
  if (userPersona) {
    userParts.push(`\n\n{{user}} is ${userPersona.name}`);
    if (userPersona.description?.trim()) {
      userParts.push(userPersona.description.trim());
    }
  }

  const userContent = userParts.join('\n\n').trim();
  if (userContent) {
    drafts.push({ role: 'user', content: userContent });
  }

  if (project.greeting?.trim()) {
    const greeting = userPersona?.name
      ? project.greeting.replace('{{user}}', userPersona.name)
      : `${project.greeting}`.trim();
    drafts.push({ role: 'assistant', content: greeting });
  }

  return drafts;
}




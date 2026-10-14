import type {
  CreatePromptVersionRequest,
  PromptScope,
  PromptSelection,
  PromptVersion,
  SetPromptSelectionRequest,
  UpdatePromptVersionRequest,
} from '../src/app/models/prompt-version';

/**
 * In-memory stand-in for `PromptApiService` so specs can exercise the
 * DB-backed `PromptDefaultsService` without a server. Mirrors the backend
 * semantics: named versions per (prompt, scope, topic), selections upserted by
 * (prompt, scope, topic), deleting a version removes its selections.
 */
export class FakePromptApiService {
  private versions: PromptVersion[] = [];
  private selections: PromptSelection[] = [];
  private seq = 1;

  getPromptVersions(): Promise<PromptVersion[]> {
    return Promise.resolve(structuredClone(this.versions));
  }

  createPromptVersion(data: CreatePromptVersionRequest): Promise<PromptVersion> {
    const ts = new Date().toISOString();
    const version: PromptVersion = {
      id: `pv-${this.seq++}`,
      promptId: data.promptId,
      name: data.name ?? '',
      text: data.text ?? '',
      scope: data.scope === 'topic' ? 'topic' : 'user',
      topicId: data.scope === 'topic' ? (data.topicId ?? null) : null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.versions.push(version);
    return Promise.resolve(structuredClone(version));
  }

  updatePromptVersion(id: string, data: UpdatePromptVersionRequest): Promise<PromptVersion> {
    const version = this.versions.find(v => v.id === id);
    if (!version) return Promise.reject(new Error(`version ${id} not found`));
    if (data.name !== undefined) version.name = data.name;
    if (data.text !== undefined) version.text = data.text;
    version.updatedAt = new Date().toISOString();
    return Promise.resolve(structuredClone(version));
  }

  deletePromptVersion(id: string): Promise<void> {
    this.versions = this.versions.filter(v => v.id !== id);
    this.selections = this.selections.filter(s => s.versionId !== id);
    return Promise.resolve();
  }

  getPromptSelections(): Promise<PromptSelection[]> {
    return Promise.resolve(structuredClone(this.selections));
  }

  setPromptSelection(data: SetPromptSelectionRequest): Promise<PromptSelection> {
    const version = this.versions.find(v => v.id === data.versionId);
    if (!version) return Promise.reject(new Error(`version ${data.versionId} not found`));
    const scope = data.scope === 'topic' ? 'topic' : 'user';
    const topicId = scope === 'topic' ? (data.topicId ?? null) : null;
    const selection: PromptSelection = {
      promptId: data.promptId,
      scope,
      topicId,
      versionId: data.versionId,
      updatedAt: new Date().toISOString(),
    };
    this.selections = this.selections.filter(
      s => !(s.promptId === data.promptId && s.scope === scope && s.topicId === topicId),
    );
    this.selections.push(selection);
    return Promise.resolve(structuredClone(selection));
  }

  deletePromptSelection(
    promptId: string,
    scope: PromptScope,
    topicId?: string | null,
  ): Promise<void> {
    const tid = topicId ?? null;
    this.selections = this.selections.filter(
      s => !(s.promptId === promptId && s.scope === scope && s.topicId === tid),
    );
    return Promise.resolve();
  }

  /** Test helper: seed a stored version directly. */
  seed(version: Partial<PromptVersion>): PromptVersion {
    const ts = new Date().toISOString();
    const full: PromptVersion = {
      id: `pv-${this.seq++}`,
      promptId: 'structure.title',
      name: 'Seed',
      text: 'Seeded text',
      scope: 'user',
      topicId: null,
      createdAt: ts,
      updatedAt: ts,
      ...version,
    };
    this.versions.push(full);
    return structuredClone(full);
  }
}

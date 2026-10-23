import { Injectable, computed, inject, signal } from '@angular/core';
import {
  PROMPT_DEFAULTS,
  promptDefaultById,
  type PromptDefaultCategory,
  type PromptDefaultDef
} from '../models/prompt-default';
import {
  PromptApiService
} from './prompt-api.service';
import type {
  PromptScope,
  PromptSelection,
  PromptVersion
} from '../models/prompt-version';

/** Values that template variables may hold. Booleans allow `{{#if}}` blocks. */
export type PromptVars = Record<string, string | number | boolean>;

/** Which stored object supplies the effective template for a prompt. */
export type PromptSource =
  | { kind: 'default' }
  | { kind: 'user'; version: PromptVersion }
  | { kind: 'topic'; topicId: string; version: PromptVersion };

// ---------------------------------------------------------------------------
// Tiny template evaluator: `{{name}}` substitution plus `{{#if v}}…{{else}}…` /
// `{{/if}}` conditional blocks (nestable). Unknown `{{name}}` tokens are left
// intact so users can spot typos in the Settings editor.
// ---------------------------------------------------------------------------

const IF_OPEN_RE = /\{\{#if\s+([^{}]+?)\s*\}\}/;
const BLOCK_TAG_RE = /\{\{(#if|else|\/if)(?:\s+[^{}]*?)?\}\}/g;

/** A value is truthy when it's a non-empty string, a non-zero number, or true. */
function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}

/** Replace `{{key}}` placeholders; unknown placeholders are left as-is. */
function substitute(text: string, vars: PromptVars): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined || value === null) continue;
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

/**
 * Locate the matching `{{/if}}` (and optional top-level `{{else}}`) for the
 * `{{#if …}}` block opened at `from`. Returns the `{{else}}` start (or null)
 * and the index right after the closing `{{/if}}`.
 */
function findBlockBounds(text: string, from: number): { elseAt: number | null; end: number } {
  let depth = 0;
  let elseAt: number | null = null;
  BLOCK_TAG_RE.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_TAG_RE.exec(text)) !== null) {
    const tag = m[1];
    if (tag === '#if') {
      depth += 1;
    } else if (tag === 'else') {
      if (depth === 0 && elseAt === null) elseAt = m.index;
    } else {
      // '/if'
      if (depth === 0) return { elseAt, end: m.index + m[0].length };
      depth -= 1;
    }
  }
  throw new Error(`Unbalanced {{#if}} block in prompt template`);
}

/** Recursively resolve conditionals, then substitute plain placeholders. */
function evaluateTemplate(text: string, vars: PromptVars): string {
  const open = IF_OPEN_RE.exec(text);
  if (!open) return substitute(text, vars);

  const openEnd = open.index + open[0].length;
  const { elseAt, end } = findBlockBounds(text, openEnd);
  const closeStart = end - '{{/if}}'.length;
  const ifBody = text.slice(openEnd, elseAt ?? closeStart);
  const elseBody = elseAt === null
    ? null
    : text.slice(elseAt + '{{else}}'.length, closeStart);

  const chosen = truthy(vars[open[1].trim()]) ? ifBody : (elseBody ?? '');
  return substitute(text.slice(0, open.index), vars)
    + evaluateTemplate(chosen, vars)
    + evaluateTemplate(text.slice(end), vars);
}

/**
 * User-editable prompt templates, stored in the DATABASE as named versions.
 *
 * Every template has a built-in default (see `models/prompt-default.ts`; it is
 * the fallback when nothing is selected). Beyond that, users store NAMED
 * VERSIONS of the text in the backend database (global `user` versions and
 * per-`topic` versions), and pick the ACTIVE version per template:
 *
 *   1. a `user` selection wins everywhere;
 *   2. else a `topic` selection wins when a topic is in play (the chat's
 *      environment main topic) — `effective(id, topicId)` / `render(..., topicId)`;
 *   3. else the built-in default.
 *
 * Data is loaded once from the API at startup (`load()`), and mutations keep
 * the in-memory cache in sync. Everything stays synchronous for the LLM call
 * sites (`effective`/`render` read signals); before the first load they fall
 * back to the built-in defaults, which is always safe.
 *
 * Prompts are English-only (not i18n).
 */
@Injectable({ providedIn: 'root' })
export class PromptDefaultsService {
  private readonly api = inject(PromptApiService);

  /** All stored prompt versions (user + every topic), reactive for the UI. */
  private readonly _versions = signal<PromptVersion[]>([]);
  readonly versions = this._versions.asReadonly();

  /** All active prompt selections (user + every topic), reactive for the UI. */
  private readonly _selections = signal<PromptSelection[]>([]);
  readonly selections = this._selections.asReadonly();

  /** Whether versions+selections have been loaded from the API at least once. */
  private readonly _loaded = signal(false);
  readonly loaded = this._loaded.asReadonly();

  private loadPromise: Promise<void> | null = null;

  /** Template ids that have ANY active selection (user or topic). */
  readonly customized = computed<string[]>(() =>
    PROMPT_DEFAULTS
      .map(d => d.id)
      .filter(id => this._selections().some(s => s.promptId === id))
  );

  constructor() {
    // The legacy per-browser localStorage overrides (`chat.promptDefaults`)
    // are intentionally dropped with this change (the prompts live in the DB
    // now). Also, remove any stale key so a downgrade never re-applies it.
    try {
      localStorage.removeItem('chat.promptDefaults');
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- load state

  /** Fetch versions + selections from the API (idempotent; no-op when loaded). */
  load(): Promise<void> {
    if (this._loaded()) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromApi().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  /** Trigger a load if it hasn't happened yet (fire-and-forget). */
  ensureLoaded(): void {
    if (!this._loaded() && !this.loadPromise) void this.load();
  }

  private async loadFromApi(): Promise<void> {
    try {
      const [versions, selections] = await Promise.all([
        this.api.getPromptVersions(),
        this.api.getPromptSelections(),
      ]);
      this._versions.set(versions ?? []);
      this._selections.set(selections ?? []);
      this._loaded.set(true);
    } catch (err) {
      // The database may be unreachable (e.g. pure-browser dev without the
      // bundled server). Built-in defaults always apply — never break prompts.
      console.warn('[prompt-defaults] could not load prompt versions', err);
      this._versions.set([]);
      this._selections.set([]);
      this._loaded.set(true);
    }
  }

  // ------------------------------------------------------------ definitions

  /** All prompt default definitions. */
  all(): PromptDefaultDef[] {
    return PROMPT_DEFAULTS;
  }

  /** Definitions grouped by category, in display order. */
  byCategory(category: PromptDefaultCategory): PromptDefaultDef[] {
    return PROMPT_DEFAULTS.filter(d => d.category === category);
  }

  /** A definition by id (or undefined). */
  def(id: string): PromptDefaultDef | undefined {
    return promptDefaultById(id);
  }

  // ------------------------------------------------------------ resolution

  private versionById(id: string | undefined): PromptVersion | undefined {
    if (!id) return undefined;
    return this._versions().find(v => v.id === id);
  }

  private selection(promptId: string, scope: PromptScope, topicId?: string | null): PromptSelection | undefined {
    const tid = topicId ?? null;
    return this._selections().find(
      s => s.promptId === promptId && s.scope === scope && s.topicId === tid,
    );
  }

  /** The version that is active for `promptId` (or undefined = built-in default). */
  activeVersion(promptId: string, topicId?: string | null): PromptVersion | undefined {
    const userSel = this.selection(promptId, 'user');
    const userVer = userSel ? this.versionById(userSel.versionId) : undefined;
    if (userVer) return userVer;
    const topicSel = topicId ? this.selection(promptId, 'topic', topicId) : undefined;
    const topicVer = topicSel ? this.versionById(topicSel.versionId) : undefined;
    if (topicVer) return topicVer;
    return undefined;
  }

  /** Which source supplies the effective template for `promptId`. */
  activeSource(promptId: string, topicId?: string | null): PromptSource {
    const userSel = this.selection(promptId, 'user');
    const userVer = userSel ? this.versionById(userSel.versionId) : undefined;
    if (userVer) return { kind: 'user', version: userVer };
    const topicVer = topicId
      ? this.versionById(this.selection(promptId, 'topic', topicId)?.versionId)
      : undefined;
    if (topicVer && topicId) return { kind: 'topic', topicId, version: topicVer };
    return { kind: 'default' };
  }

  /**
   * Effective template for `promptId`:
   *   user selection → topic selection (`topicId`) → built-in default.
   * Data is loaded at startup (`app.ts` → `load()`); before that the built-in
   * default applies (always safe).
   */
  effective(id: string, topicId?: string | null): string {
    const d = promptDefaultById(id);
    if (!d) return '';
    const version = this.activeVersion(id, topicId);
    return version ? version.text : d.default;
  }

  /** True when this template has ANY selection (user or topic). */
  isCustom(id: string): boolean {
    return this._selections().some(s => s.promptId === id);
  }

  /**
   * Render the effective template for `id` with the given variable values.
   * Supports `{{name}}` substitution plus `{{#if name}}…{{else}}…{{/if}}`
   * conditional blocks (see `models/prompt-default.ts` for each template's
   * documented `vars`). Unknown placeholders are left as-is; conditional
   * blocks decide on truthiness (non-empty string / non-zero number / true).
   */
  render(id: string, vars: PromptVars, topicId?: string | null): string {
    return evaluateTemplate(this.effective(id, topicId), vars);
  }

  // ------------------------------------------------------------ version queries

  /** All stored versions for a template (user + all topics). */
  versionsFor(promptId: string): PromptVersion[] {
    return this._versions().filter(v => v.promptId === promptId);
  }

  /** Global (scope='user') versions for a template. */
  userVersions(promptId: string): PromptVersion[] {
    return this._versions().filter(v => v.promptId === promptId && v.scope === 'user');
  }

  /** Topic-bound versions for a template under `topicId`. */
  topicVersions(promptId: string, topicId: string): PromptVersion[] {
    return this._versions().filter(
      v => v.promptId === promptId && v.scope === 'topic' && v.topicId === topicId,
    );
  }

  /** The active selection for (promptId, scope[, topicId]). */
  selectionFor(promptId: string, scope: PromptScope, topicId?: string | null): PromptSelection | undefined {
    return this.selection(promptId, scope, topicId);
  }

  // ------------------------------------------------------------- mutations

  private applyVersion(version: PromptVersion): void {
    this._versions.update(list =>
      list.some(v => v.id === version.id)
        ? list.map(v => (v.id === version.id ? version : v))
        : [...list, version],
    );
  }

  /** Create a named version (global user scope, or bound to a topic). */
  async createVersion(
    promptId: string,
    name: string,
    text: string,
    scope: PromptScope,
    topicId?: string | null,
  ): Promise<PromptVersion> {
    const version = await this.api.createPromptVersion({
      promptId,
      name,
      text,
      scope,
      topicId,
    });
    this.applyVersion(version);
    return version;
  }

  /** Update a version's text (replaces the effective text when it is active). */
  async saveVersionText(id: string, text: string): Promise<PromptVersion> {
    const version = await this.api.updatePromptVersion(id, { text });
    this.applyVersion(version);
    return version;
  }

  /** Rename a version (its identity for the pickers). */
  async renameVersion(id: string, name: string): Promise<PromptVersion> {
    const version = await this.api.updatePromptVersion(id, { name });
    this.applyVersion(version);
    return version;
  }

  /** Delete a version (any selection pointing at it is dropped server-side). */
  async deleteVersion(id: string): Promise<void> {
    await this.api.deletePromptVersion(id);
    this._versions.update(list => list.filter(v => v.id !== id));
    this._selections.update(list => list.filter(s => s.versionId !== id));
  }

  /** Set the active version for (promptId, scope[, topicId]). */
  async selectVersion(
    promptId: string,
    versionId: string,
    scope: PromptScope,
    topicId?: string | null,
  ): Promise<PromptSelection> {
    const selection = await this.api.setPromptSelection({ promptId, scope, topicId, versionId });
    this._selections.update(list => {
      const others = list.filter(
        s => !(s.promptId === promptId && s.scope === scope && s.topicId === (topicId ?? null)),
      );
      return [...others, selection];
    });
    return selection;
  }

  /** Clear the active version for (promptId, scope[, topicId]) — falls through. */
  async clearSelection(promptId: string, scope: PromptScope, topicId?: string | null): Promise<void> {
    await this.api.deletePromptSelection(promptId, scope, topicId);
    this._selections.update(list =>
      list.filter(
        s => !(s.promptId === promptId && s.scope === scope && s.topicId === (topicId ?? null)),
      ),
    );
  }

  /**
   * Revert `promptId` to the built-in default: clears the user selection AND
   * (when a topic is given) the topic selection, so nothing overrides.
   */
  async revertToDefault(promptId: string, topicId?: string | null): Promise<void> {
    await this.clearSelection(promptId, 'user');
    if (topicId) await this.clearSelection(promptId, 'topic', topicId);
  }

  // ---- backward-compatible aliases used by the legacy settings UI ----

  /**
   * Update the effective template text. When a user version is active it is
   * updated in place; otherwise a new user version named "Customized" is
   * created and selected. Empty text clears the selection (revert to default).
   */
  async update(id: string, text: string): Promise<void> {
    if (!promptDefaultById(id)) return;
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      await this.revertToDefault(id);
      return;
    }
    const active = this.activeVersion(id);
    if (active && active.scope === 'user') {
      await this.saveVersionText(active.id, text);
    } else {
      const version = await this.createVersion(id, 'Customized', text, 'user');
      await this.selectVersion(id, version.id, 'user');
    }
  }

  /** Restore one template to its built-in default (drops all its selections). */
  reset(id: string): Promise<void> {
    return this.revertToDefault(id);
  }

  /** Restore every template to its built-in default (drops all selections). */
  resetAll(): Promise<void> {
    const promptIds = [...new Set(this._selections().map(s => s.promptId))];
    return Promise.all([
      ...promptIds.map(promptId => this.clearSelection(promptId, 'user')),
      ...promptIds.map(promptId => this.clearSelection(promptId, 'topic')),
    ]).then(() => undefined);
  }
}
import { Injectable, signal } from '@angular/core';
import {
  PROMPT_DEFAULTS,
  promptDefaultById,
  type PromptDefaultCategory,
  type PromptDefaultDef
} from '../models/prompt-default';

const LS_KEY = 'chat.promptDefaults';

/** Values that template variables may hold. Booleans allow `{{#if}}` blocks. */
export type PromptVars = Record<string, string | number | boolean>;

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

function readStored(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && promptDefaultById(id)) {
        out[id] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * User-editable overrides for the auto-generated LLM prompt templates.
 *
 * Each template has a built-in default (see `models/prompt-default.ts`) and a
 * per-browser override stored in localStorage (like the theme). `effective(id)`
 * returns the override when present, otherwise the built-in default, so the
 * LLM call sites always use the user's latest value. Empty overrides and
 * overrides that equal the default are pruned automatically so a reset is a
 * clean delete.
 *
 * Prompts are English-only (not i18n).
 */
@Injectable({ providedIn: 'root' })
export class PromptDefaultsService {
  /** Map of id → user override for templates the user has customized. */
  private readonly _overrides = signal<Record<string, string>>(readStored());

  /** Public readonly override map (reactive, for the settings UI). */
  readonly overrides = this._overrides.asReadonly();

  /** All customized override ids (reactive, for the settings UI). */
  readonly customized = signal<string[]>([]);

  constructor() {
    this.syncCustomized();
  }

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

  /** Effective template: the user override when set, otherwise the default. */
  effective(id: string): string {
    const d = promptDefaultById(id);
    if (!d) return '';
    return this.overrides()[id] ?? d.default;
  }

  /** True when the user has customized this template. */
  isCustom(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.overrides(), id);
  }

  /**
   * Set (or clear) the override for one template. Passing the exact default
   * text removes the override. Empty text restores the default as well.
   */
  update(id: string, text: string): void {
    if (!promptDefaultById(id)) return;
    this._overrides.update(map => {
      const next = { ...map };
      const trimmed = text ?? '';
      if (!trimmed.trim() || trimmed === promptDefaultById(id)!.default) {
        delete next[id];
      } else {
        next[id] = trimmed;
      }
      return next;
    });
    this.persist();
  }

  /** Restore one template to its built-in default. */
  reset(id: string): void {
    if (!promptDefaultById(id)) return;
    this._overrides.update(map => {
      const next = { ...map };
      delete next[id];
      return next;
    });
    this.persist();
  }

  /** Restore every template to its built-in default. */
  resetAll(): void {
    this._overrides.set({});
    this.persist();
  }

  /**
   * Render the effective template for `id` with the given variable values.
   * Supports `{{name}}` substitution plus `{{#if name}}…{{else}}…{{/if}}`
   * conditional blocks (see `models/prompt-default.ts` for each template's
   * documented `vars`). Unknown placeholders are left as-is; conditional
   * blocks decide on truthiness (non-empty string / non-zero number / true).
   */
  render(id: string, vars: PromptVars): string {
    return evaluateTemplate(this.effective(id), vars);
  }

  private persist(): void {
    this.syncCustomized();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.overrides()));
    } catch {
      // storage may be unavailable (private mode / SSR) — ignore.
    }
  }

  private syncCustomized(): void {
    this.customized.set(
      PROMPT_DEFAULTS
        .map(d => d.id)
        .filter(id => this.isCustom(id))
    );
  }
}
import { Injectable, signal } from '@angular/core';

const LS_KEY = 'chat.view.recentModelIds';
/** How many recently used models the picker keeps (excluding the current one). */
const MAX_RECENT = 6;

/**
 * Most-recently-used WRITING models, newest first.
 *
 * The direction editor's model listbox offers the current model first, then
 * the models that were actually used last, then the rest alphabetically — so
 * switching back to the model used for the previous chapter takes one click
 * instead of scanning the whole catalog.
 *
 * The list holds MODEL ids (`modelId`, not the catalog row id) and is stored
 * in localStorage, so it survives restarts. Recording happens where a writing
 * model is actually picked for a request (the flow / use-case runners), not
 * when a listbox is merely displayed.
 */
@Injectable({ providedIn: 'root' })
export class ModelRecencyService {
  private readonly _recentIds = signal<string[]>(ModelRecencyService.readStored());

  /** Recently used model ids, newest first (read-only). */
  readonly recentIds = this._recentIds.asReadonly();

  /** Move `modelId` to the front of the recently-used list. */
  remember(modelId: string | null | undefined): void {
    const id = (modelId ?? '').trim();
    if (!id) return;
    const next = [id, ...this._recentIds().filter(x => x !== id)].slice(0, MAX_RECENT);
    if (next.length === this._recentIds().length && next.every((v, i) => v === this._recentIds()[i])) {
      return; // already at the front — nothing changed
    }
    this._recentIds.set(next);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode) — the list still works per session.
    }
  }

  /** Forget the whole list (e.g. for tests / a settings reset). */
  clear(): void {
    this._recentIds.set([]);
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* best-effort */
    }
  }

  private static readStored(): string[] {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .slice(0, MAX_RECENT);
    } catch {
      return [];
    }
  }
}

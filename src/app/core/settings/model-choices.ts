import { ModelEntry } from '../../models/chat-config';

/** One `<optgroup>` of a model picker. */
export interface ModelChoiceGroup {
  /** Group caption (localized by the caller/component). */
  readonly title: string;
  readonly models: ModelEntry[];
}

/** Localized captions of the three groups. */
export interface ModelChoiceLabels {
  /** Caption of the group holding the CURRENT model. */
  readonly current: string;
  /** Caption of the group holding the recently used models. */
  readonly recent: string;
  /** Caption of the group holding every remaining model. */
  readonly all: string;
}

function keyOf(item: { id: string; modelId?: string }): string {
  return item.modelId || item.id;
}

/**
 * Order picker entries as "current → recently used → everything else".
 *
 * The current choice stays at the very top (it is what the picker shows when
 * it opens), then the models that were actually used last (newest first), and
 * only afterwards the remaining entries in their incoming order (alphabetical
 * for `enabledModels()`). Entries are never repeated — a `<select>` with two
 * options of the same value is ambiguous, and the current model usually also
 * appears in the recent list.
 *
 * Generic over any `{ id, modelId? }` shape so both the `ModelEntry` pickers
 * and the confirm dialog's provider-carrying `ConfirmModelOption` lists can use
 * it.
 */
export function orderChoiceGroups<T extends { id: string; modelId?: string }>(
  items: readonly T[],
  currentId: string | null | undefined,
  recentIds: readonly string[],
  labels: ModelChoiceLabels,
  match: (item: T, id: string) => boolean = (item, id) => item.modelId === id || item.id === id,
): { title: string; items: T[] }[] {
  const taken = new Set<string>();
  const collect = (matches: (item: T) => boolean): T[] => {
    const out: T[] = [];
    for (const item of items) {
      if (!matches(item)) continue;
      const key = keyOf(item);
      if (taken.has(key)) continue;
      taken.add(key);
      out.push(item);
    }
    return out;
  };

  const current = currentId ? collect(item => match(item, currentId)) : [];
  // The RECENT group follows the MRU list's order (newest first), not the
  // incoming (alphabetical) order of the items.
  const recent: T[] = [];
  for (const id of recentIds) {
    const found = items.find(item => match(item, id));
    if (!found) continue;
    const key = keyOf(found);
    if (taken.has(key)) continue;
    taken.add(key);
    recent.push(found);
  }
  const rest = collect(() => true);

  const groups: { title: string; items: T[] }[] = [];
  if (current.length) groups.push({ title: labels.current, items: current });
  if (recent.length) groups.push({ title: labels.recent, items: recent });
  if (rest.length) groups.push({ title: labels.all, items: rest });
  return groups;
}

/** {@link orderChoiceGroups} for enabled-model pickers (`ModelEntry[]`). */
export function orderModelChoices(
  models: readonly ModelEntry[],
  currentId: string | null | undefined,
  recentIds: readonly string[],
  labels: ModelChoiceLabels,
): ModelChoiceGroup[] {
  return orderChoiceGroups(models, currentId, recentIds, labels).map(g => ({
    title: g.title,
    models: g.items,
  }));
}

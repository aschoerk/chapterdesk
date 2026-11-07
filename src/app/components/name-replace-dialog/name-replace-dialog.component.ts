import {
  Component,
  computed,
  effect,
  inject,
  signal,
  HostListener,
  viewChild,
  ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { NameReplaceDialogService } from '../../core/dialogs/name-replace-dialog.service';
import { NameDictionaryService } from '../../core/names/name-dictionary.service';
import {
  findNames,
  applyNameReplacements,
  findOccurrences,
  buildNameIndex,
  filterCandidates,
  mightBeSurnameRow,
  nameKey,
  type NameReplaceRow,
  type NameOccurrence,
  type NameFilters,
  type NameIndex,
  type NameTextUnit,
} from '../../core/names/name-replace';
import { EXCLUDED_WORD_LANGUAGE } from '../../models/name-entry';

/** How the found names are ordered in the list. */
export type NameReplaceSortMode = 'first' | 'alpha';

@Component({
  selector: 'app-name-replace-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './name-replace-dialog.component.html',
  styleUrl: './name-replace-dialog.component.css',
})
export class NameReplaceDialogComponent {
  readonly dialog = inject(NameReplaceDialogService);
  readonly dictionary = inject(NameDictionaryService);
  readonly i18n = inject(I18nService);

  /** All found name rows (find + propose), before sorting / filtering. */
  private readonly allRows = signal<NameReplaceRow[]>([]);
  /** Order of the list: by first occurrence in the text, or alphabetically. */
  readonly sortMode = signal<NameReplaceSortMode>('first');
  /**
   * Show only rows that could be surnames: surname/place/brand entries, plus
   * names without a known classification (unknown capitalized words, legacy
   * entries). Only positively known GIVEN names are hidden.
   */
  readonly onlySurnames = signal(false);
  /** Names already handled in this chat (hidden from the list). */
  readonly handled = signal<string[]>([]);

  /**
   * The rows RENDERED in the table: handled names and (optionally) everything
   * that is not a surname are filtered out, then the list is sorted.
   */
  readonly rows = computed(() => {
    const handledKeys = new Set(this.handled().map((n) => nameKey(n)));
    const surnamesOnly = this.onlySurnames();
    const list = this.allRows().filter((row) => {
      if (handledKeys.has(nameKey(row.form))) return false;
      if (surnamesOnly && !mightBeSurnameRow(row)) return false;
      return true;
    });
    return this.sortMode() === 'alpha'
      ? [...list].sort((a, b) =>
          a.form.localeCompare(b.form, this.i18n.localeId(), { sensitivity: 'base' }),
        )
      : [...list].sort((a, b) => {
          const pa = this.firstPosByForm.get(a.form) ?? Number.MAX_SAFE_INTEGER;
          const pb = this.firstPosByForm.get(b.form) ?? Number.MAX_SAFE_INTEGER;
          if (pa !== pb) return pa - pb;
          return a.form.localeCompare(b.form, this.i18n.localeId(), { sensitivity: 'base' });
        });
  });
  /** Number of found rows before the handled/surname filters (empty hint). */
  readonly foundCount = computed(() => this.allRows().length);

  /** Include capitalized words that are not in the dictionary (default ON). */
  readonly includeUnknown = signal(true);
  /**
   * Only SEARCH assistant messages (default ON). User/system nodes are skipped
   * when finding candidates — but an approved replacement is still applied to
   * every visible message, so the text stays consistent.
   */
  readonly onlyAssistant = signal(true);
  /** Language filter applied to the dictionary (null = any). */
  readonly language = signal<string | null>(null);

  /** The word→position hashmap for the current units (built once). */
  private nameIndex: NameIndex | null = null;
  /** The units currently in scope (assistant-only when the toggle is on). */
  private scopedUnits: NameTextUnit[] = [];

  readonly approvedCount = computed(() => this.rows().filter((r) => r.approved).length);
  /**
   * Rows whose proposal came from a PERSISTED replacement (and are not
   * excluded) — the ones "Accept proposals" approves.
   */
  readonly savedProposalCount = computed(
    () => this.rows().filter((r) => r.fromSaved && !r.excluded).length,
  );
  /** Number of replacements remembered in the database. */
  readonly savedCount = computed(() => this.dictionary.replacements().length);
  /** Feedback line after "Use saved replacements" (null = none). */
  readonly savedInfo = signal<string | null>(null);
  /**
   * Rows ticked "exclude": unknown words are written to the dictionary as
   * excluded words (forever), dictionary names are only marked as handled in
   * this chat — both are persisted on apply.
   */
  readonly excludedCount = computed(() => this.rows().filter((r) => r.excluded).length);

  /** form → position of its FIRST occurrence in the document (sort order). */
  private firstPosByForm = new Map<string, number>();
  /** unit key → index in the scanned unit list (document order). */
  private unitOrder = new Map<string, number>();

  /** Pixel offset by which the dialog has been dragged (applied as a translate). */
  readonly dragPos = signal({ x: 0, y: 0 });
  /** True while the dialog is being dragged (suppresses backdrop dismiss). */
  readonly dragging = signal(false);
  private dragStartPtr = { x: 0, y: 0 };
  private dragStartPos = { x: 0, y: 0 };
  /** True once the stored position has been restored for this instance. */
  private posRestored = false;

  /** Dialog element (for measuring the current size at resize start). */
  readonly dialogEl = viewChild<ElementRef<HTMLElement>>('dialog');

  /** Minimum / maximum dialog sizes in px. */
  private static readonly MIN_W = 420;
  private static readonly MIN_H = 320;
  private static readonly SIZE_KEY = 'name-replace-dialog.size';
  /** localStorage key for the persisted drag offset (position). */
  private static readonly POS_KEY = 'name-replace-dialog.pos';
  /** Minimum px of the dialog that must stay inside the viewport (per axis). */
  private static readonly KEEP_VISIBLE = 120;

  /** Explicit user-set size (null = auto-fit to content). */
  readonly size = signal<{ width: number; height: number } | null>(this.readStoredSize());
  /** True while the dialog is being resized. */
  readonly resizing = signal(false);
  private resizeStartPtr = { x: 0, y: 0 };
  private resizeStartSize = { width: 0, height: 0 };

  /** Read the last persisted dialog size from localStorage (clamped). */
  private readStoredSize(): { width: number; height: number } | null {
    try {
      const raw = localStorage.getItem(NameReplaceDialogComponent.SIZE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { width?: number; height?: number };
      const width = Number(parsed.width);
      const height = Number(parsed.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      const maxW = Math.floor(window.innerWidth * 0.94);
      const maxH = Math.floor(window.innerHeight * 0.88);
      return {
        width: Math.min(maxW, Math.max(NameReplaceDialogComponent.MIN_W, Math.round(width))),
        height: Math.min(maxH, Math.max(NameReplaceDialogComponent.MIN_H, Math.round(height))),
      };
    } catch {
      return null;
    }
  }

  /** Persist the current dialog size to localStorage. */
  private persistSize(): void {
    const s = this.size();
    if (!s) return;
    try {
      localStorage.setItem(NameReplaceDialogComponent.SIZE_KEY, JSON.stringify(s));
    } catch {
      /* private mode / blocked storage */
    }
  }

  /** Read the last persisted drag offset from localStorage (raw, unclamped). */
  private readStoredPos(): { x: number; y: number } | null {
    try {
      const raw = localStorage.getItem(NameReplaceDialogComponent.POS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { x?: number; y?: number };
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: Math.round(x), y: Math.round(y) };
    } catch {
      return null;
    }
  }

  /** Persist the current drag offset to localStorage. */
  private persistPos(): void {
    try {
      localStorage.setItem(
        NameReplaceDialogComponent.POS_KEY,
        JSON.stringify(this.dragPos()),
      );
    } catch {
      /* private mode / blocked storage */
    }
  }

  /**
   * Clamp a drag offset so the dialog always stays at least partially visible:
   * `KEEP_VISIBLE` px must remain inside the viewport horizontally, and the
   * header (top edge) must not slide above the top of the window so the drag
   * handle stays reachable.
   */
  private clampPos(pos: { x: number; y: number }): { x: number; y: number } {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return { x: 0, y: 0 };
    const el = this.dialogEl()?.nativeElement;
    const rect = el?.getBoundingClientRect();
    const measured = !!rect && rect.width > 0 && rect.height > 0;
    const size = this.size();
    const width = measured
      ? rect!.width
      : (size?.width ?? NameReplaceDialogComponent.MIN_W);
    const height = measured
      ? rect!.height
      : (size?.height ?? NameReplaceDialogComponent.MIN_H);
    // The flex-centered, untranslated position = measured rect − current offset.
    const cur = this.dragPos();
    const baseLeft = measured ? rect!.left - cur.x : (window.innerWidth - width) / 2;
    const baseTop = measured ? rect!.top - cur.y : (window.innerHeight - height) / 2;
    const keep = NameReplaceDialogComponent.KEEP_VISIBLE;
    const minX = keep - width - baseLeft;
    const maxX = window.innerWidth - keep - baseLeft;
    const minY = -baseTop;
    const maxY = window.innerHeight - keep - baseTop;
    return {
      x: Math.round(Math.min(Math.max(pos.x, minX), maxX)),
      y: Math.round(Math.min(Math.max(pos.y, minY), maxY)),
    };
  }

  /** Re-clamp the current position (e.g. after a window resize) and persist it. */
  private reclampAndPersist(): void {
    if (!this.dialog.current()) return;
    const cur = this.dragPos();
    const clamped = this.clampPos(cur);
    if (clamped.x !== cur.x || clamped.y !== cur.y) {
      this.dragPos.set(clamped);
      this.persistPos();
    }
  }

  /** Begin resizing the dialog from the bottom-right handle. */
  onResizeStart(event: PointerEvent): void {
    if (event.button !== 0) return;
    const el = this.dialogEl()?.nativeElement;
    const rect = el?.getBoundingClientRect();
    this.resizeStartPtr = { x: event.clientX, y: event.clientY };
    this.resizeStartSize = rect
      ? { width: rect.width, height: rect.height }
      : { width: NameReplaceDialogComponent.MIN_W, height: NameReplaceDialogComponent.MIN_H };
    this.resizing.set(true);
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  onResizeMove(event: PointerEvent): void {
    if (!this.resizing()) return;
    const dx = event.clientX - this.resizeStartPtr.x;
    const dy = event.clientY - this.resizeStartPtr.y;
    const base = this.resizeStartSize;
    const maxW = Math.floor(window.innerWidth * 0.94);
    const maxH = Math.floor(window.innerHeight * 0.88);
    const width = Math.min(maxW, Math.max(NameReplaceDialogComponent.MIN_W, base.width + dx));
    const height = Math.min(maxH, Math.max(NameReplaceDialogComponent.MIN_H, base.height + dy));
    this.size.set({ width, height });
    event.preventDefault();
  }

  endResize(event: PointerEvent): void {
    if (!this.resizing()) return;
    this.resizing.set(false);
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.persistSize();
    // A bigger/smaller dialog changes the allowed offset range → re-clamp.
    this.reclampAndPersist();
  }

  /** Begin dragging the dialog from the header. */
  onDragStart(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.dragStartPtr = { x: event.clientX, y: event.clientY };
    this.dragStartPos = this.dragPos();
    this.dragPos.set({ ...this.dragStartPos });
    this.dragging.set(true);
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  onDragMove(event: PointerEvent): void {
    if (!this.dragging()) return;
    const dx = event.clientX - this.dragStartPtr.x;
    const dy = event.clientY - this.dragStartPtr.y;
    // Clamped while dragging so the dialog never leaves the viewport entirely.
    this.dragPos.set(
      this.clampPos({ x: this.dragStartPos.x + dx, y: this.dragStartPos.y + dy }),
    );
    event.preventDefault();
  }

  endDrag(event: PointerEvent): void {
    if (!this.dragging()) return;
    this.dragging.set(false);
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.dragPos.set(this.clampPos(this.dragPos()));
    this.persistPos();
  }

  /** Exact-case, whole-word occurrence list per row form, for ◀/▶ navigation. */
  private occurrencesByForm = new Map<string, NameOccurrence[]>();

  /** Rebuild the occurrence lists for every row (queries the shared index). */
  private rebuildOccurrences(units: NameTextUnit[], rows: NameReplaceRow[]): void {
    const map = new Map<string, NameOccurrence[]>();
    const firstPos = new Map<string, number>();
    this.unitOrder = new Map(units.map((u, i) => [u.key, i]));
    for (const row of rows) {
      const list = findOccurrences(units, row.form, this.nameIndex ?? undefined);
      map.set(row.form, list);
      // The list is in document order → its first entry is the earliest
      // occurrence ("sort by earliest occurrence in the text").
      const first = list[0];
      firstPos.set(
        row.form,
        first ? (this.unitOrder.get(first.key) ?? Number.MAX_SAFE_INTEGER) * 1e9 + first.start : Number.MAX_SAFE_INTEGER,
      );
      row.currentNth = undefined;
    }
    this.occurrencesByForm = map;
    this.firstPosByForm = firstPos;
  }

  /** Number of exact-case, whole-word occurrences of this name. */
  navTotal(row: NameReplaceRow): number {
    return this.occurrencesByForm.get(row.form)?.length ?? 0;
  }

  /** 1-based position of the current occurrence (0 = nothing navigated yet). */
  navPos(row: NameReplaceRow): number {
    const total = this.navTotal(row);
    if (total === 0) return 0;
    const nth = row.currentNth;
    if (nth === undefined || nth === null) return 0;
    return ((nth % total) + total) % total + 1;
  }

  /** Navigate to the nth occurrence (0-based, wraps) of the name. */
  private navigateToNth(row: NameReplaceRow, nth: number): void {
    const list = this.occurrencesByForm.get(row.form) ?? [];
    if (list.length === 0) return;
    const total = list.length;
    const clamped = ((nth % total) + total) % total;
    row.currentNth = clamped;
    this.touchRows();
    this.dialog.current()?.navigate?.(list[clamped]);
  }

  /** Re-emit the (mutable) rows so the computed list re-renders. */
  private touchRows(): void {
    this.allRows.update((rows) => [...rows]);
  }

  /** Next occurrence of this name (exact-case, whole-word; wraps around). */
  nextOccurrence(row: NameReplaceRow): void {
    this.navigateToNth(row, (row.currentNth ?? -1) + 1);
  }

  /** Previous occurrence of this name (exact-case, whole-word; wraps around). */
  prevOccurrence(row: NameReplaceRow): void {
    this.navigateToNth(row, (row.currentNth ?? 0) - 1);
  }

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      // "Only assistant messages" is the default scope on every open.
      this.onlyAssistant.set(true);
      // Names already handled in this chat are hidden from the list.
      this.handled.set([...(s.handled ?? [])]);
      if (!this.posRestored) {
        this.posRestored = true;
        // Restore the persisted drag offset, then clamp it against the REAL
        // element rect once the dialog has been laid out — the element does
        // not exist yet while this effect runs.
        const stored = this.readStoredPos();
        if (stored) this.dragPos.set(stored);
        // Runs after Angular has rendered the dialog → the element rect exists.
        queueMicrotask(() => this.reclampAndPersist());
      }
      void this.recompute(s.units);
      this.language.set(s.language ?? null);
    });
  }

  /** Recompute the found rows for the current units + dictionary + options. */
  private async recompute(units: NameTextUnit[]): Promise<void> {
    await this.dictionary.load();
    // Scope the units: by default only assistant messages are scanned. Units
    // without a role (non-chat callers, tests) are always included.
    this.scopedUnits = this.onlyAssistant()
      ? units.filter((u) => u.role === undefined || u.role === 'assistant')
      : units;
    // Build the word→position hashmap once; both name finding and the
    // occurrence navigation reuse it (no rescanning per form).
    this.nameIndex = buildNameIndex(this.scopedUnits);
    const entries = this.dictionary.entriesForLanguage(this.language());
    const found = findNames(this.scopedUnits, entries, {
      language: this.language(),
      includeUnknown: this.includeUnknown(),
    }, this.nameIndex);
    // Order + filtering happen in the `rows` computed (sort mode, surname
    // filter, already-handled names).
    this.rebuildOccurrences(this.scopedUnits, found);
    this.allRows.set(found);
    this.savedInfo.set(null);
  }

  /** Switch the list order between text order and alphabetical order. */
  setSortMode(mode: string): void {
    this.sortMode.set(mode === 'alpha' ? 'alpha' : 'first');
  }

  /** Toggle "only surnames" (rows that COULD be surnames). */
  setOnlySurnames(checked: boolean): void {
    this.onlySurnames.set(checked);
  }

  /**
   * "Use saved replacements" — set the replacement remembered in the database
   * as the PROPOSAL of every matching row. Nothing is approved yet, so the user
   * can review and then accept them all at once
   * ({@link acceptSavedProposals}). Rows without a saved replacement keep
   * their previous proposal.
   */
  useSavedReplacements(): void {
    const language = this.language();
    let matched = 0;
    this.allRows.update((list) =>
      list.map((row) => {
        const saved = this.dictionary.savedReplacementFor(row.form, language);
        if (!saved || !saved.to.trim()) return row;
        matched++;
        return { ...row, proposed: saved.to.trim(), fromSaved: true };
      }),
    );
    this.savedInfo.set(
      matched > 0
        ? this.i18n.t('nameReplace.savedApplied', { count: matched })
        : this.i18n.t('nameReplace.savedNone'),
    );
  }

  /**
   * "Accept proposals" — approve ONLY the rows whose proposal came from a
   * saved replacement. Every other row keeps its current approve state.
   */
  acceptSavedProposals(): void {
    const visible = new Set(this.rows().map((r) => r.form));
    this.allRows.update((list) =>
      list.map((r) =>
        visible.has(r.form) && r.fromSaved && !r.excluded
          ? { ...r, approved: true }
          : r,
      ),
    );
  }

  /** Forget a persisted replacement (it will not be proposed again). */
  async forgetSaved(replacement: { id: string; from: string }): Promise<void> {
    const key = nameKey(replacement.from);
    await this.dictionary.deleteReplacement(replacement.id);
    // Only the rows that used THIS replacement lose their "saved" mark.
    this.allRows.update((list) =>
      list.map((r) =>
        r.fromSaved && nameKey(r.form) === key ? { ...r, fromSaved: false } : r,
      ),
    );
    this.savedInfo.set(null);
  }

  /**
   * Restore a handled name: remove it from the per-chat handled list (and
   * persist that) so the dialog offers it again.
   */
  async removeHandled(name: string): Promise<void> {
    const key = nameKey(name);
    const next = this.handled().filter((n) => nameKey(n) !== key);
    this.handled.set(next);
    const s = this.dialog.current();
    if (s?.saveHandled) {
      try {
        await s.saveHandled(next);
      } catch (err: any) {
        console.error(err);
        alert(this.i18n.t('nameReplace.handledFailed', { error: err?.message || err }));
        return;
      }
    }
    if (s) await this.recompute(s.units);
  }

  onIncludeUnknownChange(): void {
    const s = this.dialog.current();
    if (!s) return;
    void this.recompute(s.units);
  }

  /** Toggle "only assistant messages" and re-scan the (now scoped) units. */
  onOnlyAssistantChange(): void {
    const s = this.dialog.current();
    if (!s) return;
    void this.recompute(s.units);
  }

  onLanguageChange(): void {
    const s = this.dialog.current();
    if (!s) return;
    void this.recompute(s.units);
  }

  toggleApproved(row: NameReplaceRow): void {
    row.approved = !row.approved;
    // Replace and exclude are mutually exclusive.
    if (row.approved) row.excluded = false;
    this.touchRows();
  }

  /**
   * Toggle "exclude": greys the line immediately as a visual cue, but nothing
   * is persisted until Apply. On Apply the word is written to the name
   * dictionary under `EXCLUDED_WORD_LANGUAGE` — that is permanent ("this is
   * never a name"), for unknown words AND for names that come from the name
   * list. Undo it in the Name lists dialog's "Excluded words" filter. Ticking
   * it clears any approve decision (and vice versa).
   */
  toggleExcluded(row: NameReplaceRow): void {
    row.excluded = !row.excluded;
    if (row.excluded) row.approved = false;
    this.touchRows();
  }

setProposed(row: NameReplaceRow, value: string): void {
  row.proposed = value;
  // A name set manually in the editbox counts as an explicit choice → ok.
  row.approved = true;
  row.excluded = false;
  // No longer the proposal that came from the database.
  row.fromSaved = false;
  this.touchRows();
}

/**
 * A candidate was picked from the "Replace with" listbox → treat it as an
 * explicit choice and mark the row approved (clearing any exclude tick).
 */
selectProposed(row: NameReplaceRow, value: string): void {
  row.proposed = value;
  row.approved = true;
  row.excluded = false;
  row.fromSaved = false;
  this.touchRows();
}

/**
 * Position the "Replace with" listbox dropdown at (or alphabetically nearest
 * to) the current proposal as soon as the user opens it. Native selects open
 * scrolled to their selected option, so we set the selectedIndex on
 * pointerdown/focus — BEFORE the dropdown renders. Changing the selection
 * programmatically does not fire a change event, so the proposal and the ok
 * flag stay untouched; blur restores the displayed value.
 */
positionProposedDropdown(sel: HTMLSelectElement, row: NameReplaceRow): void {
  const idx = row.candidates.indexOf(row.proposed);
  if (idx >= 0) {
    sel.selectedIndex = idx;
    return;
  }
  const nearest = this.nearestCandidate(row.candidates, row.proposed);
  if (nearest != null) {
    sel.selectedIndex = row.candidates.indexOf(nearest);
  }
}

/** Undo the dropdown-position preview on blur (nothing was picked). */
restoreProposedDropdown(sel: HTMLSelectElement, row: NameReplaceRow): void {
  sel.value = row.proposed;
}

/** Candidate with the longest shared prefix with `name` (alphabetical tie-break). */
private nearestCandidate(candidates: string[], name: string): string | null {
  if (candidates.length === 0) return null;
  const target = name.toLowerCase();
  let best = candidates[0]!;
  let bestPrefix = -1;
  for (const c of candidates) {
    const cl = c.toLowerCase();
    let p = 0;
    while (p < cl.length && p < target.length && cl[p] === target[p]) p++;
    if (p > bestPrefix || (p === bestPrefix && cl.localeCompare(best.toLowerCase()) < 0)) {
      bestPrefix = p;
      best = c;
    }
  }
  return best;
}

/** Approve every VISIBLE row (hidden/filtered-out rows are left alone). */
approveAll(): void {
  const visible = new Set(this.rows().map((r) => r.form));
  this.allRows.update((list) =>
    list.map((r) =>
      visible.has(r.form) && r.entry ? { ...r, approved: true, excluded: false } : r,
    ),
  );
}

/** Clear the approve/exclude ticks of the VISIBLE rows. */
clearAll(): void {
  const visible = new Set(this.rows().map((r) => r.form));
  this.allRows.update((list) =>
    list.map((r) => (visible.has(r.form) ? { ...r, approved: false, excluded: false } : r)),
  );
}

  /**
   * Change a row's m/f/s filter checkbox and re-filter the "Replace with"
   * listbox. If the current proposed replacement no longer fits, the default
   * jumps to the first candidate that does.
   */
  setFilter(row: NameReplaceRow, key: keyof NameFilters, checked: boolean): void {
    row.filters[key] = checked;
    row.candidates = filterCandidates(row.allCandidates, row.filters);
    if (!row.candidates.includes(row.proposed)) {
      row.proposed = row.candidates[0] ?? row.form;
    }
    this.touchRows();
  }

  /** Reset the row's listbox to show all same-initial suggestions. */
  resetFilters(row: NameReplaceRow): void {
    row.filters = { male: true, female: true, surname: true };
    row.candidates = filterCandidates(row.allCandidates, row.filters);
    this.touchRows();
  }

  /**
   * Apply the pending decisions and close:
   *  1. persist "exclude forever" words into the dictionary under the special
   *     excluded language — for UNKNOWN words AND for names that come from the
   *     name list (exclusion always means "never a name again", it is NOT a
   *     per-chat note; undo it in the Name lists dialog's "Excluded words"),
   *  2. remember the APPROVED replacements as HANDLED in this chat (that is the
   *     name the text carries afterwards), then
   *  3. apply the approved replacements to the visible units,
   *  4. PERSIST each applied replacement (from → to) in the database so it can
   *     be re-offered as a proposal later ("Use saved replacements").
   * Excluding is deferred to here so an accidental tick can be undone simply
   * by unticking before Apply.
   */
  async replaceApproved(): Promise<void> {
    const s = this.dialog.current();
    if (!s) return;
    const rows = this.rows();
    const approved = rows.filter((r) => r.approved);
    const exclusions = rows.filter((r) => r.excluded);
    if (approved.length === 0 && exclusions.length === 0) return;

    // First persist the exclusions, so a failed write surfaces before any text
    // gets replaced. Excluding is permanent (dictionary-level), never per chat:
    // the entry's name is added to the "known forms → skip" set, so neither the
    // name list nor the capital-letter detection can surface it again.
    for (const row of exclusions) {
      try {
        await this.dictionary.create({ name: row.form, language: EXCLUDED_WORD_LANGUAGE });
        row.excluded = false; // already persisted — drop the grey state
      } catch (err: any) {
        console.error(err);
        alert(this.i18n.t('nameReplace.excludeFailed', { error: err?.message || err }));
      }
    }

    // Remember the REPLACED names as handled in THIS chat so the dialog does
    // not offer them again (they can be restored from the "handled" panel).
    // IMPORTANT: after a replacement the text no longer contains the found
    // form — it contains the PROPOSED name. So an approved row is remembered
    // by its replacement (e.g. "Liz" → "Elizabeth" stores "Elizabeth"),
    // otherwise the new name would show up as a fresh row the next time.
    // Excluded rows are NOT handled names — they are excluded forever above.
    const decided = approved
      .map((r) => (r.proposed ?? '').trim() || r.form.trim())
      .filter(Boolean);
    if (decided.length > 0 && s.saveHandled) {
      const seen = new Set(this.handled().map((n) => nameKey(n)));
      const next = [...this.handled()];
      for (const form of decided) {
        const key = nameKey(form);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(form);
      }
      try {
        await s.saveHandled(next);
        this.handled.set(next);
      } catch (err: any) {
        console.error(err);
        alert(this.i18n.t('nameReplace.handledFailed', { error: err?.message || err }));
      }
    }

    if (approved.length === 0) {
      this.dialog.submit([]);
      return;
    }
    // Replace across ALL visible units, regardless of the search scope. The
    // "only assistant messages" checkbox limits FINDING candidates; an approved
    // name must be rewritten consistently in user and assistant messages alike.
    const updated = applyNameReplacements(s.units, rows);
    await s.apply(updated);

    // PERSIST the applied replacements (from → to) in the database, so the
    // dialog can offer them again as proposals later ("Use saved
    // replacements"). Changing a name leaves the original form gone, so this
    // is the only place that knows what it became. A proposal identical to the
    // found form is not a replacement and is skipped.
    for (const row of approved) {
      const from = row.form.trim();
      const to = (row.proposed ?? '').trim();
      if (!from || !to || nameKey(from) === nameKey(to)) continue;
      await this.dictionary.saveReplacement({ from, to, language: this.language() });
    }

    this.dialog.submit(approved);
  }

  cancel(): void {
    this.dialog.cancel();
  }

  private backdropPressStarted = false;

  onBackdropMousedown(ev: MouseEvent): void {
    this.backdropPressStarted = ev.target === ev.currentTarget;
  }

  onBackdrop(ev: MouseEvent): void {
    const dismiss = ev.target === ev.currentTarget && this.backdropPressStarted && !this.dragging();
    this.backdropPressStarted = false;
    if (dismiss) this.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.cancel();
    }
  }

  /** A window resize changes the allowed offset range → keep the dialog visible. */
  @HostListener('window:resize')
  onWindowResize(): void {
    this.reclampAndPersist();
  }
}
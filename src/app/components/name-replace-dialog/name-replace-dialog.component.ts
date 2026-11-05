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
  type NameReplaceRow,
  type NameOccurrence,
  type NameFilters,
  type NameIndex,
  type NameTextUnit,
} from '../../core/names/name-replace';
import { EXCLUDED_WORD_LANGUAGE } from '../../models/name-entry';

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

  /** The found name rows (find + propose + filter). */
  readonly rows = signal<NameReplaceRow[]>([]);
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
  /** Rows ticked "exclude forever" (pending a dictionary write on apply). */
  readonly excludedCount = computed(() =>
    this.rows().filter((r) => r.excluded && !r.entry).length,
  );

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
    for (const row of rows) {
      map.set(row.form, findOccurrences(units, row.form, this.nameIndex ?? undefined));
      row.currentNth = undefined;
    }
    this.occurrencesByForm = map;
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
    this.rows.update((rows) => [...rows]);
    this.dialog.current()?.navigate?.(list[clamped]);
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
    // Show the table sorted alphabetically by name.
    found.sort((a, b) =>
      a.form.localeCompare(b.form, this.i18n.localeId(), { sensitivity: 'base' }),
    );
    this.rebuildOccurrences(this.scopedUnits, found);
    this.rows.set(found);
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
  this.rows.update((list) => [...list]);
}

/**
 * Toggle "exclude forever" for an UNKNOWN row: greys the line immediately as
 * a visual cue, but nothing is persisted until Apply. Ticking it clears any
 * approve decision (and vice versa).
 */
toggleExcluded(row: NameReplaceRow): void {
  // Only unknown (non-dictionary) words can be excluded forever.
  if (row.entry) return;
  row.excluded = !row.excluded;
  if (row.excluded) row.approved = false;
  this.rows.update((list) => [...list]);
}

setProposed(row: NameReplaceRow, value: string): void {
  row.proposed = value;
  // A name set manually in the editbox counts as an explicit choice → ok.
  row.approved = true;
  row.excluded = false;
  this.rows.update((list) => [...list]);
}

/**
 * A candidate was picked from the "Replace with" listbox → treat it as an
 * explicit choice and mark the row approved (clearing any exclude tick).
 */
selectProposed(row: NameReplaceRow, value: string): void {
  row.proposed = value;
  row.approved = true;
  row.excluded = false;
  this.rows.update((list) => [...list]);
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

approveAll(): void {
  this.rows.update((list) =>
    list.map((r) => (r.entry ? { ...r, approved: true, excluded: false } : r)),
  );
}

clearAll(): void {
  this.rows.update((list) =>
    list.map((r) => ({ ...r, approved: false, excluded: false })),
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
    this.rows.update((list) => [...list]);
  }

  /** Reset the row's listbox to show all same-initial suggestions. */
  resetFilters(row: NameReplaceRow): void {
    row.filters = { male: true, female: true, surname: true };
    row.candidates = filterCandidates(row.allCandidates, row.filters);
    this.rows.update((list) => [...list]);
  }

  /**
   * Apply the pending decisions and close:
   *  1. persist "exclude forever" words into the dictionary under the special
   *     excluded language (so they never surface again), then
   *  2. apply the approved replacements to the visible units.
   * Excluding is deferred to here so an accidental tick can be undone simply
   * by unticking before Apply.
   */
  async replaceApproved(): Promise<void> {
    const s = this.dialog.current();
    if (!s) return;
    const approved = this.rows().filter((r) => r.approved);
    const exclusions = this.rows().filter((r) => r.excluded && !r.entry);
    if (approved.length === 0 && exclusions.length === 0) return;

    // First persist the confirmations, so a failed write surfaces before any
    // text gets replaced.
    for (const row of exclusions) {
      try {
        await this.dictionary.create({ name: row.form, language: EXCLUDED_WORD_LANGUAGE });
        row.excluded = false; // already persisted — drop the grey state
      } catch (err: any) {
        console.error(err);
        alert(this.i18n.t('nameReplace.excludeFailed', { error: err?.message || err }));
      }
    }

    if (approved.length === 0) {
      this.dialog.submit([]);
      return;
    }
    // Replace across ALL visible units, regardless of the search scope. The
    // "only assistant messages" checkbox limits FINDING candidates; an approved
    // name must be rewritten consistently in user and assistant messages alike.
    const updated = applyNameReplacements(s.units, this.rows());
    await s.apply(updated);
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
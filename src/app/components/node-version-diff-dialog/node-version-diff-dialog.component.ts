import {
  Component,
  HostListener,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type * as Monaco from 'monaco-editor';
import { DiffEditorComponent, type DiffEditorModel } from 'ngx-monaco-editor-v2';
import { I18nService } from '../../core/i18n/i18n.service';
import { ThemeService } from '../../core/settings/theme.service';
import {
  NodeVersionDiffDialogService,
  type TextDiffOption,
} from '../../core/dialogs/node-version-diff-dialog.service';
import { ChatNode } from '../../models/chat';

/** Change navigation / summary info derived from Monaco's line changes. */
interface ChangeInfo {
  count: number;
  added: number;
  removed: number;
}

/** Normalized option of the read-only "compare-with" dropdown. */
interface CompareEntry {
  id: string;
  label: string;
  text: string;
}

/**
 * "Compare versions" dialog for a chat node.
 *
 * Uses Monaco's built-in Diff Editor:
 *   - LEFT: the OLD version, read-only (selectable for copy).
 *   - RIGHT: the NEW version, fully editable (normal keys: select, copy, cut,
 *     paste, delete, undo).
 *   - Word/character-level changes inside a line are highlighted by Monaco.
 *   - The two panes scroll in sync automatically (Monaco diff editor).
 * Prev/next buttons move between changes; "Restore change" brings the current
 * block back from the old version into the editor. Dialog is resizable.
 * The edited result is only written back to the caller's draft on Apply — so
 * the change stays temporary until the caller's own Save is pressed.
 *
 * The same dialog also serves READ-ONLY text comparisons of versioned general
 * texts (topic / environment / persona fields) and prompt versions: there the
 * left side is a recorded text option and the right side is the current text,
 * both read-only (no restore / Apply).
 */
@Component({
  selector: 'app-node-version-diff-dialog',
  standalone: true,
  imports: [FormsModule, DiffEditorComponent],
  templateUrl: './node-version-diff-dialog.component.html',
  styleUrl: './node-version-diff-dialog.component.css',
})
export class NodeVersionDiffDialogComponent {
  readonly dialog = inject(NodeVersionDiffDialogService);
  readonly i18n = inject(I18nService);
  readonly theme = inject(ThemeService);

  /** Id of the selected prior version to compare against. */
  readonly selectedVersionId = signal<string | null>(null);
  /** Seed for the editable (modified) side, captured when the dialog opens. */
  private readonly openSeed = signal('');
  /** Edits captured from the modified editor before a version switch. */
  private readonly preservedDraft = signal<string | null>(null);

  /** The live Monaco diff-editor instance (from onInit). */
  private editor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private readonly dialogEl = viewChild<ElementRef<HTMLElement>>('dialogEl');

  /** True when comparing against siblings (compare-siblings mode). */
  readonly isSiblingMode = computed(() => (this.dialog.current()?.siblings?.length ?? 0) > 0);

  /** True for a generic text comparison (topic / environment / persona / prompt). */
  readonly isTextMode = computed(() => (this.dialog.current()?.texts?.length ?? 0) > 0);

  /** True when the right side must not be edited and Apply is hidden. */
  readonly readOnly = computed(() => this.dialog.current()?.readOnly === true);

  /** The READ-ONLY "compare-with" nodes: siblings (if any) else prior versions. */
  readonly versions = computed<ChatNode[]>(() => {
    const s = this.dialog.current();
    return s?.siblings && s.siblings.length > 0 ? s.siblings : (s?.versions ?? []);
  });

  /** The READ-ONLY "compare-with" entries: generic texts, else nodes. */
  readonly entries = computed<CompareEntry[]>(() => {
    const s = this.dialog.current();
    if (s?.texts && s.texts.length > 0) return s.texts;
    return this.versions().map((v) => ({
      id: v.id,
      label: this.optionLabel(v),
      text: v.content ?? '',
    }));
  });

  readonly selectedEntry = computed<CompareEntry | null>(() => {
    const id = this.selectedVersionId();
    return this.entries().find((v) => v.id === id) ?? this.entries()[0] ?? null;
  });

  readonly selectedVersion = computed<ChatNode | null>(() => {
    const id = this.selectedVersionId();
    return this.versions().find((v) => v.id === id) ?? this.versions()[0] ?? null;
  });

  readonly originalModel = computed<DiffEditorModel>(() => ({
    code: this.selectedEntry()?.text ?? '',
    language: 'plaintext',
  }));

  readonly modifiedModel = computed<DiffEditorModel>(() => ({
    code: this.preservedDraft() ?? this.openSeed(),
    language: 'plaintext',
  }));

  /**
   * Editor options. `readOnly` follows the dialog mode: chat-node version
   * compare = editable right side; generic text compare = both read-only.
   */
  readonly options = computed<Monaco.editor.IStandaloneDiffEditorConstructionOptions>(() => ({
    renderSideBySide: true,
    readOnly: this.readOnly(), // modified (right) side is editable only in node mode
    originalEditable: false, // old (left) side stays read-only
    automaticLayout: true, // tracks the resizable dialog
    wordWrap: 'off',
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    lineNumbers: 'on',
    folding: false,
    renderOverviewRuler: false,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: 'none',
    scrollbar: { verticalScrollbarSize: 10 },
    fontSize: 12.8,
    lineHeight: 20,
  }));

  /** Current change index for prev/next navigation. */
  readonly changeIndex = signal(0);
  readonly info = signal<ChangeInfo>({ count: 0, added: 0, removed: 0 });
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      this.openSeed.set(s.newText);
      this.preservedDraft.set(null);
      const ids = s.texts && s.texts.length > 0
        ? s.texts.map((t) => t.id)
        : (s.siblings && s.siblings.length > 0 ? s.siblings : (s.versions ?? [])).map((v) => v.id);
      const initial = s.initialId && ids.includes(s.initialId) ? s.initialId : ids[0] ?? null;
      this.selectedVersionId.set(initial);
      this.changeIndex.set(0);
    });
    // Keep Monaco's theme in step with the app theme without re-creating the editor.
    effect(() => {
      const name = this.theme.resolved() === 'dark' ? 'vs-dark' : 'vs';
      (window as { monaco?: { editor?: { setTheme?: (n: string) => void } } }).monaco?.editor
        ?.setTheme?.(name);
    });
  }

  /** Monaco created the diff editor. */
  onInit(editor: Monaco.editor.IStandaloneDiffEditor): void {
    this.editor = editor;
    (window as { monaco?: { editor?: { setTheme?: (n: string) => void } } }).monaco?.editor
      ?.setTheme?.(this.theme.resolved() === 'dark' ? 'vs-dark' : 'vs');
    editor.getModifiedEditor().onDidChangeModelContent(() => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refreshChanges(), 80);
    });
    this.refreshChanges();
  }

  onVersionChange(id: string): void {
    if (this.editor) this.preservedDraft.set(this.editor.getModifiedEditor().getValue());
    this.selectedVersionId.set(id);
    this.changeIndex.set(0);
  }

  hasDiff(): boolean {
    return this.info().count > 0;
  }

  formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${this.i18n.formatDate(date, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  /** Dropdown label: sibling content preview in sibling mode, else version+date. */
  optionLabel(v: ChatNode): string {
    if (this.isSiblingMode()) return this.previewLine(v.content ?? '');
    return `${this.i18n.t('node.version', { n: v.version })} · ${this.formatDate(v.updatedAt || v.createdAt)}`;
  }

  private previewLine(text: string): string {
    const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
    return line.length > 42 ? `${line.slice(0, 42)}…` : line;
  }

  // -------------------------------------------------------------------------
  // Change navigation (Monaco gives line changes + built-in scroll sync)
  // -------------------------------------------------------------------------

  nextChange(): void {
    const n = this.info().count;
    if (n <= 1) return;
    this.changeIndex.set((this.changeIndex() + 1) % n);
    this.revealCurrent();
  }

  prevChange(): void {
    const n = this.info().count;
    if (n <= 1) return;
    this.changeIndex.set((this.changeIndex() - 1 + n) % n);
    this.revealCurrent();
  }

  private revealCurrent(): void {
    const ed = this.editor;
    const changes = ed?.getLineChanges() ?? [];
    const c = changes[this.changeIndex()];
    if (!c || !ed) return;
    const modLine =
      c.modifiedStartLineNumber ?? this.inferModifiedLine(changes, this.changeIndex()) + 1;
    ed.revealPositionInCenter({ lineNumber: Math.max(1, modLine), column: 1 });
    if (c.originalStartLineNumber != null) {
      ed.getOriginalEditor().revealLineInCenter(c.originalStartLineNumber);
    }
  }

  /** For a pure deletion, find the modified line just before the hunk. */
  private inferModifiedLine(changes: Monaco.editor.ILineChange[], index: number): number {
    for (let i = index - 1; i >= 0; i--) {
      if (changes[i].modifiedEndLineNumber != null) return changes[i].modifiedEndLineNumber!;
    }
    return 0;
  }

  /**
   * Restore the current change block from the old version into the new one —
   * the whole hunk (hand edits inside it are discarded).
   */
  restoreCurrentChange(): void {
    const ed = this.editor;
    const changes = ed?.getLineChanges() ?? [];
    const c = changes[this.changeIndex()];
    if (!c || !ed) return;
    const originalModel = ed.getModel()?.original;
    if (!originalModel) return;
    const restoredText = originalModel
      .getValue()
      .split('\n')
      .slice(c.originalStartLineNumber - 1, c.originalEndLineNumber)
      .join('\n');
    const modified = ed.getModifiedEditor();
    if (c.modifiedStartLineNumber != null) {
      modified.executeEdits('restore', [
        {
          range: {
            startLineNumber: c.modifiedStartLineNumber,
            startColumn: 1,
            endLineNumber: c.modifiedEndLineNumber!,
            endColumn: Number.MAX_SAFE_INTEGER,
          },
          text: restoredText,
        },
      ]);
    } else {
      const insertLine = Math.max(1, this.inferModifiedLine(changes, this.changeIndex()) + 1);
      modified.executeEdits('restore', [
        {
          range: {
            startLineNumber: insertLine,
            startColumn: 1,
            endLineNumber: insertLine,
            endColumn: 1,
          },
          text: restoredText ? restoredText + '\n' : '',
        },
      ]);
    }
    this.refreshChanges();
  }

  private refreshChanges(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const ed = this.editor;
    if (!ed) return;
    const changes = ed.getLineChanges() ?? [];
    let added = 0;
    let removed = 0;
    for (const c of changes) {
      if (c.modifiedStartLineNumber != null) {
        added += c.modifiedEndLineNumber! - c.modifiedStartLineNumber + 1;
      }
      if (c.originalStartLineNumber != null) {
        removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
      }
    }
    this.info.set({ count: changes.length, added, removed });
    const i = this.changeIndex();
    if (changes.length === 0) this.changeIndex.set(0);
    else if (i >= changes.length) this.changeIndex.set(changes.length - 1);
  }

  apply(): void {
    // Read-only comparisons have nothing to write back — closing is Apply.
    if (this.readOnly()) {
      this.dialog.cancel();
      return;
    }
    const value = this.editor ? this.editor.getModifiedEditor().getValue() : this.openSeed();
    this.dialog.submit(value);
  }

  /** Explicit pane labels (generic text comparisons only; may be empty). */
  originalLabel(): string {
    return this.dialog.current()?.originalLabel ?? '';
  }

  modifiedLabel(): string {
    return this.dialog.current()?.modifiedLabel ?? '';
  }

  /** True when the caller supplied pane labels to show above the editor. */
  hasPaneLabels(): boolean {
    return !!(this.originalLabel() || this.modifiedLabel());
  }

  /** Hint line under the editor for the current mode. */
  hintKey(): string {
    if (this.readOnly()) return 'nodeVersionDiff.readonlyHintTexts';
    return this.isSiblingMode()
      ? 'nodeVersionDiff.readonlyHintSiblings'
      : 'nodeVersionDiff.readonlyHint';
  }

  // -------------------------------------------------------------------------
  // Resizable window
  // -------------------------------------------------------------------------

  readonly size = signal<{ w: number; h: number } | null>(null);
  readonly resizing = signal(false);
  private resizeStart: { x: number; y: number; w: number; h: number } | null = null;

  startResize(ev: MouseEvent): void {
    ev.preventDefault();
    const el = this.dialogEl()?.nativeElement;
    const rect = el?.getBoundingClientRect();
    this.resizeStart = {
      x: ev.clientX,
      y: ev.clientY,
      w: rect?.width ?? 1060,
      h: rect?.height ?? 680,
    };
    this.resizing.set(true);
  }

  @HostListener('document:mousemove', ['$event'])
  onDocMouseMove(ev: MouseEvent): void {
    if (!this.resizeStart) return;
    const rs = this.resizeStart;
    this.size.set({
      w: Math.max(560, rs.w + ev.clientX - rs.x),
      h: Math.max(400, rs.h + ev.clientY - rs.y),
    });
  }

  @HostListener('document:mouseup')
  onDocMouseUp(): void {
    if (!this.resizeStart) return;
    this.resizeStart = null;
    this.resizing.set(false);
  }

  // -------------------------------------------------------------------------
  // Backdrop / Escape (dialog conventions)
  // -------------------------------------------------------------------------

  private backdropPressStarted = false;

  onBackdropMousedown(ev: MouseEvent): void {
    this.backdropPressStarted = ev.target === ev.currentTarget;
  }

  onBackdrop(ev: MouseEvent): void {
    const dismiss = ev.target === ev.currentTarget && this.backdropPressStarted;
    this.backdropPressStarted = false;
    if (dismiss) this.dialog.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.dialog.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.dialog.cancel();
    }
  }
}
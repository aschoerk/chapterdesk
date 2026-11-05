import { Component, computed, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { NameListDialogService } from '../../core/dialogs/name-list-dialog.service';
import { NameDictionaryService } from '../../core/names/name-dictionary.service';
import { BUILTIN_NAMES } from '../../core/names/builtin-names';
import {
  NAME_LANGUAGES,
  EXCLUDED_WORD_LANGUAGE,
  type NameEntry,
  type NameCategory,
} from '../../models/name-entry';
import type { CreateNameEntryRequest } from '../../models/name-entry';

/** The categories a name can have. */
export const NAME_CATEGORIES: (NameCategory | '')[] = [
  '',
  'male',
  'female',
  'surname',
  'place',
  'brand',
];

/** A blank editable form row for adding / editing a name entry. */
interface NameForm {
  id: string | null;
  name: string;
  language: string;
  category: NameCategory | '';
}

function blankForm(): NameForm {
  return {
    id: null,
    name: '',
    language: '',
    category: '',
  };
}

@Component({
  selector: 'app-name-list-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './name-list-dialog.component.html',
  styleUrl: './name-list-dialog.component.css',
})
export class NameListDialogComponent {
  readonly dialog = inject(NameListDialogService);
  readonly dictionary = inject(NameDictionaryService);
  readonly i18n = inject(I18nService);

  /** Language filter ('' = all). */
  readonly filter = signal('');
  /** The entry being edited inline (id set), or the "new entry" form (id null). */
  readonly form = signal<NameForm>(blankForm());
  /** True while an edit form is open. */
  readonly editing = signal(false);
  /** Import textarea content. */
  readonly importText = signal('');
  /** True while a save/import is in flight. */
  readonly saving = signal(false);
  /** True while the bundled (zxcvbn) names are being seeded. */
  readonly seedingBuiltin = signal(false);
  /** True when the dictionary changed since the dialog opened. */
  private changed = false;

  readonly languages = NAME_LANGUAGES;
  /** Special language tag that marks "excluded forever" words. */
  readonly excludedLanguage = EXCLUDED_WORD_LANGUAGE;

  readonly filtered = computed(() => {
    const all = this.dictionary.entries();
    const f = this.filter().trim().toLowerCase();
    if (!f) return all;
    return all.filter((e) => (e.language ?? '').toLowerCase() === f);
  });

  /** True for a persisted "excluded forever" word (not a real name). */
  isExcludedEntry(entry: NameEntry): boolean {
    return (entry.language ?? '').toLowerCase() === EXCLUDED_WORD_LANGUAGE;
  }

  /** The human category label for an entry ('—' when unset). */
  categoryLabel(entry: NameEntry): string {
    if (!entry.category) return this.i18n.t('nameList.categoryNone');
    return this.i18n.t(`nameCategory.${entry.category}`);
  }

  /** The raw category code for an entry (for styling classes). */
  entryCategory(entry: NameEntry): NameCategory | null {
    return entry.category ?? null;
  }

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      this.filter.set(s.language ?? '');
      this.form.set(blankForm());
      this.editing.set(false);
      this.importText.set('');
      this.changed = false;
      void this.dictionary.load();
    });
  }

  onFilterChange(): void {
    // Keep the filter in sync; nothing else to do (computed reacts).
  }

  startNew(): void {
    this.form.set(blankForm());
    this.editing.set(true);
  }

  startEdit(entry: NameEntry): void {
    this.form.set({
      id: entry.id,
      name: entry.name,
      language: entry.language ?? '',
      category: entry.category ?? '',
    });
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
  }

  async saveForm(): Promise<void> {
    const f = this.form();
    if (!f.name.trim() || this.saving()) return;
    this.saving.set(true);
    try {
      const data: CreateNameEntryRequest = {
        name: f.name.trim(),
        language: f.language.trim() || null,
        category: (f.category as NameCategory) || null,
      };
      if (f.id) {
        await this.dictionary.update(f.id, data);
      } else {
        await this.dictionary.create(data);
      }
      this.changed = true;
      this.editing.set(false);
    } finally {
      this.saving.set(false);
    }
  }

  async deleteEntry(entry: NameEntry): Promise<void> {
    if (!window.confirm(this.i18n.t('nameList.deleteAsk', { name: entry.name }))) return;
    await this.dictionary.delete(entry.id);
    this.changed = true;
  }

  async importNames(): Promise<void> {
    const text = this.importText().trim();
    if (!text || this.saving()) return;
    this.saving.set(true);
    try {
      const before = this.dictionary.entries().length;
      await this.dictionary.importNames(text);
      this.changed = this.dictionary.entries().length !== before;
      this.importText.set('');
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Seed the dictionary with the bundled zxcvbn name lists (common given
   * names + surnames, tagged `en`). Full import, deduped by name server-side.
   */
  async loadBuiltinNames(): Promise<void> {
    if (this.seedingBuiltin() || this.saving()) return;
    const entries: CreateNameEntryRequest[] = BUILTIN_NAMES.map((n) => {
      // female / male given name, or a surname — the category is all we need.
      const category: NameCategory =
        n.kind === 'surname' ? 'surname' : n.kind === 'female' ? 'female' : 'male';
      return { name: n.name, language: n.language, category };
    });
    this.seedingBuiltin.set(true);
    try {
      const before = this.dictionary.entries().length;
      await this.dictionary.importBuiltin(entries);
      this.changed = this.dictionary.entries().length !== before;
    } finally {
      this.seedingBuiltin.set(false);
    }
  }

  close(): void {
    this.dialog.submit(this.changed);
  }

  private backdropPressStarted = false;

  onBackdropMousedown(ev: MouseEvent): void {
    this.backdropPressStarted = ev.target === ev.currentTarget;
  }

  onBackdrop(ev: MouseEvent): void {
    const dismiss = ev.target === ev.currentTarget && this.backdropPressStarted;
    this.backdropPressStarted = false;
    if (dismiss) this.close();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      if (this.editing()) this.cancelEdit();
      else this.close();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      if (this.editing()) this.cancelEdit();
      else this.close();
    }
  }
}
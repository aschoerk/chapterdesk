import { Component, HostListener, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { ShortcutHelpService } from '../../core/dialogs/shortcut-help.service';

export interface ShortcutRow {
  readonly keys: string;
  readonly label: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly rows: ShortcutRow[];
}

/**
 * In-app keyboard-shortcut reference. Scrollable panel listing the documented
 * shortcuts (UX playbook §7), grouped by area: writing, navigation, search and
 * the story-tree selection. Opened from the top navigation bar and closable
 * via Esc, the Close button or a click on the backdrop.
 *
 * The rows are built from i18n keys so the panel is fully localizable (the
 * keycap glyphs are translated strings too — e.g. "Ctrl+Enter" vs
 * "Strg+Enter").
 */
@Component({
  selector: 'app-shortcut-help',
  standalone: true,
  templateUrl: './shortcut-help.component.html',
  styleUrl: './shortcut-help.component.css'
})
export class ShortcutHelpComponent {
  readonly service = inject(ShortcutHelpService);
  readonly i18n = inject(I18nService);

  /** Shortcut groups in document order, re-read on locale changes. */
  readonly groups = computed<ShortcutGroup[]>(() => {
    this.i18n.locale();
    const t = (k: string) => this.i18n.t(k);
    const row = (keys: string, label: string): ShortcutRow => ({ keys, label });
    return [
      {
        title: t('shortcuts.writing'),
        rows: [
          row(t('shortcuts.kSend'), t('shortcuts.send')),
          row(t('shortcuts.kSave'), t('shortcuts.save')),
          row(t('shortcuts.kCancel'), t('shortcuts.cancel'))
        ]
      },
      {
        title: t('shortcuts.navigation'),
        rows: [
          row(t('shortcuts.kBook'), t('shortcuts.book')),
          row(t('shortcuts.kBack'), t('shortcuts.back')),
          row(t('shortcuts.kDirections'), t('shortcuts.directions')),
          row(t('shortcuts.kTypeface'), t('shortcuts.typeface'))
        ]
      },
      {
        title: t('shortcuts.search'),
        rows: [
          row(t('shortcuts.kFind'), t('shortcuts.find')),
          row(t('shortcuts.kNext'), t('shortcuts.next'))
        ]
      },
      {
        title: t('shortcuts.tree'),
        rows: [
          row(t('shortcuts.kSelect'), t('shortcuts.select')),
          row(t('shortcuts.kCopyCut'), t('shortcuts.copyCut')),
          row(t('shortcuts.kDelete'), t('shortcuts.delete')),
          row(t('shortcuts.kPaste'), t('shortcuts.paste'))
        ]
      }
    ];
  });

  /** Esc closes the panel (document-level, like the other dialogs). */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (!this.service.open()) return;
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    this.service.close();
  }
}
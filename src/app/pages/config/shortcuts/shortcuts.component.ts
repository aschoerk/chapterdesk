import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';

export interface ShortcutRow {
  readonly keys: string;
  readonly label: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly rows: ShortcutRow[];
}

/**
 * Settings → Keyboard shortcuts: the detailed, complete key map of the app.
 *
 * The compact reference in the top navigation bar lists the essential keys;
 * this page documents every shortcut, including page zoom, the reader's page
 * navigation, paced reading and dialog/image-viewer keys. Rows are built from
 * i18n keys, so keycaps are localized too ("Ctrl+Enter" vs "Strg+Enter").
 */
@Component({
  selector: 'app-config-shortcuts',
  standalone: true,
  templateUrl: './shortcuts.component.html',
  styleUrls: ['../config-shared.css', './shortcuts.component.css']
})
export class ShortcutsComponent {
  readonly i18n = inject(I18nService);

  /** Shortcut groups in document order, re-read on locale changes. */
  readonly groups = computed<ShortcutGroup[]>(() => {
    this.i18n.locale();
    const t = (key: string) => this.i18n.t(key);
    const row = (keys: string, label: string): ShortcutRow => ({ keys, label });
    return [
      {
        title: t('shortcuts.view'),
        rows: [
          row(t('shortcuts.kZoomIn'), t('shortcuts.zoomIn')),
          row(t('shortcuts.kZoomOut'), t('shortcuts.zoomOut')),
          row(t('shortcuts.kZoomReset'), t('shortcuts.zoomReset'))
        ]
      },
      {
        title: t('shortcuts.writing'),
        rows: [
          row(t('shortcuts.kSend'), t('shortcuts.send')),
          row(t('shortcuts.kSave'), t('shortcuts.save')),
          row(t('shortcuts.kCancel'), t('shortcuts.cancel')),
          row(t('shortcuts.kMark'), t('shortcuts.mark'))
        ]
      },
      {
        title: t('shortcuts.stories'),
        rows: [
          row(t('shortcuts.kBook'), t('shortcuts.book')),
          row(t('shortcuts.kPacedReadStart'), t('shortcuts.pacedReadStart'))
        ]
      },
      {
        title: t('shortcuts.reader'),
        rows: [
          row(t('shortcuts.kTypeface'), t('shortcuts.typeface')),
          row(t('shortcuts.kDirections'), t('shortcuts.directions')),
          row(t('shortcuts.kReaderPages'), t('shortcuts.readerPages')),
          row(t('shortcuts.kReaderFirstLast'), t('shortcuts.readerFirstLast')),
          row(t('shortcuts.kBack'), t('shortcuts.back'))
        ]
      },
      {
        title: t('shortcuts.pacedRead'),
        rows: [
          row(t('shortcuts.kPacedPause'), t('shortcuts.pacedPause')),
          row(t('shortcuts.kPacedSkip'), t('shortcuts.pacedSkip')),
          row(t('shortcuts.kPacedLines'), t('shortcuts.pacedLines')),
          row(t('shortcuts.kPacedStop'), t('shortcuts.pacedStop'))
        ]
      },
      {
        title: t('shortcuts.search'),
        rows: [
          row(t('shortcuts.kFind'), t('shortcuts.find')),
          row(t('shortcuts.kNext'), t('shortcuts.next')),
          row(t('shortcuts.kCancel'), t('shortcuts.cancel'))
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
      },
      {
        title: t('shortcuts.dialogs'),
        rows: [
          row(t('shortcuts.kDialogClose'), t('shortcuts.dialogClose')),
          row(t('shortcuts.kDialogConfirm'), t('shortcuts.dialogConfirm')),
          row(t('shortcuts.kImages'), t('shortcuts.images'))
        ]
      }
    ];
  });
}

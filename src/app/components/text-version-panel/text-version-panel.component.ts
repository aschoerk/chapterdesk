import {
  Component,
  EventEmitter,
  Output,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { NodeVersionDiffDialogService } from '../../core/dialogs/node-version-diff-dialog.service';
import { TextVersionApiService } from '../../core/texts/text-version-api.service';
import type {
  TextVersion,
  TextVersionAttribute,
  TextVersionEntityType,
} from '../../models/text-version';

/** One tracked text field of an entity, with a human-readable label. */
export interface VersionedAttributeDef {
  attribute: TextVersionAttribute;
  label: string;
}

/**
 * Collapsible "version history" panel for a versioned general text
 * (topic system prompt, environment definition/greeting, persona description).
 *
 * Lists recorded versions (newest first) for the selected attribute and lets
 * the user COMPARE a version against the current value (in the shared Monaco
 * diff dialog) and RESTORE it. When a version is restored, this panel emits
 * `restored` with the now-active value so the parent editor can update its
 * form / saved entity and refresh.
 */
@Component({
  selector: 'app-text-version-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './text-version-panel.component.html',
  styleUrl: './text-version-panel.component.css',
})
export class TextVersionPanelComponent {
  private readonly i18n = inject(I18nService);
  private readonly api = inject(TextVersionApiService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly diff = inject(NodeVersionDiffDialogService);

  readonly entityType = input<TextVersionEntityType>('topic');
  readonly entityId = input<string | null>(null);
  readonly attributes = input<VersionedAttributeDef[]>([]);
  /** Currently saved text per tracked attribute (for comparison), values can be null. */
  readonly currentValues = input<Partial<Record<TextVersionAttribute, string | null>>>({});

  /** Fired after a successful restore with the now-active value. */
  @Output() restored = new EventEmitter<{
    attribute: TextVersionAttribute;
    value: string;
  }>();

  readonly open = signal(false);
  readonly selected = signal<TextVersionAttribute | null>(null);
  readonly versions = signal<TextVersion[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  readonly activeAttribute = computed<{ attribute: TextVersionAttribute; label: string } | null>(
    () => {
      const sel = this.selected();
      return (
        this.attributes().find((a) => a.attribute === sel) ?? this.attributes()[0] ?? null
      );
    },
  );

  constructor() {
    effect(() => {
      const entityId = this.entityId();
      const entityType = this.entityType();
      const attribute = this.activeAttribute()?.attribute;
      if (!entityId || !entityType || !attribute) {
        this.versions.set([]);
        this.loadError.set(null);
        return;
      }
      void this.load(entityType, entityId, attribute);
    });
  }

  private async load(
    entityType: TextVersionEntityType,
    entityId: string,
    attribute: TextVersionAttribute,
  ): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.versions.set(await this.api.getTextVersions(entityType, entityId, attribute));
    } catch {
      this.versions.set([]);
      this.loadError.set(this.i18n.t('textVersions.loadFailed'));
    } finally {
      this.loading.set(false);
    }
  }

  selectAttribute(attribute: TextVersionAttribute): void {
    this.selected.set(attribute);
  }

  toggle(): void {
    this.open.set(!this.open());
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

  preview(text: string): string {
    const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? '';
    return firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine;
  }

  /** Saved text of the active attribute (empty when unknown). */
  currentText(): string {
    const attribute = this.activeAttribute()?.attribute;
    if (!attribute) return '';
    return this.currentValues()[attribute] ?? '';
  }

  /**
   * Compare a recorded version with the current text in the shared Monaco
   * diff dialog (both sides read-only). All recorded versions are offered in
   * the dialog's dropdown, the clicked one preselected.
   */
  compare(version: TextVersion): void {
    const attribute = this.activeAttribute();
    const entries = this.versions().map((v) => ({
      id: v.id,
      label: `${this.i18n.t('textVersions.historical', { version: v.versionNumber })} · ${this.formatDate(v.datetime)}`,
      text: v.oldContent,
    }));
    void this.diff.open({
      title: this.i18n.t('textVersions.compareTitle', { attribute: attribute?.label ?? '' }),
      newText: this.currentText(),
      originalLabel: this.i18n.t('textVersions.historical', { version: version.versionNumber }),
      modifiedLabel: this.i18n.t('textVersions.current'),
      texts: entries,
      initialId: version.id,
      readOnly: true,
    });
  }

  async restore(version: TextVersion): Promise<void> {
    const attribute = this.activeAttribute()?.attribute;
    if (!attribute) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('textVersions.restoreTitle'),
      message: this.i18n.t('textVersions.restoreMessage', { version: version.versionNumber }),
      confirmLabel: this.i18n.t('textVersions.restore'),
    });
    if (!ok || !this.entityId()) return;
    this.busyId.set(version.id);
    try {
      const result = await this.api.restoreTextVersion(version.id);
      this.toast.success(
        this.i18n.t('textVersions.restored', { version: version.versionNumber }),
      );
      this.restored.emit({ attribute: result.entityAttribute, value: result.value });
      await this.load(result.entityType, result.entityId, result.entityAttribute);
    } catch {
      this.toast.error(this.i18n.t('textVersions.restoreFailed'));
    } finally {
      this.busyId.set(null);
    }
  }

  async remove(version: TextVersion): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('textVersions.deleteTitle'),
      message: this.i18n.t('textVersions.deleteMessage', { version: version.versionNumber }),
      confirmLabel: this.i18n.t('common.delete'),
    });
    if (!ok) return;
    this.busyId.set(version.id);
    try {
      await this.api.deleteTextVersion(version.id);
      this.toast.success(this.i18n.t('textVersions.deleted'));
      this.versions.set(this.versions().filter((v) => v.id !== version.id));
    } catch {
      this.toast.error(this.i18n.t('textVersions.deleteFailed'));
    } finally {
      this.busyId.set(null);
    }
  }

  protected readonly t = (key: string, params?: Record<string, string | number>): string =>
    this.i18n.t(key, params);
}
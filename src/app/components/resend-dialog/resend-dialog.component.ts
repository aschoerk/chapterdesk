import { Component, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { ResendDialogService } from '../../core/dialogs/resend-dialog.service';
import { ResendMessage } from '../../core/llm/llm-log-resend.service';
import { ModelEntry } from '../../models/chat-config';

@Component({
  selector: 'app-resend-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './resend-dialog.component.html',
  styleUrl: './resend-dialog.component.css'
})
export class ResendDialogComponent {
  readonly dialog = inject(ResendDialogService);
  readonly i18n = inject(I18nService);

  /** The editable messages (seeded from the log entry on open). */
  readonly messages = signal<ResendMessage[]>([]);
  /** Enabled models the user can re-send with. */
  readonly models = signal<ModelEntry[]>([]);
  /** Selected model id ('' = use the original call's model). */
  readonly modelId = signal('');

  constructor() {
    effect(() => {
      const d = this.dialog.current();
      if (!d) return;
      // Keep messages lean: only carry `parts` when the original request
      // actually had non-text parts to preserve.
      this.messages.set((d.messages ?? []).map(m =>
        (m.parts?.length ? { ...m, parts: [...m.parts] } : { role: m.role, text: m.text })
      ));
      this.models.set(d.models ?? []);
      this.modelId.set(d.modelId ?? '');
    });
  }

  /** Update one message's text while typing. */
  onTextChange(index: number, value: string): void {
    this.messages.update(list => list.map((m, i) => (i === index ? { ...m, text: value } : m)));
  }

  /** Keep the selected model id in sync with the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
  }

  /** Number of non-text parts (media/files) preserved on a message. */
  preservedCount(m: ResendMessage): number {
    return m.parts?.length ?? 0;
  }

  /** True when any message still carries preserved media/file parts. */
  hasPreservedParts(): boolean {
    return this.messages().some(m => this.preservedCount(m) > 0);
  }

  /** Sum of preserved parts across all messages (for the hint). */
  preservedTotal(): number {
    return this.messages().reduce((sum, m) => sum + this.preservedCount(m), 0);
  }

  submit(): void {
    const d = this.dialog.current();
    if (!d) return;
    this.dialog.submit({ messages: this.messages(), modelId: this.modelId() });
  }

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

  /** Escape cancels the dialog (document-level, so it works with focus inside). */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.dialog.cancel();
    }
  }
}

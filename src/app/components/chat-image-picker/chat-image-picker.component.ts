import { Component, HostListener, effect, inject, signal } from '@angular/core';
import { ChatImagePickerService } from '../../core/dialogs/chat-image-picker.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodeAttachment } from '../../models/chat';

@Component({
  selector: 'app-chat-image-picker',
  standalone: true,
  templateUrl: './chat-image-picker.component.html',
  styleUrl: './chat-image-picker.component.css'
})
export class ChatImagePickerComponent {
  readonly picker = inject(ChatImagePickerService);
  readonly i18n = inject(I18nService);

  /** Attachments currently marked for adding. Reset on every open. */
  readonly selected = signal<NodeAttachment[]>([]);

  constructor() {
    effect(() => {
      if (this.picker.current()) this.selected.set([]);
    });
  }

  isSelected(id: string): boolean {
    return this.selected().some(a => a.id === id);
  }

  toggle(a: NodeAttachment): void {
    this.selected.update(list =>
      list.some(x => x.id === a.id)
        ? list.filter(x => x.id !== a.id)
        : [...list, a]
    );
  }

  submit(): void {
    this.picker.submit(this.selected());
  }

  /** True when the current click interaction started with a pointer press
   *  on the backdrop itself. A backdrop click only dismisses the dialog
   *  when the press also started on the backdrop. */
  private backdropPressStarted = false;

  onBackdropMousedown(ev: MouseEvent): void {
    this.backdropPressStarted = ev.target === ev.currentTarget;
  }

  onBackdrop(ev: MouseEvent): void {
    const dismiss = ev.target === ev.currentTarget && this.backdropPressStarted;
    this.backdropPressStarted = false;
    if (dismiss) this.picker.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.picker.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.picker.current()) {
      ev.preventDefault();
      this.picker.cancel();
    }
  }
}
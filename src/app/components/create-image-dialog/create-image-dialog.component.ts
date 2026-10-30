import { Component, computed, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings/settings.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { CreateImageDialogService } from '../../core/dialogs/create-image-dialog.service';
import { ChatImagePickerService } from '../../core/dialogs/chat-image-picker.service';
import { ChatImagesService } from '../../core/chat/chat-images.service';
import { canGenerateImages, canInterpretImages, ModelEntry } from '../../models/chat-config';
import { NodeAttachment } from '../../models/chat';
import { newId } from '../../core/util/helpers';
import { inferMimeType } from '../../core/llm/llm-message';

@Component({
  selector: 'app-create-image-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './create-image-dialog.component.html',
  styleUrl: './create-image-dialog.component.css'
})
export class CreateImageDialogComponent {
  readonly dialog = inject(CreateImageDialogService);
  readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly chatImages = inject(ChatImagesService);
  private readonly imagePicker = inject(ChatImagePickerService);

  /** Chat-specific constant — per-chat, always pre-filled (editable). */
  readonly constant = signal('');
  /** The marked text (editable); combined with the constant it creates the image. */
  readonly script = signal('');
  /** Reference images attached in the dialog — sent occasionally, as references. */
  readonly images = signal<NodeAttachment[]>([]);
  readonly modelId = signal('');
  readonly providerId = signal('');

  /**
   * Models the user can render with: every enabled image-capable model, plus
   * the configured "image-create" task model when it is not among them (so a
   * task model that lacks an image-modality declaration still shows up).
   *
   * While reference images are attached, ONLY models that also accept IMAGE
   * INPUT are offered — a text-only-input image model cannot see the attached
   * reference images, so it would silently drop them.
   */
  readonly imageModels = computed<ModelEntry[]>(() => {
    const hasImages = this.images().length > 0;
    const enabled = this.settings.enabledModels()
      .filter(canGenerateImages)
      .filter(m => !hasImages || canInterpretImages(m));
    const task = this.generation.modelFor('image-create');
    const taskUsable = !!task && (!hasImages || canInterpretImages(task));
    if (taskUsable && !enabled.some(m => m.providerId === task.providerId && m.modelId === task.modelId)) {
      return [task, ...enabled];
    }
    return enabled;
  });

  constructor() {
    // Seed the editable fields when the dialog opens. The model selection is
    // reset here so the resolution effect below re-seeds it for THIS open
    // (it must not keep a stale selection from a previous dialog use).
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      this.constant.set(s.constant);
      this.script.set(s.script);
      this.images.set(s.images ?? []);
      this.modelId.set('');
      this.providerId.set('');
    });

    // Resolve the model selection. Re-runs when the dialog opens OR when the
    // attached reference images change: a model that cannot accept image input
    // must not stay selected once images are attached. A currently selected
    // model that is still valid (and, with images attached, still accepts
    // image input) is kept — so the user's manual choice survives an image
    // being added afterwards.
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      const available = this.imageModels();
      const matchFor = (modelId: string | undefined) =>
        available.find(m => m.modelId === modelId || m.id === modelId);
      const currentMatch = matchFor(this.modelId());
      if (currentMatch) {
        // The provider is re-derived from the CURRENT model entry, so a stale
        // remembered providerId can never silently drop the chosen model later.
        this.providerId.set(currentMatch.providerId);
        return;
      }
      // The remembered model (from the last dialog use) is pre-selected; when
      // it is no longer enabled, fall back to the caller-provided default
      // (settings task model) — also skipping it when that is unavailable.
      const rememberedMatch = matchFor(s.modelId);
      if (rememberedMatch) {
        this.modelId.set(rememberedMatch.modelId);
        this.providerId.set(rememberedMatch.providerId);
        return;
      }
      const fallbackMatch = matchFor(s.defaultModelId);
      if (fallbackMatch) {
        this.modelId.set(fallbackMatch.modelId);
        this.providerId.set(fallbackMatch.providerId);
        return;
      }
      // Reference images are attached and neither the remembered nor the
      // default model can accept them — pick the first image-input-capable
      // model so the selection stays valid.
      if (this.images().length > 0 && available.length > 0) {
        this.modelId.set(available[0].modelId);
        this.providerId.set(available[0].providerId);
        return;
      }
      this.modelId.set('');
      this.providerId.set('');
    });
  }

  /** Keep the provider in sync with the model chosen in the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
    const match = this.imageModels().find(m => m.modelId === modelId || m.id === modelId);
    this.providerId.set(match?.providerId ?? '');
  }

  /** Add the chosen image files as reference attachments. */
  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input?.files;
    if (!files || files.length === 0) return;
    const additions: NodeAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        this.images.update(list => [
          ...list,
          {
            id: newId(),
            name: file.name,
            mimeType: file.type || inferMimeType(file.name),
            size: file.size,
            dataUrl
          }
        ]);
      };
      reader.readAsDataURL(file);
    }
    input.value = '';
  }

  removeImage(id: string): void {
    this.images.update(list => list.filter(a => a.id !== id));
  }

  /** Add images found in the current chat as reference images. */
  async addFromChat(): Promise<void> {
    const entries = this.chatImages.imagesInCurrentChat();
    if (entries.length === 0) {
      alert(this.i18n.t('createImageDialog.noChatImages'));
      return;
    }
    const picked = await this.imagePicker.open(entries);
    if (!picked || picked.length === 0) return;
    // Reuse the existing ids so an already-added chat image is not duplicated.
    this.images.update(list => {
      const existing = new Set(list.map(a => a.id));
      const additions = picked.filter(a => !existing.has(a.id));
      return [...list, ...additions];
    });
  }

  /** The combined text (constant + script) that creates the image. */
  combinedPrompt(): string {
    return [this.constant().trim(), this.script().trim()]
      .filter(Boolean)
      .join('\n\n');
  }

  submit(): void {
    // Text is the primary image-creating input; reference images alone also
    // work (e.g. "make a variant of this picture").
    if (!this.combinedPrompt() && this.images().length === 0) {
      alert(this.i18n.t('createImageDialog.empty'));
      return;
    }
    this.dialog.submit({
      constant: this.constant(),
      script: this.script(),
      images: this.images(),
      modelId: this.modelId(),
      providerId: this.providerId()
    });
  }

  /** True when the current click interaction started with a pointer press
   *  on the backdrop itself. A backdrop click only dismisses the dialog
   *  when the press also started on the backdrop — otherwise a text-
   *  selection drag that began inside a field and ended on the backdrop
   *  would close the dialog while marking input content to overwrite. */
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

  /**
   * Escape cancels the dialog. Handled at document level so it works even
   * when focus is outside the dialog (the backdrop only catches keys once
   * an inner control has focus). Guarded by the open state, so it never
   * interferes while the dialog is closed.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.dialog.cancel();
    }
  }
}
import { Component, computed, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { IllustrateDialogService } from '../../core/dialogs/illustrate-dialog.service';
import { ChatImagePickerService } from '../../core/dialogs/chat-image-picker.service';
import { ChatImagesService } from '../../core/chat/chat-images.service';
import { SettingsService } from '../../core/settings/settings.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { canGenerateImages, canInterpretImages, ModelEntry } from '../../models/chat-config';
import { NodeAttachment } from '../../models/chat';
import { newId } from '../../core/util/helpers';
import { inferMimeType } from '../../core/llm/llm-message';
import {
  clampHistoryNodes,
  ILLUSTRATE_COUNT_MIN,
  ILLUSTRATE_HISTORY_NODES_DEFAULT,
  ILLUSTRATE_HISTORY_NODES_MIN,
  ILLUSTRATE_HISTORY_NODES_MAX,
  IllustrateHistoryMode,
  IllustrateUsecase,
  isIllustrateHistoryMode,
  isIllustrateUsecase
} from '../../models/illustrate-options';

@Component({
  selector: 'app-illustrate-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './illustrate-dialog.component.html',
  styleUrl: './illustrate-dialog.component.css'
})
export class IllustrateDialogComponent {
  readonly dialog = inject(IllustrateDialogService);
  readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  private readonly chatImages = inject(ChatImagesService);
  private readonly imagePicker = inject(ChatImagePickerService);

  readonly count = signal(1);
  readonly style = signal('');
  readonly storyboardPrompt = signal('');
  /**
   * Reference images attached in the dialog (uploaded files or images picked
   * from the current chat). Forwarded to the image model so it can keep
   * characters / setting / style consistent with existing pictures.
   */
  readonly images = signal<NodeAttachment[]>([]);
  /**
   * The scene to depict. Pre-filled with the MARKED part of the node content
   * when the user selected one before opening the dialog; editable. When left
   * empty the whole node content is used as the scene (the classic behavior).
   */
  readonly sceneText = signal('');
  readonly modelId = signal('');
  readonly providerId = signal('');
  readonly historyMode = signal<IllustrateHistoryMode>('single');
  readonly historyNodes = signal(ILLUSTRATE_HISTORY_NODES_DEFAULT);
  readonly storyboardHistoryNodes = signal(ILLUSTRATE_HISTORY_NODES_DEFAULT);
  /**
   * The illustration approach — 'planned' (text model describes first),
   * 'direct' (story text straight to the image model), or 'pure' (only derived
   * descriptions reach the image model). Drives `purePictures` and
   * `planDescriptions` on submit.
   */
  readonly usecase = signal<IllustrateUsecase>('planned');
  /**
   * The window width currently being edited — the storyboard width when
   * count > 1, else the single-picture width. Remembered separately so each
   * use case (single picture vs storyboard) can span a different number of
   * beats.
   */
  readonly activeHistoryNodes = computed(() =>
    this.count() > 1 ? this.storyboardHistoryNodes() : this.historyNodes());

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

  /**
   * Display name of the configured "image-create" default model (fallback:
   * first enabled image-capable model), shown next to the "Default (from
   * settings)" option so the user sees WHICH model the default is.
   */
  readonly defaultModelName = computed<string>(() => {
    return this.imageModels()[0]?.displayName ?? '';
  });

  /**
   * True when the "Default (from settings)" option is offered. It is hidden
   * while reference images are attached AND the configured image-create task
   * model cannot accept image input — selecting it would silently drop the
   * attached images.
   */
  readonly showDefaultOption = computed(() => {
    if (this.images().length === 0) return true;
    const task = this.generation.modelFor('image-create');
    return !!task && canInterpretImages(task);
  });

  constructor() {
    // Seed the editable fields when the dialog opens. The model selection is
    // reset here so the resolution effect below re-seeds it for THIS open
    // (it must not keep a stale selection from a previous dialog use).
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      this.count.set(s.count);
      this.style.set(s.style);
      this.storyboardPrompt.set(s.storyboardPrompt);
      this.sceneText.set(s.sceneText ?? '');
      this.images.set(s.attachments ?? []);
      this.historyMode.set(s.historyMode);
      this.historyNodes.set(s.historyNodes);
      this.storyboardHistoryNodes.set(s.storyboardHistoryNodes);
      this.usecase.set(s.purePictures ? 'pure' : (s.planDescriptions === false ? 'direct' : 'planned'));
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
        this.providerId.set(currentMatch.providerId);
        return;
      }
      // A remembered model that is no longer selectable (provider disabled /
      // model removed from the catalog, or — with reference images attached —
      // a model that cannot accept image input) falls back to the settings
      // default, or the first selectable model when that is also unavailable.
      const rememberedMatch = matchFor(s.modelId);
      if (rememberedMatch) {
        this.modelId.set(rememberedMatch.modelId);
        this.providerId.set(rememberedMatch.providerId);
        return;
      }
      if (this.images().length > 0 && available.length > 0) {
        // Reference images are attached and the remembered model cannot accept
        // them — pick the first image-input-capable model so the selection
        // stays valid.
        this.modelId.set(available[0].modelId);
        this.providerId.set(available[0].providerId);
        return;
      }
      // No remembered model (or it was removed) → the "Default (from settings)"
      // empty selection is used.
      this.modelId.set('');
      this.providerId.set('');
    });
  }

  onCountInput(value: string): void {
    const n = Number(value);
    if (Number.isFinite(n) && n >= ILLUSTRATE_COUNT_MIN) {
      this.count.set(Math.floor(n));
    }
  }

  /** Keep the provider in sync with the model chosen in the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
    const match = this.imageModels().find(
      m => m.modelId === modelId || m.id === modelId
    );
    this.providerId.set(match?.providerId ?? '');
  }

  /** Window width input for the "last N beats" context choice — edits the
   *  width of the CURRENT use case (single picture vs storyboard). */
  onHistoryNodesInput(value: string): void {
    const n = Number(value);
    if (Number.isFinite(n) && n >= ILLUSTRATE_HISTORY_NODES_MIN) {
      const clamped = clampHistoryNodes(n);
      if (this.count() > 1) {
        this.storyboardHistoryNodes.set(clamped);
      } else {
        this.historyNodes.set(clamped);
      }
    }
  }

  /** The context source: current text only, the last N beats (window), or all story text. */
  onHistoryMode(value: string): void {
    this.historyMode.set(isIllustrateHistoryMode(value) ? value : 'single');
  }

  /** The illustration approach: planned / direct / pure. */
  onUsecaseChange(value: string): void {
    this.usecase.set(isIllustrateUsecase(value) ? value : 'planned');
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
      alert(this.i18n.t('illustrateDialog.noChatImages'));
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

  submit(): void {
    const usecase = this.usecase();
    this.dialog.submit({
      // The marked part of the node (editable); empty = the whole node
      // content becomes the scene.
      sceneText: this.sceneText(),
      count: this.count(),
      style: this.style(),
      storyboardPrompt: this.storyboardPrompt(),
      // Pure picture mode never forwards the raw chat itself — the planning
      // (text) model derives the picture descriptions. The context mode still
      // applies: it bounds what the planning model sees (current beat vs last
      // N beats vs the complete chat).
      purePictures: usecase === 'pure',
      modelId: this.modelId(),
      providerId: this.providerId(),
      historyMode: this.historyMode(),
      historyNodes: this.historyNodes(),
      storyboardHistoryNodes: this.storyboardHistoryNodes(),
      // 'planned' and 'pure' both run the planning pass; 'direct' skips it.
      // Pure picture mode REQUIRES the derived descriptions — raw story prose
      // must never reach the image model — so planning is forced back on.
      planDescriptions: usecase === 'planned' || usecase === 'pure',
      // Reference images (uploaded files or chat images) the user attached.
      attachments: this.images()
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
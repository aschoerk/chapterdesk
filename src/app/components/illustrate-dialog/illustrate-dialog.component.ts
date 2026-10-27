import { Component, computed, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { IllustrateDialogService } from '../../core/dialogs/illustrate-dialog.service';
import { SettingsService } from '../../core/settings/settings.service';
import { GenerationSettingsService } from '../../core/settings/generation-settings.service';
import { canGenerateImages, ModelEntry } from '../../models/chat-config';
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

  readonly count = signal(1);
  readonly style = signal('');
  readonly storyboardPrompt = signal('');
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
   */
  readonly imageModels = computed<ModelEntry[]>(() => {
    const enabled = this.settings.enabledModels().filter(canGenerateImages);
    const task = this.generation.modelFor('image-create');
    if (task && !enabled.some(m => m.providerId === task.providerId && m.modelId === task.modelId)) {
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

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      // Seed the editor from the options the dialog was opened with.
      this.count.set(s.count);
      this.style.set(s.style);
      this.storyboardPrompt.set(s.storyboardPrompt);
      this.sceneText.set(s.sceneText ?? '');
      this.modelId.set(s.modelId);
      this.providerId.set(s.providerId);
      this.historyMode.set(s.historyMode);
      this.historyNodes.set(s.historyNodes);
      this.storyboardHistoryNodes.set(s.storyboardHistoryNodes);
      this.usecase.set(s.purePictures ? 'pure' : (s.planDescriptions === false ? 'direct' : 'planned'));
      // A remembered model that is no longer selectable (provider disabled /
      // model removed from the catalog) falls back to the settings default.
      if (s.modelId && !this.imageModels().some(m => m.modelId === s.modelId || m.id === s.modelId)) {
        this.modelId.set('');
        this.providerId.set('');
      }
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
      planDescriptions: usecase === 'planned' || usecase === 'pure'
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
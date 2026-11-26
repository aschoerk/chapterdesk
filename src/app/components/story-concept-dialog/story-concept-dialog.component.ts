import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings/settings.service';
import { PersonaService } from '../../core/persona.service';
import {
  StoryConceptDialogService,
  type StoryConceptPersona,
} from '../../core/dialogs/story-concept-dialog.service';
import { ModelSelectComponent } from '../model-select/model-select.component';
import { AvatarViewComponent } from '../avatar-view/avatar-view.component';

/**
 * "Design a story concept" dialog — turns a free-form idea into a story concept
 * that ENDS in a chapter description list. The list is generated as a new
 * branch (the previous visible chat content is the context) and later
 * elaborated chapter by chapter.
 *
 * Optional inputs: personas to include as characters, the number of chapters
 * (empty = let the model decide) and the target length of the finished story
 * in words. The last inputs are remembered per chat.
 */
@Component({
  selector: 'app-story-concept-dialog',
  standalone: true,
  imports: [FormsModule, ModelSelectComponent, AvatarViewComponent],
  templateUrl: './story-concept-dialog.component.html',
  styleUrl: './story-concept-dialog.component.css',
})
export class StoryConceptDialogComponent {
  readonly dialog = inject(StoryConceptDialogService);
  readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);
  private readonly personaService = inject(PersonaService);

  /** Free-form story idea the concept should be designed from. */
  readonly prompt = signal('');
  /** Ids of the personas that must appear as characters. */
  readonly selectedPersonaIds = signal<string[]>([]);
  /** Number of chapters to plan; `null` = let the model decide. */
  readonly chapterCount = signal<number | null>(null);
  /** Target length of the finished story in words; `null` = no target. */
  readonly targetWords = signal<number | null>(null);
  /** Selected writing model (default: the current model). */
  readonly modelId = signal('');
  readonly providerId = signal('');

  readonly enabledModels = computed(() => this.settings.enabledModels());
  readonly personas = this.personaService.personas;
  readonly selectedCount = computed(() => this.selectedPersonaIds().length);

  constructor() {
    // Personas are loaded at app start; this is the fallback when the dialog
    // is opened before that (and in isolated tests).
    void this.personaService.loadPersonas();

    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      // Seed from the remembered inputs (prefilled by the service).
      this.prompt.set(s.prompt);
      this.selectedPersonaIds.set([...s.personaIds]);
      this.chapterCount.set(s.chapterCount);
      this.targetWords.set(s.targetWords);
      this.modelId.set(s.modelId);
      this.providerId.set(s.providerId);
    });
  }

  /** Keep the provider in sync with the model chosen in the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
    const match = this.enabledModels().find(m => m.modelId === modelId || m.id === modelId);
    this.providerId.set(match?.providerId ?? '');
  }

  /** `''` / 0 / invalid → `null` ("not set"); otherwise a positive integer. */
  optionalNumber(value: unknown): number | null {
    const v = Math.floor(Number(value));
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  isPersonaSelected(id: string): boolean {
    return this.selectedPersonaIds().includes(id);
  }

  togglePersona(id: string): void {
    const current = this.selectedPersonaIds();
    this.selectedPersonaIds.set(
      current.includes(id) ? current.filter(x => x !== id) : [...current, id],
    );
  }

  /** The selected personas resolved to the fields the prompt needs. */
  private resolvePersonas(): StoryConceptPersona[] {
    const selected = this.selectedPersonaIds();
    return this.personas()
      .filter(p => selected.includes(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        shortName: p.shortName,
        description: p.description ?? '',
      }));
  }

  submit(): void {
    if (!this.modelId()) {
      alert(this.i18n.t('storyConceptDialog.modelMissing'));
      return;
    }
    this.dialog.submit({
      prompt: this.prompt().trim(),
      personaIds: this.selectedPersonaIds(),
      personas: this.resolvePersonas(),
      chapterCount: this.optionalNumber(this.chapterCount()),
      targetWords: this.optionalNumber(this.targetWords()),
      modelId: this.modelId(),
      providerId: this.providerId(),
    });
  }

  /** True when the current click started on the backdrop itself — a drag that
   *  began inside a field and ended on the backdrop must not close the dialog. */
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
   * Escape cancels the dialog. Handled at document level so it works even when
   * focus is outside the dialog (the backdrop only catches keys once an inner
   * control has focus). Guarded by the open state.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.dialog.cancel();
    }
  }
}

import { Injectable, inject } from '@angular/core';
import { GenerationSettingsService } from '../../../settings/generation-settings.service';
import { PromptDefaultsService } from '../../../prompts/prompt-defaults.service';
import type { UsecaseVars } from '../types';
import { ContextTopicService } from './topic';

/**
 * PROMPT-TEMPLATE building for a use case: every instruction and prompt a
 * request is headed with (drawing / structure / language / rewrite /
 * storyboard / pure-picture / per-scene). Pure string building from the
 * editable prompt-defaults + the generation-task overrides + the current
 * prompt-topic scope — no model resolution (that is `models.ts`) and no
 * chat-thread messages (that is `messages.ts`).
 */
@Injectable({ providedIn: 'root' })
export class ContextPromptBuilderService {
  private readonly generation = inject(GenerationSettingsService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly topicService = inject(ContextTopicService);

  /** The task prompt (or its built-in default) for the image-create task. */
  drawingInstruction(): string {
    return this.generation.get('image-create').prompt.trim()
      || this.promptDefaults.effective('image.create', this.topicService.promptTopic);
  }

  /** Style-wrapped drawing instruction. */
  styledDrawingInstruction(style: string | undefined): string {
    const base = this.drawingInstruction();
    return style && style.trim()
      ? `${base}\n\nStyle: ${style.trim()}`
      : base;
  }

  /**
   * Instruction for a structure-generation task (`structure.title` /
   * `structure.overview` / `structure.headings`): the per-task prompt override
   * when configured, else the editable prompt default.
   */
  structureInstruction(task: 'title' | 'overview' | 'headings'): string {
    const prompt = this.generation.get(task).prompt.trim();
    if (prompt) return prompt;
    if (task === 'title') return this.promptDefaults.effective('structure.title', this.topicService.promptTopic);
    if (task === 'overview') return this.promptDefaults.effective('structure.overview', this.topicService.promptTopic);
    return this.promptDefaults.effective('structure.headings', this.topicService.promptTopic);
  }

  /** The language-check instruction (config override or built-in default). */
  englishCheckInstruction(): string {
    const prompt = this.generation.get('language-check').prompt.trim();
    return prompt || this.promptDefaults.effective('language.check', this.topicService.promptTopic);
  }

  /**
   * Instruction for the chapter-description-list task (editable prompt
   * default). The concrete parameters (chapter count, sentences per
   * description, first chapter number, goal) are appended by the flow as
   * structured lines.
   */
  chapterDescriptionsInstruction(): string {
    return this.promptDefaults.effective('structure.chapterDescriptions', this.topicService.promptTopic);
  }

  /** The rewrite-selection instruction (editable prompt default). */
  rewriteInstruction(): string {
    return this.promptDefaults.effective('language.rewrite', this.topicService.promptTopic);
  }

  /**
   * The story scope the pictures should cover, as a short instruction for the
   * PLANNING (text) model — so it knows exactly how many beats it derives
   * pictures for. This matters most in pure picture mode, where the derived
   * descriptions ARE everything the image model sees:
   * - 'window': the last `historyNodes` beats up to and including the current
   *   one (the model must cover exactly those beats, not the whole story).
   * - otherwise ('single' / 'full'): the current beat, with the COMPLETE story
   *   text up to it as the established context.
   */
  illustrationScopeText(historyMode?: UsecaseVars['historyMode'], historyNodes?: number): string {
    if (historyMode === 'window' && historyNodes && historyNodes > 1) {
      return `Generate the picture(s) for the last ${historyNodes} story beats up to and including the current one — cover only those ${historyNodes} beats, do not reach back into the story before them.`;
    }
    return 'Generate the picture for the current beat. The full story text up to this beat is the established context — use it as context, but depict the current beat.';
  }

  /** The planner instruction (from the image.planning template). */
  picturePlanningInstruction(total: number, extra?: string, scope?: string): string {
    let base = this.promptDefaults.render('image.planning', { total }, this.topicService.promptTopic);
    if (scope?.trim()) base += `\n\n${scope.trim()}`;
    return extra?.trim() ? `${base}\n\nRules that apply to every picture:\n${extra.trim()}` : base;
  }

  /**
   * The SCENE-oriented planner instruction (from the image.planning-scenes
   * template). Used by `planned-scenes` as its planning prefix: it derives
   * fewer static stills and more alive, action-bearing scenes.
   */
  pictureScenePlanningInstruction(total: number, extra?: string, scope?: string): string {
    let base = this.promptDefaults.render('image.planning-scenes', { total }, this.topicService.promptTopic);
    if (scope?.trim()) base += `\n\n${scope.trim()}`;
    return extra?.trim() ? `${base}\n\nRules that apply to every picture:\n${extra.trim()}` : base;
  }

  /** The one-shot storyboard prompt (from the image.one-shot template). */
  oneShotStoryboardPrompt(basePrompt: string, descriptions: string[], total: number, extra?: string): string {
    let text = basePrompt ? `${basePrompt}\n\n` : '';
    text += this.promptDefaults.render('image.one-shot', { total }, this.topicService.promptTopic);
    if (descriptions.length > 0) {
      text += `\n\nThe exact scenes to render (one image per scene, in this order):\n`;
      descriptions.forEach((p, i) => { text += `${i + 1}. ${p}\n`; });
    }
    if (extra?.trim()) text += `\n\nAdditional storyboard rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /**
   * The SCENE-oriented one-shot storyboard prompt (from the
   * image.one-shot-scenes template). Used by `planned-scenes` as its render
   * template: the derived scenes are action-bearing, so the en-block request
   * tells the model to capture each scene's action rather than flattening it
   * into a frozen, static photograph.
   */
  oneShotScenesPrompt(basePrompt: string, descriptions: string[], total: number, extra?: string): string {
    let text = basePrompt ? `${basePrompt}\n\n` : '';
    text += this.promptDefaults.render('image.one-shot-scenes', { total }, this.topicService.promptTopic);
    if (descriptions.length > 0) {
      text += `\n\nThe exact scenes to render (one image per scene, in this order):\n`;
      descriptions.forEach((p, i) => { text += `${i + 1}. ${p}\n`; });
    }
    if (extra?.trim()) text += `\n\nAdditional storyboard rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /** The pure-picture en-block prompt (from the image.pure template). */
  purePicturesPrompt(sceneInstruction: string, descriptions: string[], total: number, extra?: string): string {
    let text = sceneInstruction ? `${sceneInstruction}\n\n` : '';
    const numbered = descriptions
      .map((d, i) => `${i + 1}. ${d.trim()}`)
      .join('\n') + (descriptions.length ? '\n' : '');
    text += this.promptDefaults.render('image.pure', { total, descriptions: numbered }, this.topicService.promptTopic);
    if (extra?.trim()) text += `\n\nAdditional rules for every picture:\n${extra.trim()}`;
    return text;
  }

  /** Per-scene storyboard instruction (from the image.storyboard template). */
  storyboardInstruction(index: number, total: number, extra?: string): string {
    const base = this.promptDefaults.render('image.storyboard', { index: index + 1, total }, this.topicService.promptTopic);
    return extra?.trim() ? `${base}\n\nRules for every picture:\n${extra.trim()}` : base;
  }
}
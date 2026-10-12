import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PromptDefaultsService } from '../../../core/prompt-defaults.service';
import { PROMPT_DEFAULT_CATEGORIES } from '../../../models/prompt-default';
import type {
  PromptDefaultCategory,
  PromptDefaultDef,
  PromptVar
} from '../../../models/prompt-default';

/** English-only heading (per project decision — prompts stay in English). */
const CATEGORY_TITLES: Record<PromptDefaultCategory, { title: string; hint: string }> = {
  structure: {
    title: 'Structure & writing',
    hint: 'Prompts for titles, introductions, headings and chapter elaboration.'
  },
  image: {
    title: 'Image generation',
    hint: 'Prompts for the picture-description planning pass and every image-generation mode.'
  },
  language: {
    title: 'Language',
    hint: 'Prompts for the grammar / language check of writing directions.'
  }
};

@Component({
  selector: 'app-config-prompts',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './prompts.component.html',
  styleUrls: ['../config-shared.css', './prompts.component.css']
})
export class PromptsComponent {
  private readonly defaults = inject(PromptDefaultsService);

  readonly categories = PROMPT_DEFAULT_CATEGORIES;

  categoryMeta(category: PromptDefaultCategory): { title: string; hint: string } {
    return CATEGORY_TITLES[category];
  }

  defsOf(category: PromptDefaultCategory): PromptDefaultDef[] {
    return this.defaults.byCategory(category);
  }

  isCustom(id: string): boolean {
    return this.defaults.isCustom(id);
  }

  effective(id: string): string {
    return this.defaults.effective(id);
  }

  /** Documented variables available to a template (empty when none). */
  varsOf(id: string): PromptVar[] {
    return this.defaults.def(id)?.vars ?? [];
  }

  /** `{{name}}` as a display string (avoids brace-escaping in the template). */
  varDisplay(v: PromptVar): string {
    return `{{${v.name}}}`;
  }

  /**
   * Live preview of the effective template: substitutes the documented vars
   * with their example (or a representative placeholder) values, so the user
   * sees exactly how conditionals and placeholders will expand.
   */
  preview(id: string): string {
    const vars: Record<string, string | number | boolean> = {};
    for (const v of this.varsOf(id)) {
      if (v.example !== undefined) {
        vars[v.name] = v.example;
      } else if (v.type === 'boolean') {
        vars[v.name] = true;
      } else if (v.type === 'number') {
        vars[v.name] = 0;
      } else {
        vars[v.name] = `(${v.name})`;
      }
    }
    return this.defaults.render(id, vars);
  }

  /**
   * `{{…}}` tokens in the effective template text that are neither documented
   * variables nor conditional syntax — likely typos the user should know about.
   */
  unknownTokens(id: string, text: string): string[] {
    const known = new Set(this.varsOf(id).map(v => v.name));
    const found: string[] = [];
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text ?? '')) !== null) {
      const token = m[1].trim();
      if (token === 'else' || token === '/if' || token.startsWith('#if ')) continue;
      if (!known.has(token)) found.push(`{{${token}}}`);
    }
    return [...new Set(found)];
  }

  customizedCount(): number {
    return this.defaults.customized().length;
  }

  onInput(id: string, value: string): void {
    this.defaults.update(id, value);
  }

  reset(id: string): void {
    this.defaults.reset(id);
  }

  resetAll(): void {
    this.defaults.resetAll();
  }
}
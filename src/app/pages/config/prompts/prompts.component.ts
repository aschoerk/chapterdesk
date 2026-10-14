import { Component, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PromptDefaultsService } from '../../../core/prompt-defaults.service';
import { PROMPT_DEFAULT_CATEGORIES } from '../../../models/prompt-default';
import type {
  PromptDefaultCategory,
  PromptDefaultDef,
  PromptVar
} from '../../../models/prompt-default';
import type { PromptScope, PromptVersion } from '../../../models/prompt-version';
import { ProjectService } from '../../../core/project.service';
import { TopicSelectionService } from '../../../core/topic-selection.service';

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
  private readonly projectService = inject(ProjectService);
  private readonly topicSelection = inject(TopicSelectionService);

  readonly categories = PROMPT_DEFAULT_CATEGORIES;

  /** Per-card local draft buffer (undefined = reflect the effective text). */
  private readonly drafts = signal<Record<string, string>>({});

  // "Save as version…" inline form state.
  readonly newVersionFor = signal<string | null>(null);
  readonly newVersionName = signal('');
  readonly newVersionScope = signal<PromptScope>('user');

  // Inline rename state (versionId → temp name).
  readonly renamingId = signal<string | null>(null);
  readonly renameText = signal('');

  /** The concrete current topic id (a real topic must be selected), or null. */
  readonly topicId = signal<string | null>(null);

  constructor() {
    // Version data is usually loaded at app startup; make sure it is.
    void this.defaults.load();
    // Resolve the current topic (the sidebar / Topics / Projects shared state).
    // Kept in sync so a topic selected elsewhere is picked up without remount.
    effect(() => {
      const selected = this.topicSelection.selectedTopicId();
      if (typeof selected === 'string' && selected !== 'all' && selected !== 'unassigned'
        && this.projectService.topics().some(t => t.id === selected)) {
        this.topicId.set(selected);
      } else {
        this.topicId.set(null);
      }
    });
  }

  topicName(topicId: string | null): string {
    if (!topicId) return '';
    return this.projectService.topics().find(t => t.id === topicId)?.name ?? topicId;
  }

  categoryMeta(category: PromptDefaultCategory): { title: string; hint: string } {
    return CATEGORY_TITLES[category];
  }

  defsOf(category: PromptDefaultCategory): PromptDefaultDef[] {
    return this.defaults.byCategory(category);
  }

  isCustom(id: string): boolean {
    return this.defaults.isCustom(id);
  }

  /** The effective template (topic-aware when a current topic is set). */
  effective(id: string): string {
    return this.defaults.effective(id, this.topicId());
  }

  /** What the textarea currently shows (draft when edited, else effective). */
  draftText(id: string): string {
    return this.drafts()[id] ?? this.effective(id);
  }

  hasDraft(id: string): boolean {
    const draft = this.drafts()[id];
    return draft !== undefined && draft !== this.effective(id);
  }

  onInput(id: string, value: string): void {
    this.drafts.update(map => ({ ...map, [id]: value }));
  }

  discardDraft(id: string): void {
    this.drafts.update(map => {
      const next = { ...map };
      delete next[id];
      return next;
    });
  }

  /** Which scope/version currently supplies the effective text (topic-aware). */
  activeSource(id: string) {
    return this.defaults.activeSource(id, this.topicId());
  }

  sourceLabel(id: string): string {
    const source = this.activeSource(id);
    if (source.kind === 'user') return `your version “${source.version.name}”`;
    if (source.kind === 'topic') return `topic “${this.topicName(source.topicId)}” version “${source.version.name}”`;
    return 'built-in default';
  }

  /** Persist the draft: edits the active version, or starts "save as". */
  async saveChanges(id: string): Promise<void> {
    const text = this.draftText(id);
    const source = this.activeSource(id);
    if (source.kind !== 'default') {
      await this.defaults.saveVersionText(source.version.id, text);
      this.discardDraft(id);
      return;
    }
    // Default is active — saving must create a version first.
    this.startNewVersion(id, text);
  }

  // ------------------------------------------------ active version select

  userVersions(id: string): PromptVersion[] {
    return this.defaults.userVersions(id);
  }

  /** Topic versions of the CURRENT topic only (the ones we can select here). */
  currentTopicVersions(id: string): PromptVersion[] {
    const topicId = this.topicId();
    return topicId ? this.defaults.topicVersions(id, topicId) : [];
  }

  /** The id of the currently-selected option for the select (default → ''). */
  selectedValue(id: string): string {
    const source = this.activeSource(id);
    if (source.kind === 'default') return '';
    return source.version.id;
  }

  /** Pick a version (or '' = built-in default) as the active one. */
  async onSelectVersion(id: string, versionId: string): Promise<void> {
    this.discardDraft(id);
    if (!versionId) {
      await this.defaults.revertToDefault(id, this.topicId());
      return;
    }
    const version = this.defaults.versions().find(v => v.id === versionId);
    if (!version) return;
    if (version.scope === 'user') {
      await this.defaults.selectVersion(id, versionId, 'user');
    } else if (version.scope === 'topic' && version.topicId) {
      // A topic version only takes effect when no user selection shadows it.
      if (this.defaults.selectionFor(id, 'user')) {
        await this.defaults.clearSelection(id, 'user');
      }
      await this.defaults.selectVersion(id, versionId, 'topic', version.topicId);
    }
  }

  /** Clear user + topic selections → back to the built-in default. */
  async revertToDefault(id: string): Promise<void> {
    this.discardDraft(id);
    await this.defaults.revertToDefault(id, this.topicId());
  }

  // ------------------------------------------------ save as new version

  startNewVersion(id: string, text?: string): void {
    this.newVersionFor.set(id);
    this.newVersionName.set(this.defaults.def(id)?.label ?? 'Custom');
    this.newVersionScope.set('user');
    // Seed with the current draft/effective text so nothing is lost.
    if (text !== undefined) this.drafts.update(map => ({ ...map, [id]: text }));
  }

  cancelNewVersion(): void {
    this.newVersionFor.set(null);
  }

  async confirmNewVersion(id: string): Promise<void> {
    const name = this.newVersionName().trim() || 'Custom';
    const scope = this.newVersionScope();
    const text = this.draftText(id);
    const version = await this.defaults.createVersion(id, name, text, scope, this.topicId());
    // Make the new version active immediately.
    if (scope === 'user') {
      await this.defaults.selectVersion(id, version.id, 'user');
    } else if (version.topicId) {
      if (this.defaults.selectionFor(id, 'user')) {
        await this.defaults.clearSelection(id, 'user');
      }
      await this.defaults.selectVersion(id, version.id, 'topic', version.topicId);
    }
    this.discardDraft(id);
    this.newVersionFor.set(null);
  }

  // ------------------------------------------------ version management

  allVersions(id: string): PromptVersion[] {
    return this.defaults.versionsFor(id);
  }

  versionScopeLabel(version: PromptVersion): string {
    return version.scope === 'topic'
      ? `topic "${this.topicName(version.topicId)}"`
      : 'you';
  }

  startRename(id: string, version: PromptVersion): void {
    this.renamingId.set(version.id);
    this.renameText.set(version.name);
  }

  cancelRename(): void {
    this.renamingId.set(null);
  }

  async confirmRename(id: string, version: PromptVersion): Promise<void> {
    const name = this.renameText().trim();
    if (name) await this.defaults.renameVersion(version.id, name);
    this.renamingId.set(null);
  }

  async deleteVersion(id: string, versionId: string): Promise<void> {
    await this.defaults.deleteVersion(versionId);
    if (this.selectedValue(id) === versionId) this.discardDraft(id);
  }

  // ------------------------------------------------ preview + helpers

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
   * with their example (or a representative placeholder) values.
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
    return this.defaults.render(id, vars, this.topicId());
  }

  /** `{{…}}` tokens that are neither documented variables nor conditional syntax. */
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

  async resetAll(): Promise<void> {
    await this.defaults.resetAll();
    this.drafts.set({});
  }
}

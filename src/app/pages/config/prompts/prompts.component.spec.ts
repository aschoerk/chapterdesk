import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { PromptsComponent } from './prompts.component';
import { PromptDefaultsService } from '../../../core/prompts/prompt-defaults.service';
import { PromptApiService } from '../../../core/prompts/prompt-api.service';
import { ProjectService } from '../../../core/settings/project.service';
import { TopicSelectionService } from '../../../core/settings/topic-selection.service';
import { PROMPT_DEFAULTS } from '../../../models/prompt-default';
import type { Topic } from '../../../models/chat';
import { makeTopic } from '../../../../../test-helpers/factories';
import { FakePromptApiService } from '../../../../../test-helpers/fake-prompt-api';

describe('PromptsComponent', () => {
  let fixture: ComponentFixture<PromptsComponent>;
  let component: PromptsComponent;
  let defaults: PromptDefaultsService;
  let topicSelection: TopicSelectionService;
  const topics = signal<Topic[]>([]);

  beforeEach(async () => {
    topics.set([]);
    localStorage.removeItem('chat.promptDefaults');
    localStorage.removeItem('chat.selectedTopicId');
    await TestBed.configureTestingModule({
      imports: [PromptsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: PromptApiService, useValue: new FakePromptApiService() },
        { provide: ProjectService, useValue: { topics: () => topics() } },
      ],
    }).compileComponents();

    defaults = TestBed.inject(PromptDefaultsService);
    topicSelection = TestBed.inject(TopicSelectionService);

    fixture = TestBed.createComponent(PromptsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders every prompt default with its built-in text', () => {
    const native = fixture.nativeElement as HTMLElement;
    const text = native.textContent ?? '';
    // Category headings.
    expect(text).toContain('Structure & writing');
    expect(text).toContain('Image generation');
    expect(text).toContain('Language');
    // Textarea values hold the built-in defaults (set via [ngModel], so they
    // are NOT part of textContent).
    const values = Array.from(native.querySelectorAll<HTMLTextAreaElement>('textarea'))
      .map(t => t.value);
    for (const def of PROMPT_DEFAULTS) {
      expect(text).toContain(def.label);
      expect(values.some(v => v.startsWith(def.default.slice(0, 40)))).toBe(true);
    }
  });

  it('saves a new user version and reverts to the default', async () => {
    // Type a draft, then materialize it as a named user version.
    component.onInput('structure.title', 'Give this story a punchy title.');
    expect(component.hasDraft('structure.title')).toBe(true);

    component.startNewVersion('structure.title');
    component.newVersionName.set('Punchy');
    await component.confirmNewVersion('structure.title');
    fixture.detectChanges();

    expect(defaults.effective('structure.title')).toBe('Give this story a punchy title.');
    expect(defaults.isCustom('structure.title')).toBe(true);
    expect(defaults.userVersions('structure.title')).toHaveLength(1);
    expect(component.customizedCount()).toBe(1);
    expect(component.hasDraft('structure.title')).toBe(false);

    // Revert — the selection is dropped and the built-in default returns.
    await component.revertToDefault('structure.title');
    fixture.detectChanges();
    expect(defaults.effective('structure.title')).toBe(
      PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!.default
    );
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(component.customizedCount()).toBe(0);
  });

  it('edits the text of the active version via Save changes', async () => {
    component.onInput('structure.title', 'First custom text');
    component.startNewVersion('structure.title');
    component.newVersionName.set('Punchy');
    await component.confirmNewVersion('structure.title');
    expect(defaults.effective('structure.title')).toBe('First custom text');

    // The active source is now a user version → saving edits it in place.
    component.onInput('structure.title', 'Updated custom text');
    expect(component.hasDraft('structure.title')).toBe(true);
    await component.saveChanges('structure.title');
    fixture.detectChanges();

    expect(defaults.effective('structure.title')).toBe('Updated custom text');
    expect(defaults.userVersions('structure.title')).toHaveLength(1);
  });

  it('creates and applies a topic version when a topic is selected', async () => {
    topics.set([makeTopic({ id: 't1', name: 'Cyberpunk' })]);
    topicSelection.selectTopic('t1');
    const fx = TestBed.createComponent(PromptsComponent);
    const c = fx.componentInstance;
    fx.detectChanges();
    expect(c.topicId()).toBe('t1');

    c.onInput('structure.title', 'Neon-flavored title');
    c.startNewVersion('structure.title');
    c.newVersionName.set('Cyber v1');
    c.newVersionScope.set('topic');
    await c.confirmNewVersion('structure.title');
    fx.detectChanges();

    // The topic version applies for that topic (and as the current topic).
    expect(defaults.effective('structure.title', 't1')).toBe('Neon-flavored title');
    expect(c.effective('structure.title')).toBe('Neon-flavored title');
    expect(defaults.activeSource('structure.title', 't1').kind).toBe('topic');
    // ...but not for another topic (built-in default).
    expect(defaults.effective('structure.title', 't2')).toBe(
      PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!.default
    );
  });

  it('picking Built-in default in the selector reverts user and topic scope', async () => {
    const version = await defaults.createVersion('structure.title', 'Punchy', 'Custom.', 'user');
    await defaults.selectVersion('structure.title', version.id, 'user');
    expect(defaults.isCustom('structure.title')).toBe(true);

    await component.onSelectVersion('structure.title', '');
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(defaults.effective('structure.title')).toBe(
      PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!.default
    );
  });

  it('renames and deletes a version', async () => {
    const version = await defaults.createVersion('structure.title', 'Old name', 'Custom.', 'user');
    await defaults.selectVersion('structure.title', version.id, 'user');

    component.startRename('structure.title', version);
    component.renameText.set('New name');
    await component.confirmRename('structure.title', version);
    expect(defaults.userVersions('structure.title')[0].name).toBe('New name');

    await component.deleteVersion('structure.title', version.id);
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(defaults.effective('structure.title')).toBe(
      PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!.default
    );
  });

  it('Reset all clears every customization', async () => {
    component.onInput('structure.title', 'T1');
    component.startNewVersion('structure.title');
    component.newVersionName.set('A');
    await component.confirmNewVersion('structure.title');

    component.onInput('image.create', 'Draw differently.');
    component.startNewVersion('image.create');
    component.newVersionName.set('B');
    await component.confirmNewVersion('image.create');
    fixture.detectChanges();
    expect(component.customizedCount()).toBe(2);

    await component.resetAll();
    fixture.detectChanges();
    expect(component.customizedCount()).toBe(0);
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(defaults.isCustom('image.create')).toBe(false);
  });

  it('render() fills placeholders from the effective template', async () => {
    await defaults.update('structure.elaborate', 'Chapter {{chapter}} — go!');
    expect(defaults.render('structure.elaborate', { chapter: 7 }))
      .toBe('Chapter 7 — go!');

    // Default template keeps the built-in placeholders working; empty hints
    // leave no blank line thanks to the {{#if hints}} conditional block.
    await defaults.reset('structure.elaborate');
    expect(defaults.render('structure.elaborate', { chapter: 3, hints: '' }))
      .toBe(`elaborate on chapter 3
Expand chapter 3 in detail. Use only material that belongs in chapter 3; do not incorporate any events, details, or information from chapters that come after it.`);
  });

  it('documents the variables of every template as chips', () => {
    const native = fixture.nativeElement as HTMLElement;
    const chips = Array.from(native.querySelectorAll<HTMLElement>('.var-chip'));

    const elaborateView = PROMPT_DEFAULTS.find(d => d.id === 'structure.elaborate-view')!;
    expect(component.varsOf(elaborateView.id).map(v => v.name)).toEqual([
      'chapter', 'name', 'isFirst', 'hints'
    ]);
    // a chip is rendered for every documented var (and its name is shown)
    expect(chips.length).toBeGreaterThanOrEqual(component.varsOf(elaborateView.id).length);
    const chipTexts = chips.map(c => c.textContent ?? '');
    expect(chipTexts.some(t => t.includes('{{chapter}}'))).toBe(true);
    expect(chipTexts.some(t => t.includes('{{isFirst}}'))).toBe(true);
  });

  it('renders a live preview that resolves conditionals and placeholders', () => {
    const native = fixture.nativeElement as HTMLElement;
    const previews = Array.from(native.querySelectorAll<HTMLElement>('.prompt-preview pre'))
      .map(p => p.textContent ?? '');
    expect(previews.length).toBeGreaterThan(0);
    // The elaborate-view {{#if isFirst}} resolves to its example's first-view branch.
    expect(previews.some(t => t.includes('This is the first view of this chapter'))).toBe(true);
    // No preview leaves dangling template tokens behind.
    for (const t of previews) expect(t.includes('{{')).toBe(false);
  });

  it('flags unknown tokens while accepting variables and conditional syntax', () => {
    const elaborate = PROMPT_DEFAULTS.find(d => d.id === 'structure.elaborate')!;
    expect(component.unknownTokens(elaborate.id, elaborate.default)).toEqual([]);
    expect(component.unknownTokens(elaborate.id,
      'use {{chapter}} and {{#if hints}}keep{{else}}skip{{/if}} and {{bogus}}'))
      .toEqual(['{{bogus}}']);
    // templates without documented vars treat every token as unknown
    expect(component.unknownTokens('structure.title', '{{anything}}')).toEqual(['{{anything}}']);
  });
});
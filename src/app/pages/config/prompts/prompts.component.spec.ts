import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { PromptsComponent } from './prompts.component';
import { PromptDefaultsService } from '../../../core/prompt-defaults.service';
import { PROMPT_DEFAULTS } from '../../../models/prompt-default';

describe('PromptsComponent', () => {
  let fixture: ComponentFixture<PromptsComponent>;
  let component: PromptsComponent;
  let defaults: PromptDefaultsService;

  beforeEach(async () => {
    localStorage.removeItem('chat.promptDefaults');
    await TestBed.configureTestingModule({
      imports: [PromptsComponent],
      providers: [provideZonelessChangeDetection()]
    }).compileComponents();

    defaults = TestBed.inject(PromptDefaultsService);

    fixture = TestBed.createComponent(PromptsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem('chat.promptDefaults');
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

  it('edits a template and marks it customized; Reset restores the default', () => {
    const textarea = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();

    component.onInput('structure.title', 'Give this story a punchy title.');
    fixture.detectChanges();

    expect(defaults.effective('structure.title')).toBe('Give this story a punchy title.');
    expect(defaults.isCustom('structure.title')).toBe(true);
    expect(component.customizedCount()).toBe(1);
    // Persisted.
    const stored = JSON.parse(localStorage.getItem('chat.promptDefaults') ?? '{}');
    expect(stored['structure.title']).toBe('Give this story a punchy title.');

    component.reset('structure.title');
    fixture.detectChanges();
    expect(defaults.effective('structure.title')).toBe(
      PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!.default
    );
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(component.customizedCount()).toBe(0);
  });

  it('restores the default when the user types the exact default text', () => {
    const def = PROMPT_DEFAULTS.find(d => d.id === 'structure.title')!;
    component.onInput('structure.title', 'Custom');
    expect(defaults.isCustom('structure.title')).toBe(true);

    // Typing the exact default clears the override.
    component.onInput('structure.title', def.default);
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(defaults.effective('structure.title')).toBe(def.default);
  });

  it('Reset all clears every customization', () => {
    component.onInput('structure.title', 'T1');
    component.onInput('image.create', 'Draw differently.');
    fixture.detectChanges();
    expect(component.customizedCount()).toBe(2);

    component.resetAll();
    fixture.detectChanges();
    expect(component.customizedCount()).toBe(0);
    expect(defaults.isCustom('structure.title')).toBe(false);
    expect(defaults.isCustom('image.create')).toBe(false);
  });

  it('render() fills placeholders from the effective template', () => {
    defaults.update('structure.elaborate', 'Chapter {{chapter}} — go!');
    expect(defaults.render('structure.elaborate', { chapter: 7 }))
      .toBe('Chapter 7 — go!');

    // Default template keeps the built-in placeholders working; empty hints
    // leave no blank line thanks to the {{#if hints}} conditional block.
    defaults.reset('structure.elaborate');
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
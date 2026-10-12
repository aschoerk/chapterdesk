import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PromptDefaultsService } from './prompt-defaults.service';
import { PROMPT_DEFAULTS, promptDefaultById } from '../models/prompt-default';

describe('PromptDefaultsService', () => {
  let service: PromptDefaultsService;

  beforeEach(async () => {
    localStorage.removeItem('chat.promptDefaults');
    TestBed.resetTestingModule();
    service = TestBed.inject(PromptDefaultsService);
  });

  afterEach(() => {
    localStorage.removeItem('chat.promptDefaults');
  });

  it('exposes every catalogued default', () => {
    expect(service.all()).toEqual(PROMPT_DEFAULTS);
    expect(service.byCategory('image').length).toBeGreaterThan(0);
    expect(service.effective('structure.title')).toBe('Generate a concise title for this story.');
    expect(service.isCustom('structure.title')).toBe(false);
  });

  it('catalogues the director prepend instructions', () => {
    const withChars = service.effective('structure.prepend');
    const basic = service.effective('structure.prepend-basic');
    // Both direct the model to a first-person retelling of already-occurred events.
    expect(withChars).toContain('first person');
    expect(withChars).toContain('{{characters}}');
    expect(basic).toContain('Assume the events');
    // Only the characters variant references the named characters.
    expect(basic).not.toContain('{{characters}}');
  });

  it('returns empty for an unknown id', () => {
    expect(service.effective('nope')).toBe('');
    expect(service.def('nope')).toBeUndefined();
  });

  it('persists overrides and reloads them', () => {
    service.update('structure.title', 'A short and catchy title');

    // A fresh instance reads the same stored override.
    const second = TestBed.inject(PromptDefaultsService);
    expect(second.effective('structure.title')).toBe('A short and catchy title');
    expect(second.isCustom('structure.title')).toBe(true);
  });

  it('render() substitutes placeholders and leaves unknown ones intact', () => {
    // Without hints the {{#if hints}} conditional keeps the template clean.
    expect(service.render('structure.elaborate', { chapter: 4, hints: '' }))
      .toBe(`elaborate on chapter 4
Expand chapter 4 in detail. Use only material that belongs in chapter 4; do not incorporate any events, details, or information from chapters that come after it.`);
    // First view of a chapter: the template renders the first-view branch.
    const withName = service.render('structure.elaborate-view', {
      chapter: 2, name: 'Anna', hints: '', isFirst: true
    });
    expect(withName).toBe(
      `Expand chapter 2 in detail. Use only material that belongs in chapter 2; do not incorporate any events, details, or information from chapters that come after it.
Elaborate the chapter this time out of the view of Anna in first person.
This is the first view of this chapter — write the chapter freely from scratch.`
    );
    expect(service.render('image.storyboard', { index: 1, total: 3 })).toContain(
      'render picture 1 of 3'
    );
  });

  it('renders the {{#if isFirst}} conditional for elaborate chapter views', () => {
    const first = service.render('structure.elaborate-view', {
      chapter: 1, name: 'Anna', hints: '', isFirst: true
    });
    expect(first).toContain('This is the first view of this chapter');
    expect(first).not.toContain('This is a follow-up view');
    expect(first).not.toContain('{{');

    const followUp = service.render('structure.elaborate-view', {
      chapter: 1, name: 'Ben', hints: '', isFirst: false
    });
    expect(followUp).toContain('This is a follow-up view');
    expect(followUp).toContain('Do not repeat anything they already established');
    expect(followUp).toContain('write only material that adds new aspects to the plot');
    expect(followUp).not.toContain('first view of this chapter');
    expect(followUp).not.toContain('{{');

    // Unknown placeholders stay untouched (the editor surfaces them as typos).
    service.update('structure.title', 'Hello {{planet}}!');
    expect(service.render('structure.title', {})).toBe('Hello {{planet}}!');
    service.reset('structure.title');
  });

  it('render() injects the elaborate dialog hints via {{hints}}', () => {
    const hints = '\nFollow these hints from the user: keep it dark';
    expect(service.render('structure.elaborate', { chapter: 4, hints }))
      .toContain('Follow these hints from the user: keep it dark');
    expect(service.render('structure.elaborate-view', { chapter: 2, name: 'Anna', hints }))
      .toContain('\nFollow these hints from the user: keep it dark');
  });

  it('resetAll clears every customization', () => {
    service.update('structure.title', 'X');
    service.update('image.create', 'Y');
    expect(service.customized().length).toBe(2);
    service.resetAll();
    expect(service.customized().length).toBe(0);
    expect(service.effective('structure.title'))
      .toBe(promptDefaultById('structure.title')!.default);
    expect(service.effective('image.create'))
      .toBe(promptDefaultById('image.create')!.default);
  });
});
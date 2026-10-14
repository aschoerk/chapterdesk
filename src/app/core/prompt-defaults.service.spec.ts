import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PromptDefaultsService } from './prompt-defaults.service';
import { PromptApiService } from './prompt-api.service';
import { PROMPT_DEFAULTS, promptDefaultById } from '../models/prompt-default';
import { FakePromptApiService } from '../../../test-helpers/fake-prompt-api';

describe('PromptDefaultsService', () => {
  let service: PromptDefaultsService;
  let api: FakePromptApiService;

  beforeEach(async () => {
    localStorage.removeItem('chat.promptDefaults');
    TestBed.resetTestingModule();
    api = new FakePromptApiService();
    TestBed.configureTestingModule({
      providers: [{ provide: PromptApiService, useValue: api }],
    });
    service = TestBed.inject(PromptDefaultsService);
    await service.load();
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

  it('creates a user version and makes it the effective text', async () => {
    const version = await service.createVersion('structure.title', 'Punchy', 'A short title.', 'user');
    await service.selectVersion('structure.title', version.id, 'user');

    expect(service.effective('structure.title')).toBe('A short title.');
    expect(service.isCustom('structure.title')).toBe(true);
    expect(service.activeSource('structure.title')).toEqual({ kind: 'user', version });
    expect(service.userVersions('structure.title')).toHaveLength(1);
    expect(service.customized()).toContain('structure.title');
  });

  it('user selection wins over the topic selection', async () => {
    const user = await service.createVersion('structure.title', 'User', 'User text', 'user');
    const topic = await service.createVersion('structure.title', 'Topic', 'Topic text', 'topic', 't1');
    await service.selectVersion('structure.title', topic.id, 'topic', 't1');
    // Before a user selection, the topic version applies for that topic only.
    expect(service.effective('structure.title', 't1')).toBe('Topic text');
    expect(service.effective('structure.title', 't2')).toBe(promptDefaultById('structure.title')!.default);
    expect(service.effective('structure.title')).toBe(promptDefaultById('structure.title')!.default);

    // A user selection shadows the topic version everywhere.
    await service.selectVersion('structure.title', user.id, 'user');
    expect(service.effective('structure.title', 't1')).toBe('User text');
    expect(service.effective('structure.title')).toBe('User text');
  });

  it('topic scope only applies to the matching topic', async () => {
    const topic = await service.createVersion('structure.title', 'C-Punk', 'Neon title', 'topic', 'cyber');
    await service.selectVersion('structure.title', topic.id, 'topic', 'cyber');
    expect(service.effective('structure.title', 'cyber')).toBe('Neon title');
    expect(service.effective('structure.title', 'fantasy')).toBe(promptDefaultById('structure.title')!.default);
    expect(service.effective('structure.title')).toBe(promptDefaultById('structure.title')!.default);
  });

  it('revertToDefault clears the user and topic selections', async () => {
    const user = await service.createVersion('structure.title', 'Punchy', 'Short.', 'user');
    const topic = await service.createVersion('structure.title', 'Topic', 'T.', 'topic', 't1');
    await service.selectVersion('structure.title', user.id, 'user');
    await service.selectVersion('structure.title', topic.id, 'topic', 't1');
    expect(service.isCustom('structure.title')).toBe(true);

    await service.revertToDefault('structure.title', 't1');
    expect(service.isCustom('structure.title')).toBe(false);
    expect(service.effective('structure.title', 't1')).toBe(promptDefaultById('structure.title')!.default);
  });

  it('deleting a version falls back to the default', async () => {
    const version = await service.createVersion('structure.title', 'V', 'Hello', 'user');
    await service.selectVersion('structure.title', version.id, 'user');
    expect(service.effective('structure.title')).toBe('Hello');

    await service.deleteVersion(version.id);
    expect(service.effective('structure.title')).toBe(promptDefaultById('structure.title')!.default);
    expect(service.isCustom('structure.title')).toBe(false);
  });

  it('update() edits the active user version in place (no duplicate)', async () => {
    const version = await service.createVersion('structure.title', 'Punchy', 'Original', 'user');
    await service.selectVersion('structure.title', version.id, 'user');
    await service.update('structure.title', 'Rewritten');
    expect(service.effective('structure.title')).toBe('Rewritten');
    expect(service.userVersions('structure.title')).toHaveLength(1);
    expect(service.userVersions('structure.title')[0].name).toBe('Punchy');
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

  it('renders the {{#if isFirst}} conditional for elaborate chapter views', async () => {
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
    await service.update('structure.title', 'Hello {{planet}}!');
    expect(service.render('structure.title', {})).toBe('Hello {{planet}}!');
    await service.reset('structure.title');
  });

  it('render() injects the elaborate dialog hints via {{hints}}', () => {
    const hints = '\nFollow these hints from the user: keep it dark';
    expect(service.render('structure.elaborate', { chapter: 4, hints }))
      .toContain('Follow these hints from the user: keep it dark');
    expect(service.render('structure.elaborate-view', { chapter: 2, name: 'Anna', hints }))
      .toContain('\nFollow these hints from the user: keep it dark');
  });

  it('render() resolves a version for the given topic', async () => {
    const topic = await service.createVersion('structure.elaborate', 'Terse', 'Chapter {{chapter}} — terse.', 'topic', 't1');
    await service.selectVersion('structure.elaborate', topic.id, 'topic', 't1');
    expect(service.render('structure.elaborate', { chapter: 7, hints: '' }, 't1')).toBe('Chapter 7 — terse.');
    expect(service.render('structure.elaborate', { chapter: 7, hints: '' }, 't2'))
      .toContain('Expand chapter 7 in detail.');
  });

  it('resetAll clears every customization', async () => {
    await service.update('structure.title', 'X');
    await service.update('image.create', 'Y');
    expect(service.customized().length).toBe(2);
    await service.resetAll();
    expect(service.customized().length).toBe(0);
    expect(service.effective('structure.title'))
      .toBe(promptDefaultById('structure.title')!.default);
    expect(service.effective('image.create'))
      .toBe(promptDefaultById('image.create')!.default);
  });
});
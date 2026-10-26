import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import {
  ChatParametersEditorComponent,
} from './chat-parameters-editor.component';

/**
 * ChatParametersEditorComponent is the inline sampling/thinking editor used
 * by the chat page. These tests drive its signals and emit() flow with real
 * Angular change detection.
 */

describe('ChatParametersEditorComponent', () => {
  let fixture: ComponentFixture<ChatParametersEditorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatParametersEditorComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    TestBed.inject(I18nService).setLocale('en');
    fixture = TestBed.createComponent(ChatParametersEditorComponent);
    fixture.detectChanges();
  });

  it('starts with overrides disabled and an empty draft', () => {
    const comp = fixture.componentInstance;
    expect(comp.overrideEnabled()).toBe(false);
    expect(comp.draft()).toMatchObject({
      temperature: null,
      topK: null,
      topM: null,
      stream: null,
      thinking: null,
      thinkingLevel: null,
    });
    expect(comp.triValue(null)).toBe('inherit');
    expect(comp.triValue(true)).toBe('yes');
    expect(comp.triValue(false)).toBe('no');
  });

  it('hint() maps every key to a title/body via i18n', () => {
    const comp = fixture.componentInstance;
    for (const key of ['override', 'effective', 'temperature', 'topK', 'topM', 'stream', 'thinking', 'thinkingLevel'] as const) {
      const h = comp.hint(key);
      expect(h.title).toBeTruthy();
      expect(h.body).toBeTruthy();
    }
  });

  it('toggleHint opens/closes the hint popup', () => {
    const comp = fixture.componentInstance;
    comp.toggleHint('temperature', undefined);
    expect(comp.openHint()).toBe('temperature');
    comp.toggleHint('temperature', undefined);
    expect(comp.openHint()).toBeNull();
  });

  it('setOverride emits changed with the override flag', () => {
    const comp = fixture.componentInstance;
    const events: unknown[] = [];
    comp.changed.subscribe((e) => events.push(e));
    comp.setOverride(true);
    expect(comp.overrideEnabled()).toBe(true);
    expect(events).toHaveLength(1);
    expect((events[0] as { override: boolean }).override).toBe(true);
  });

  it('patch() updates a field and emits', () => {
    const comp = fixture.componentInstance;
    const events: unknown[] = [];
    comp.changed.subscribe((e) => events.push(e));
    comp.setOverride(true);
    comp.patch('temperature', 0.7);
    expect(comp.draft().temperature).toBe(0.7);
    expect((events.at(-1) as { draft: { temperature: number | null } }).draft.temperature).toBe(0.7);
  });

  it('setNumber parses numbers, blanks to null, and rejects non-finite', () => {
    const comp = fixture.componentInstance;
    comp.setOverride(true);
    comp.setNumber('temperature', '0.5');
    expect(comp.draft().temperature).toBe(0.5);
    comp.setNumber('temperature', '');
    expect(comp.draft().temperature).toBeNull();
    comp.setNumber('topK', 'abc');
    expect(comp.draft().topK).toBeNull();
  });

  it('setTriState maps inherit/yes/no', () => {
    const comp = fixture.componentInstance;
    comp.setOverride(true);
    comp.setTriState('stream', 'yes');
    expect(comp.draft().stream).toBe(true);
    comp.setTriState('stream', 'no');
    expect(comp.draft().stream).toBe(false);
    comp.setTriState('stream', 'inherit');
    expect(comp.draft().stream).toBeNull();
  });

  it('setLevel clears or sets the thinking level, never allowing invalid values', () => {
    const comp = fixture.componentInstance;
    comp.setOverride(true);
    comp.setLevel('high');
    expect(comp.draft().thinkingLevel).toBe('high');
    comp.setLevel('');
    expect(comp.draft().thinkingLevel).toBeNull();
    comp.setLevel('low');
    expect(comp.draft().thinkingLevel).toBe('low');
  });

  it('summary/sourceLabel reflect the inherited params and source', () => {
    const comp = fixture.componentInstance;
    expect(comp.summary()).toBeTruthy();
    expect(comp.sourceLabel()).toBeTruthy();
  });
});
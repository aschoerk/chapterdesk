import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { PersonaService } from '../../core/persona.service';
import { StoryConceptDialogService } from '../../core/dialogs/story-concept-dialog.service';
import { StoryConceptDialogComponent } from './story-concept-dialog.component';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makePersona } from '../../../../test-helpers/factories';

function makeNode(id: string) {
  return {
    id,
    chatId: 'c1',
    parentId: null,
    role: 'user' as const,
    content: 'Q?',
    version: 1,
    isCurrent: true,
    createdAt: new Date().toISOString(),
    attachments: [],
  };
}

describe('StoryConceptDialogComponent', () => {
  let fixture: ComponentFixture<StoryConceptDialogComponent>;
  let dialog: StoryConceptDialogService;
  let api: InMemoryChatApi;

  const open = () => dialog.open({
    chatId: 'c1',
    chat: null,
    node: makeNode('n1'),
    defaultModelId: 'm1',
    defaultProviderId: 'p1',
  });

  beforeEach(async () => {
    localStorage.clear();
    api = new InMemoryChatApi();
    api.personas.push(
      makePersona({ id: 'pers-1', name: 'Mara', shortName: 'Ma', description: 'A thief.' }),
      makePersona({ id: 'pers-2', name: 'Ivo', shortName: 'Iv', description: '' }),
    );
    await TestBed.configureTestingModule({
      imports: [StoryConceptDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CHAT_API, useValue: api },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(StoryConceptDialogService);
    dialog.cancel();
    fixture = TestBed.createComponent(StoryConceptDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('is empty while no dialog is open', () => {
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('seeds fields from the service when opened', () => {
    // open() only resolves on submit/cancel — do not await it here.
    void open();
    fixture.detectChanges();

    const comp = fixture.componentInstance;
    expect(comp.prompt()).toBe('');
    expect(comp.selectedPersonaIds()).toEqual([]);
    expect(comp.chapterCount()).toBeNull();
    expect(comp.targetWords()).toBeNull();
    expect(comp.modelId()).toBe('m1');
    dialog.cancel();
  });

  it('shows the loaded personas and resolves the selected ones on submit', async () => {
    const promise = open();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const comp = fixture.componentInstance;
    expect(comp.personas().length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.sc-persona').length).toBe(2);

    comp.prompt.set('  A clockwork city  ');
    comp.togglePersona('pers-1');
    comp.chapterCount.set(4);
    comp.targetWords.set(50000);
    comp.submit();

    const result = await promise;
    expect(result).toMatchObject({
      prompt: 'A clockwork city',
      personaIds: ['pers-1'],
      chapterCount: 4,
      targetWords: 50000,
      modelId: 'm1',
      providerId: 'p1',
    });
    expect(result?.personas).toEqual([
      { id: 'pers-1', name: 'Mara', shortName: 'Ma', description: 'A thief.' },
    ]);
  });

  it('toggling a persona twice removes it again', () => {
    const comp = fixture.componentInstance;
    comp.togglePersona('pers-2');
    expect(comp.selectedPersonaIds()).toEqual(['pers-2']);
    comp.togglePersona('pers-2');
    expect(comp.selectedPersonaIds()).toEqual([]);
  });

  it('treats empty / invalid numbers as "auto" (null)', async () => {
    const promise = open();
    fixture.detectChanges();
    const comp = fixture.componentInstance;
    expect(comp.optionalNumber('')).toBeNull();
    expect(comp.optionalNumber(0)).toBeNull();
    expect(comp.optionalNumber(-3)).toBeNull();
    expect(comp.optionalNumber('12')).toBe(12);

    comp.chapterCount.set(null);
    comp.targetWords.set(null);
    comp.submit();
    expect(await promise).toMatchObject({ chapterCount: null, targetWords: null });
  });

  it('does not submit without a model and alerts instead', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    void open();
    fixture.detectChanges();
    const comp = fixture.componentInstance;
    comp.modelId.set('');
    comp.submit();
    expect(alertSpy).toHaveBeenCalled();
    expect(dialog.current()).not.toBeNull();
    dialog.cancel();
    alertSpy.mockRestore();
  });

  it('Escape cancels the open dialog', () => {
    void open();
    fixture.detectChanges();
    expect(dialog.current()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.current()).toBeNull();
  });
});

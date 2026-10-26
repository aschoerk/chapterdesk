import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { PersonasComponent } from './personas.component';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makePersona, makeTopic } from '../../../../test-helpers/factories';
import { I18nService } from '../../core/i18n/i18n.service';

describe('PersonasComponent', () => {
  let fixture: ComponentFixture<PersonasComponent>;
  let component: PersonasComponent;
  let api: InMemoryChatApi;

  beforeEach(async () => {
    localStorage.clear();
    api = new InMemoryChatApi();
    api.personas.push(
      makePersona({ id: 'p1', name: 'Zelda', shortName: 'Zel', description: 'princess' }),
      makePersona({ id: 'p2', name: 'Link', shortName: 'Lin', description: 'hero', mainTopicId: 't1' }),
      makePersona({ id: 'p3', name: 'Ganon', shortName: 'Gan', description: 'villain', mainTopicId: 't2' }),
    );
    api.topics.push(
      makeTopic({ id: 't1', name: 'Hyrule' }),
      makeTopic({ id: 't2', name: 'Gerudo' }),
    );

    await TestBed.configureTestingModule({
      imports: [PersonasComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    fixture = TestBed.createComponent(PersonasComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
    await component.ngOnInit();
    fixture.detectChanges();
  });

  it('loads and renders the persona cards', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(component.personas().length).toBe(3);
    expect(text).toContain('Zelda');
    expect(text).toContain('Link');
    expect(text).toContain('Ganon');
  });

  it('filters the list by search term across name/shortName/description', () => {
    component.searchTerm.set('zelda');
    expect(component.filteredPersonas().map((p) => p.id)).toEqual(['p1']);
    component.searchTerm.set('hero');
    expect(component.filteredPersonas().map((p) => p.id)).toEqual(['p2']);
    component.searchTerm.set('missing');
    expect(component.filteredPersonas()).toEqual([]);
  });

  it('filters the list by topic', () => {
    component.topicFilterId.set('t2');
    expect(component.filteredPersonas().map((p) => p.id)).toEqual(['p3']);
    component.topicFilterId.set('all');
    expect(component.filteredPersonas().length).toBe(3);
  });

  it('sorts alphabetically asc/desc and toggles the primary direction', () => {
    component.toggleSort('alpha');
    expect(component.filteredPersonas().map((p) => p.name)).toEqual(['Ganon', 'Link', 'Zelda']);
    component.toggleSort('alpha'); // second click flips to Z–A
    expect(component.filteredPersonas().map((p) => p.name)).toEqual(['Zelda', 'Link', 'Ganon']);
    expect(component.alphaLabel()).toBe('Z–A');
  });

  it('openCreate opens an empty form and openEdit fills it from the persona', () => {
    component.openCreate();
    expect(component.showForm()).toBe(true);
    expect(component.editingId()).toBeNull();
    expect(component.form.name).toBe('');

    component.openEdit(component.personas()[0]);
    expect(component.editingId()).toBe('p1');
    expect(component.form.name).toBe('Zelda');
    expect(component.form.shortName).toBe('Zel');
  });

  it('save() validates required fields and creates a persona', async () => {
    component.showForm.set(true);
    component.editingId.set(null);
    component.form = {
      name: '  ',
      shortName: 'X',
      description: '',
      avatar: '',
      mainTopicId: 't1',
    };
    await component.save();
    expect(component.error()).toBeTruthy(); // name required

    component.form.name = 'New Persona';
    component.form.shortName = '';
    await component.save();
    expect(component.error()).toBeTruthy(); // shortName required

    component.form.name = 'New Persona';
    component.form.shortName = 'NP';
    component.form.mainTopicId = '';
    await component.save();
    expect(component.error()).toBeTruthy(); // topic required

    component.form.mainTopicId = 't1';
    await component.save();
    expect(component.error()).toBeNull();
    expect(component.showForm()).toBe(false);
    expect(component.personas().some((p) => p.name === 'New Persona')).toBe(true);
  });

  it('save() updates an existing persona in edit mode', async () => {
    component.openEdit(component.personas().find((p) => p.id === 'p1')!);
    component.form.name = 'Zelda II';
    await component.save();
    expect(component.error()).toBeNull();
    const updated = component.personas().find((p) => p.id === 'p1');
    expect(updated?.name).toBe('Zelda II');
  });

  it('requestClose asks before discarding when the form was edited', async () => {
    const confirmSvc = (component as unknown as { confirm: { current: () => unknown; close: (v: boolean) => void } }).confirm;
    component.openEdit(component.personas()[0]);
    component.form.name = 'something changed';
    const promise = component.requestClose();
    // The ConfirmService now has a pending request.
    expect(confirmSvc.current()).not.toBeNull();
    confirmSvc.close(false);
    await promise;
    // Keep-editing stays open.
    expect(component.showForm()).toBe(true);
  });

  it('deletePersona confirms then removes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await component.deletePersona(component.personas().find((p) => p.id === 'p2')!);
    expect(component.personas().some((p) => p.id === 'p2')).toBe(false);
    confirmSpy.mockRestore();
  });

  it('selection: toggle, select-all-visible, clear, assign to topic', async () => {
    component.searchTerm.set(''); // all visible
    component.toggleSelectAllVisible();
    expect(component.selectedCount()).toBe(3);

    component.toggleSelected('p1', new Event('click'));
    expect(component.isSelected('p1')).toBe(false);

    component.clearSelection();
    expect(component.selectedCount()).toBe(0);

    component.toggleSelected('p2', new Event('click'));
    component.bulkTopicId.set('t1');
    await component.assignSelectedToTopic();
    expect(component.selectedCount()).toBe(0);
    expect(component.personas().find((p) => p.id === 'p2')?.mainTopicId).toBe('t1');
  });

  it('setAsCurrent / clearCurrent / isCurrent', () => {
    component.setAsCurrent(component.personas()[0]);
    expect(component.isCurrent(component.personas()[0])).toBe(true);
    component.clearCurrent();
    expect(component.isCurrent(component.personas()[0])).toBe(false);
  });

  it('Escape closes ConfirmService when a confirm is up, else closes the form', () => {
    const confirmSvc = (component as unknown as { confirm: { current: () => unknown; close: (v: boolean) => void } }).confirm;
    const view = component as unknown as { onDocumentKeydown(e: KeyboardEvent): void };
    component.openEdit(component.personas()[0]);
    component.form.name = 'edited';

    // Escape while the editor is dirty opens the confirm dialog.
    view.onDocumentKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(confirmSvc.current()).not.toBeNull();
    confirmSvc.close(false);
    expect(component.showForm()).toBe(true);
  });
});
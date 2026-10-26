import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { TopicsComponent } from './topics.component';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeTopic, makeProject, makePersona } from '../../../../test-helpers/factories';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { TopicSelectionService } from '../../core/settings/topic-selection.service';
import { I18nService } from '../../core/i18n/i18n.service';

describe('TopicsComponent', () => {
  let fixture: ComponentFixture<TopicsComponent>;
  let component: TopicsComponent;
  let api: InMemoryChatApi;
  let confirm: ConfirmService;

  beforeEach(async () => {
    localStorage.clear();
    api = new InMemoryChatApi();
    api.topics.push(
      makeTopic({ id: 't1', name: 'Hyrule', projectIds: ['proj-1'] }),
      makeTopic({ id: 't2', name: 'Gerudo' }),
    );
    api.projects.push(makeProject({ id: 'proj-1', name: 'Zelda Saga' }));
    api.personas.push(
      makePersona({ id: 'p1', name: 'Zelda', mainTopicId: 't1' }),
      makePersona({ id: 'p2', name: 'Link' }),
    );

    await TestBed.configureTestingModule({
      imports: [TopicsComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    confirm = TestBed.inject(ConfirmService);
    TestBed.inject(TopicSelectionService).clear();
    fixture = TestBed.createComponent(TopicsComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
    await component.ngOnInit();
    fixture.detectChanges();
  });

  it('loads and renders topics', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(component.topics().length).toBe(2);
    expect(text).toContain('Hyrule');
    expect(text).toContain('Gerudo');
  });

  it('filters topics by search term', () => {
    component.searchTerm.set('hyrule');
    expect(component.filteredTopics().map((t) => t.id)).toEqual(['t1']);
    component.searchTerm.set('missing');
    expect(component.filteredTopics()).toEqual([]);
  });

  it('sorts alphabetically asc/desc and toggles direction', () => {
    component.toggleSort('alpha');
    expect(component.filteredTopics().map((t) => t.name)).toEqual(['Gerudo', 'Hyrule']);
    component.toggleSort('alpha'); // flip to Z–A
    expect(component.filteredTopics().map((t) => t.name)).toEqual(['Hyrule', 'Gerudo']);
  });

  it('counts projects and personas per topic', () => {
    expect(component.projectCount(component.topics()[0])).toBe(1);
    expect(component.personaCount(component.topics()[0])).toBe(1);
    expect(component.personaCount(component.topics()[1])).toBe(0);
  });

  it('selects and clears the current topic', () => {
    const topic = component.topics()[0];
    expect(component.isCurrentTopic(topic)).toBe(false);
    component.setCurrentTopic(topic);
    expect(component.isCurrentTopic(topic)).toBe(true);
    expect(component.currentTopic()?.id).toBe(topic.id);
    component.clearCurrentTopic();
    expect(component.currentTopic()).toBeNull();
  });

  it('openCreate opens an empty form; openEdit fills it', () => {
    component.openCreate();
    expect(component.showForm()).toBe(true);
    expect(component.editingId()).toBeNull();
    expect(component.form.name).toBe('');

    component.openEdit(component.topics()[0]);
    expect(component.editingId()).toBe('t1');
    expect(component.form.name).toBe('Hyrule');
  });

  it('save validates a name and creates a topic', async () => {
    component.showForm.set(true);
    component.editingId.set(null);
    component.form = { name: '   ', description: '', icon: '', defaultSystemPrompt: '' };
    await component.save();
    expect(component.error()).toBeTruthy();

    component.form.name = 'New Topic';
    await component.save();
    expect(component.error()).toBeNull();
    expect(component.showForm()).toBe(false);
    expect(component.topics().some((t) => t.name === 'New Topic')).toBe(true);
  });

  it('save updates an existing topic in edit mode', async () => {
    component.openEdit(component.topics()[0]);
    component.form.name = 'Hyrule 2';
    await component.save();
    expect(component.topics().find((t) => t.id === 't1')?.name).toBe('Hyrule 2');
  });

  it('deleteTopic asks for confirmation and deletes when confirmed', async () => {
    const topic = component.topics()[0];
    const promise = component.deleteTopic(topic);
    expect(confirm.current()).not.toBeNull();
    confirm.close(true);
    await promise;
    expect(component.topics().some((t) => t.id === topic.id)).toBe(false);
  });

  it('deleteTopic does not delete when cancelled', async () => {
    const topic = component.topics()[0];
    const promise = component.deleteTopic(topic);
    confirm.close(false);
    await promise;
    expect(component.topics().some((t) => t.id === topic.id)).toBe(true);
  });

  it('toggleMenu toggles the open menu id', () => {
    component.toggleMenu('t1', new Event('click'));
    expect(component.openMenuId()).toBe('t1');
    component.toggleMenu('t1', new Event('click'));
    expect(component.openMenuId()).toBeNull();
    component.closeMenu();
    expect(component.openMenuId()).toBeNull();
  });
});
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { ProjectsComponent } from './projects.component';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeProject, makeTopic, makePersona, makeModel, makeProvider } from '../../../../test-helpers/factories';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { TopicSelectionService } from '../../core/settings/topic-selection.service';
import { SettingsService } from '../../core/settings/settings.service';
import { I18nService } from '../../core/i18n/i18n.service';

describe('ProjectsComponent', () => {
  let fixture: ComponentFixture<ProjectsComponent>;
  let component: ProjectsComponent;
  let api: InMemoryChatApi;
  let confirm: ConfirmService;

  beforeEach(async () => {
    localStorage.clear();
    api = new InMemoryChatApi();
    api.projects.push(
      makeProject({ id: 'proj-1', name: 'Alpha Saga', mainTopicId: 't1', personaIds: ['p1'] }),
      makeProject({ id: 'proj-2', name: 'Brand New' }),
    );
    api.topics.push(
      makeTopic({ id: 't1', name: 'Hyrule', projectIds: ['proj-1'] }),
      makeTopic({ id: 't2', name: 'Gerudo' }),
    );
    api.personas.push(
      makePersona({ id: 'p1', name: 'Zelda' }),
      makePersona({ id: 'p2', name: 'Link' }),
    );
    api.providers.push(makeProvider({ id: 'prov-1' }));
    api.models.push(makeModel({ id: 'm1', providerId: 'prov-1', displayName: 'Alpha Model', modelId: 'a/model', enabled: true }));

    await TestBed.configureTestingModule({
      imports: [ProjectsComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    confirm = TestBed.inject(ConfirmService);
    TestBed.inject(TopicSelectionService).clear();
    fixture = TestBed.createComponent(ProjectsComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
    await component.ngOnInit();
    fixture.detectChanges();
  });

  it('loads and renders projects', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(component.projects().length).toBe(2);
    expect(text).toContain('Alpha Saga');
    expect(text).toContain('Brand New');
  });

  it('filters projects by topic and search term', () => {
    component.selectTopic('t1');
    expect(component.visibleProjects().map((p) => p.id)).toEqual(['proj-1']);
    component.selectTopic('unassigned');
    expect(component.visibleProjects().map((p) => p.id)).toEqual(['proj-2']);
    component.selectTopic('all');
    component.searchTerm.set('alpha');
    expect(component.visibleProjects().map((p) => p.id)).toEqual(['proj-1']);
  });

  it('sorts alphabetically asc/desc and toggles direction', () => {
    component.toggleSort('alpha');
    expect(component.visibleProjects().map((p) => p.name)).toEqual(['Alpha Saga', 'Brand New']);
    component.toggleSort('alpha'); // Z–A
    expect(component.visibleProjects().map((p) => p.name)).toEqual(['Brand New', 'Alpha Saga']);
  });

  it('sortedTopics pins the current topic to the front', () => {
    component.selectTopic('t2');
    expect(component.sortedTopics().map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('openCreate opens an empty form; openEdit fills it and loads params', async () => {
    component.openCreate();
    expect(component.showForm()).toBe(true);
    expect(component.editingId()).toBeNull();
    expect(component.form.name).toBe('');

    component.openEdit(component.projects()[0]);
    expect(component.editingId()).toBe('proj-1');
    expect(component.form.name).toBe('Alpha Saga');
    await fixture.whenStable();
  });

  it('save validates a name and a topic, then creates', async () => {
    component.showForm.set(true);
    component.editingId.set(null);
    component.form = {
      name: '', greeting: '', systemPrompt: '', defaultModelId: null,
      avatar: '', personaIds: [], chatParametersId: null, mainTopicId: '',
    };
    await component.save();
    expect(component.error()).toBeTruthy(); // name required

    component.form.name = 'New Env';
    await component.save();
    expect(component.error()).toBeTruthy(); // topic required

    component.form.mainTopicId = 't1';
    await component.save();
    expect(component.error()).toBeNull();
    expect(component.showForm()).toBe(false);
    expect(component.projects().some((p) => p.name === 'New Env')).toBe(true);
  });

  it('save updates an existing project in edit mode', async () => {
    component.openEdit(component.projects()[0]);
    component.form.name = 'Alpha Saga II';
    await component.save();
    expect(component.projects().find((p) => p.id === 'proj-1')?.name).toBe('Alpha Saga II');
  });

  it('deleteProject asks for confirmation and deletes on confirm', async () => {
    const project = component.projects()[0];
    const promise = component.deleteProject(project);
    expect(confirm.current()).not.toBeNull();
    confirm.close(true);
    await promise;
    expect(component.projects().some((p) => p.id === project.id)).toBe(false);
  });

  it('selection: toggle, count, clear, assign to topic', async () => {
    component.toggleSelected('proj-1', new Event('click'));
    expect(component.isSelected('proj-1')).toBe(true);
    expect(component.selectedCount()).toBe(1);
    component.bulkTopicId.set('t2');
    await component.assignSelectedToTopic();
    expect(component.selectedCount()).toBe(0);
    // InMemoryChatApi.updateProject stores mainTopicId on the project.
    const updated = component.projects().find((p) => p.id === 'proj-1');
    expect((updated as unknown as { mainTopicId?: string })?.mainTopicId).toBe('t2');
  });

  it('persona helpers: personasFor, togglePersona, isPersonaSelected', () => {
    const project = component.projects()[0];
    expect(component.personasFor(project).map((p) => p.id)).toEqual(['p1']);
    component.openEdit(project);
    expect(component.isPersonaSelected('p1')).toBe(true);
    component.togglePersona('p1');
    expect(component.isPersonaSelected('p1')).toBe(false);
    component.togglePersona('p2');
    expect(component.isPersonaSelected('p2')).toBe(true);
    const sorted = component.sortedFormPersonas();
    expect(sorted[0].id).toBe('p2'); // selected first
  });

  it('topic membership: add/remove current and change main topic', async () => {
    component.selectTopic('t1');
    await component.addProjectToCurrentTopic('proj-2');
    expect(component.topics().find((t) => t.id === 't1')?.projectIds).toContain('proj-2');

    await component.removeProjectFromCurrentTopic('proj-2');
    expect(component.topics().find((t) => t.id === 't1')?.projectIds).not.toContain('proj-2');

    const project = component.projects().find((p) => p.id === 'proj-2')!;
    await component.changeMainTopicFor(project, 't2');
    expect(component.topics().find((t) => t.id === 't2')?.projectIds).toContain('proj-2');
  });

  it('topicsToAddFor / topicsToChangeTo / topicsOf', () => {
    expect(component.topicsToAddFor('proj-2').map((t) => t.id)).toEqual(['t1', 't2']);
    component.selectTopic('t1');
    expect(component.topicsToChangeTo('proj-1').map((t) => t.id)).toEqual(['t2']);
    expect(component.topicsOf('proj-1').map((t) => t.id)).toEqual(['t1']);
  });

  it('saveTopic creates a topic and selects it', async () => {
    component.openCreateTopic();
    expect(component.showTopicForm()).toBe(true);
    await component.saveTopic();
    expect(component.topicError()).toBeTruthy(); // name required

    component.topicName.set('New Topic');
    await component.saveTopic();
    expect(component.topicError()).toBeNull();
    expect(component.showTopicForm()).toBe(false);
    const created = component.topics().find((t) => t.name === 'New Topic');
    expect(created).toBeTruthy();
    expect(component.selectedTopicId()).toBe(created!.id);
  });

  it('saveTopic updates an existing topic', async () => {
    component.openEditTopic(component.topics()[0]);
    component.topicName.set('Hyrule II');
    await component.saveTopic();
    expect(component.topics().find((t) => t.id === 't1')?.name).toBe('Hyrule II');
  });

  it('deleteTopic confirms then deletes', async () => {
    const topic = component.topics()[1];
    const promise = component.deleteTopic(topic);
    expect(confirm.current()).not.toBeNull();
    confirm.close(true);
    await promise;
    expect(component.topics().some((t) => t.id === topic.id)).toBe(false);
  });

  it('modelLabel resolves the default model display name', () => {
    expect(component.modelLabel('m1')).toBe('Alpha Model');
    expect(component.modelLabel(null)).toBeTruthy();
  });
});
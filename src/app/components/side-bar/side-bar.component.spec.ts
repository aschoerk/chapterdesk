import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { SideBarComponent } from './side-bar.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat/chat.service';
import { ProjectService } from '../../core/settings/project.service';
import { PersonaService } from '../../core/persona.service';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { SortPreferencesService } from '../../core/settings/sort-preferences.service';
import { NodeVersionDiffDialogService } from '../../core/dialogs/node-version-diff-dialog.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import {
  makeAttachment, makeChat, makeModel, makeNode, makePersona, makeProject, makeTopic
} from '../../../../test-helpers/factories';

const LS_EXPANDED_KEY = 'chat-client.projects.expanded';

/**
 * SideBarComponent tests. Covers rendering, the topic filter, the search box,
 * sort/collapse buttons, every per-project / per-chat action button and the
 * inline chat-title editing (inserting text, Enter / Escape / blur).
 */
describe('SideBarComponent', () => {
  let fixture: ComponentFixture<SideBarComponent>;
  let component: SideBarComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let projectService: ProjectService;
  let confirm: ConfirmService;
  let i18n: I18nService;
  let sortPrefs: SortPreferencesService;
  let textDiff: NodeVersionDiffDialogService;
  const router = { navigate: vi.fn(async () => true) };

  // ------------------------------------------------------------------
  // Seed helpers (thin aliases over the shared test-helpers factories)
  // ------------------------------------------------------------------

  const project = makeProject;
  const topic = makeTopic;
  const chat = makeChat;
  const persona = makePersona;

  /** Create the component and run ngOnInit (which loads all data). */
  async function setup(seedFn?: (a: InMemoryChatApi) => void): Promise<void> {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    localStorage.clear();
    router.navigate.mockClear();
    seedFn?.(api);

    if (!(HTMLElement.prototype as any).scrollIntoView) {
      (HTMLElement.prototype as any).scrollIntoView = () => {};
    }

    await TestBed.configureTestingModule({
      imports: [SideBarComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        { provide: Router, useValue: router }
      ]
    }).compileComponents();

    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');
    chatService = TestBed.inject(ChatService);
    projectService = TestBed.inject(ProjectService);
    confirm = TestBed.inject(ConfirmService);
    sortPrefs = TestBed.inject(SortPreferencesService);
    textDiff = TestBed.inject(NodeVersionDiffDialogService);

    fixture = TestBed.createComponent(SideBarComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  // ------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------

  function projectBlock(name: string): HTMLElement | null {
    const blocks = Array.from(
      fixture.nativeElement.querySelectorAll('.project-block') as NodeListOf<HTMLElement>
    );
    return blocks.find(b =>
      (b.querySelector('.project-name')?.textContent ?? '').trim() === name
    ) ?? null;
  }

  function chatItem(projectName: string, title: string): HTMLElement | null {
    const block = projectBlock(projectName);
    if (!block) return null;
    const items = Array.from(block.querySelectorAll('.chat-item') as NodeListOf<HTMLElement>);
    return items.find(i =>
      (i.querySelector('.chat-title')?.textContent ?? '').includes(title)
    ) ?? null;
  }

  /**
   * The persistent `.chat-item` row (identical to chatItem() but returns the
   * row even while inline-editing, when the `.chat-title` span is swapped for
   * the `.chat-title-input`). Grab it before entering edit mode and keep it.
   */
  function chatRow(projectName: string, title: string): HTMLElement | null {
    const block = projectBlock(projectName);
    if (!block) return null;
    const items = Array.from(block.querySelectorAll('.chat-item') as NodeListOf<HTMLElement>);
    return items.find(i =>
      (i.querySelector('.chat-title')?.textContent ?? '').includes(title)
    ) ?? null;
  }

  /** Find a button by its (translated) title inside a parent element. */
  function btn(parent: Element | null, i18nKey: string): HTMLButtonElement | null {
    if (!parent) return null;
    const title = i18n.t(i18nKey);
    return parent.querySelector(`button[title="${title}"]`);
  }

  function expandProject(name: string): void {
    projectBlock(name)?.querySelector('.expand-btn')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    fixture.detectChanges();
  }

  function assertExpanded(name: string, expected: boolean): void {
    expect(projectBlock(name)?.classList.contains('expanded')).toBe(expected);
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  describe('rendering', () => {
    it('renders every project name', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Alpha' }));
        a.projects.push(project({ id: 'p-2', name: 'Beta' }));
      });
      expect(projectBlock('Alpha')).not.toBeNull();
      expect(projectBlock('Beta')).not.toBeNull();
    });

    it('sorts projects by newest first by default', async () => {
      await setup(a => {
        const now = Date.now();
        a.projects.push(project({ id: 'p-z', name: 'Zeta', createdAt: new Date(now).toISOString() }));
        a.projects.push(project({ id: 'p-a', name: 'Alpha', createdAt: new Date(now - 5000).toISOString() }));
      });
      const names = component.filteredProjects().map(p => p.name);
      expect(names).toEqual(['Zeta', 'Alpha']);
    });

    it('shows the empty state when there are no projects', async () => {
      await setup();
      expect(projectBlock('any')).toBeNull();
      const empty = fixture.nativeElement.querySelector('.project-list > .empty');
      expect(empty?.textContent?.replace(/\s+/g, ' ').trim())
        .toContain(i18n.t('sidebar.noBooks'));
    });

    it('renders chat titles inside an expanded project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Chapter One', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Chapter Two', projectId: 'p-1' }));
      });
      expandProject('Env A');
      expect(chatItem('Env A', 'Chapter One')).not.toBeNull();
      expect(chatItem('Env A', 'Chapter Two')).not.toBeNull();
    });

    it('shows "no chats" for an expanded project without chats', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      const empty = projectBlock('Env A')?.querySelector('.chat-list .empty');
      expect(empty?.textContent?.replace(/\s+/g, ' ').trim())
        .toContain(i18n.t('sidebar.noChats'));
    });

    it('renders the unassigned block for chats without a project', async () => {
      await setup(a => {
        a.chats.push(chat({ id: 'c1', title: 'Loose story', projectId: null }));
      });
      fixture.detectChanges();
      const unassigned = Array.from(
        fixture.nativeElement.querySelectorAll('.project-block.unassigned') as NodeListOf<HTMLElement>
      );
      expect(unassigned.length).toBe(1);
      // Chat comes with the block collapsed; expand it.
      projectBlock(i18n.t('sidebar.unfiled'))?.querySelector('.expand-btn')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      fixture.detectChanges();
      expect(chatItem(i18n.t('sidebar.unfiled'), 'Loose story')).not.toBeNull();
    });

    it('highlights the project of the current chat and the active chat', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Active', projectId: 'p-1' }));
      });
      expandProject('Env A');
      await chatService.selectChat('c1');
      await settle();
      expect(component.isCurrentProject('p-1')).toBe(true);
      expect(chatItem('Env A', 'Active')?.classList.contains('active')).toBe(true);
      expect(projectBlock('Env A')?.querySelector('.project-header')?.classList.contains('current'))
        .toBe(true);
    });

    it('shows the topic options in the dropdown', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1', name: 'Horror' }));
        a.topics.push(topic({ id: 't-2', name: 'Fantasy' }));
      });
      const options = Array.from(
        fixture.nativeElement.querySelectorAll('.sidebar-topic-filter option') as NodeListOf<HTMLOptionElement>
      );
      expect(options.map(o => o.textContent)).toContain('Horror');
      expect(options.map(o => o.textContent)).toContain('Fantasy');
      expect(options[0]?.value).toBe('all');
    });
  });

  // ------------------------------------------------------------------
  // Expand / collapse
  // ------------------------------------------------------------------

  describe('expand & collapse', () => {
    it('expands and collapses a project via the chevron button', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expect(component.isExpanded('p-1')).toBeFalsy();
      assertExpanded('Env A', false);

      expandProject('Env A');
      expect(component.isExpanded('p-1')).toBe(true);
      assertExpanded('Env A', true);

      expandProject('Env A');
      expect(component.isExpanded('p-1')).toBe(false);
      assertExpanded('Env A', false);
    });

    it('toggles by clicking anywhere on the project header', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      projectBlock('Env A')!.querySelector('.project-header')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      fixture.detectChanges();
      expect(component.isExpanded('p-1')).toBe(true);
    });

    it('persists the expanded state to localStorage', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      const raw = localStorage.getItem(LS_EXPANDED_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)['p-1']).toBe(true);
    });

    it('restores the expanded state saved in localStorage on init', async () => {
      // seedFn runs after localStorage.clear() but before ngOnInit, so it can
      // pre-populate the persisted expanded map that ngOnInit reads back.
      await setup(a => {
        localStorage.setItem(LS_EXPANDED_KEY, JSON.stringify({ 'p-1': true }));
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expect(component.isExpanded('p-1')).toBe(true);
      expect(chatItem('Env A', 'Story 1')).not.toBeNull();
    });

    it('collapse-all collapses every project and persists', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.projects.push(project({ id: 'p-2', name: 'Beta' }));
      });
      expandProject('Env A');
      expandProject('Beta');
      expect(component.isExpanded('p-1')).toBe(true);
      expect(component.isExpanded('p-2')).toBe(true);

      const collapseBtn = fixture.nativeElement.querySelector('.collapse-all-btn') as HTMLButtonElement;
      collapseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(component.isExpanded('p-1')).toBe(false);
      expect(component.isExpanded('p-2')).toBe(false);
      expect(JSON.parse(localStorage.getItem(LS_EXPANDED_KEY) as string))
        .toEqual({ 'p-1': false, 'p-2': false });
    });
  });

  // ------------------------------------------------------------------
  // Topic filter
  // ------------------------------------------------------------------

  describe('topic filter', () => {
    it('filters the project list when a topic is selected', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'In topic' }));
        a.projects.push(project({ id: 'p-2', name: 'Out of topic' }));
        a.topics.push(topic({ id: 't-1', name: 'Horror', projectIds: ['p-1'] }));
      });
      component.selectTopicFilter('t-1');
      await settle();
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-1']);
      expect(projectBlock('In topic')).not.toBeNull();
      expect(projectBlock('Out of topic')).toBeNull();
    });

    it('persists the selected topic to localStorage', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      component.selectTopicFilter('t-1');
      expect(localStorage.getItem('chat.selectedTopicId')).toBe('t-1');
      component.selectTopicFilter('all');
      expect(localStorage.getItem('chat.selectedTopicId')).toBe('all');
    });

    it('selecting a topic through the <select> element updates the model', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1', name: 'Horror' }));
      });
      const select = fixture.nativeElement.querySelector('.sidebar-topic-filter select') as HTMLSelectElement;
      select.value = 't-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      expect(component.selectedTopicId()).toBe('t-1');
    });

    it('disables the edit-topic button while "all topics" is selected', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      const btn = fixture.nativeElement.querySelector('.sidebar-topic-filter button') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);

      component.selectTopicFilter('t-1');
      await settle();
      expect(btn.disabled).toBe(false);
    });

    it('navigates to the projects page with editTopic when a topic is selected', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      const editBtn = fixture.nativeElement.querySelector('.sidebar-topic-filter button') as HTMLButtonElement;
      component.selectTopicFilter('t-1');
      await settle();

      editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(
        ['/projects'],
        { queryParams: { editTopic: 't-1' } }
      );
    });

    it('does not navigate when no topic is selected', async () => {
      await setup(a => {
        a.topics.push(topic({ id: 't-1' }));
      });
      component.editCurrentTopic(new Event('click'));
      await settle();
      expect(router.navigate).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  describe('search', () => {
    it('filters projects whose name matches the query', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Wonderland' }));
        a.projects.push(project({ id: 'p-2', name: 'Dreams' }));
      });
      component.setSearchQuery('wonder');
      await settle();
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Wonderland']);
      expect(projectBlock('Wonderland')).not.toBeNull();
      expect(projectBlock('Dreams')).toBeNull();
    });

    it('keeps a project visible when one of its chats matches the query', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Environment' }));
        a.chats.push(chat({ id: 'c1', title: 'Dragon hunt', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Winter night', projectId: 'p-1' }));
      });
      component.setSearchQuery('dragon');
      await settle();
      // project stays because it owns a matching chat
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-1']);
      // ... but only the matching chat is listed
      expect(component.getChatsForProject('p-1').map(c => c.id)).toEqual(['c1']);
      expandProject('Environment');
      expect(chatItem('Environment', 'Dragon hunt')).not.toBeNull();
      expect(chatItem('Environment', 'Winter night')).toBeNull();
    });

    it('clears the filter when the query is emptied', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Wonderland' }));
        a.projects.push(project({ id: 'p-2', name: 'Dreams' }));
      });
      component.setSearchQuery('wonder');
      await settle();
      expect(component.filteredProjects().length).toBe(1);
      component.setSearchQuery('');
      await settle();
      expect(component.filteredProjects().length).toBe(2);
    });

    it('toggles the search-in-content flag and persists it', async () => {
      await setup();
      expect(component.searchInContent()).toBe(false);
      component.setSearchInContent(true);
      expect(component.searchInContent()).toBe(true);
      expect(localStorage.getItem('chat.sidebar.searchInContent')).toBe('1');
      component.setSearchInContent(false);
      expect(component.searchInContent()).toBe(false);
      expect(localStorage.getItem('chat.sidebar.searchInContent')).toBe('0');
    });

    it('queries the server for content hits when search-in-content is on', async () => {
      await setup(a => {
        a.chats.push(chat({ id: 'c1', title: 'Hidden', projectId: null }));
      });
      const spy = vi.spyOn(api, 'searchChatIds').mockResolvedValue(['c1']);
      vi.useFakeTimers();
      component.setSearchInContent(true);
      component.setSearchQuery('needle');
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      vi.useRealTimers();
      expect(spy).toHaveBeenCalledWith('needle');
      expect(component.contentHitIds().has('c1')).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Sort button
  // ------------------------------------------------------------------

  describe('sort', () => {
    function alphaBtn(): HTMLButtonElement {
      const btns = Array.from(
        fixture.nativeElement.querySelectorAll('.sidebar-search .sort-btn') as NodeListOf<HTMLButtonElement>
      );
      // The alphabetical button is the text-only one (no svg icon); its label
      // flips between A–Z and Z–A depending on the direction.
      return btns.find(b => !b.querySelector('svg'))!;
    }

    function updatedBtn(): HTMLButtonElement {
      const btns = Array.from(
        fixture.nativeElement.querySelectorAll('.sidebar-search .sort-btn') as NodeListOf<HTMLButtonElement>
      );
      return btns.find(b => !!b.querySelector('svg'))!;
    }

    it('defaults to newest-first (by age) and highlights the updated sort button', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expect(component.sortMode()).toBe('updated');
      expect(component.updatedDesc()).toBe(true);
      const btn = updatedBtn();
      expect(btn.classList.contains('active')).toBe(true);
      expect(btn.title).toBe(i18n.t('sort.updatedNew'));
    });

    it('toggles the alphabetical direction (A-Z → Z-A) on click', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-z', name: 'Zeta' }));
        a.projects.push(project({ id: 'p-a', name: 'Alpha' }));
      });
      // The default is newest-first; switch to alphabetical A–Z first.
      alphaBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.sortMode()).toBe('alpha');
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Alpha', 'Zeta']);

      alphaBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.alphaAsc()).toBe(false);
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Zeta', 'Alpha']);
      expect(alphaBtn().title).toBe(i18n.t('sort.alphaZA'));

      // Clicking again restores A–Z.
      alphaBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Alpha', 'Zeta']);
    });

    it('toggles newest-first / oldest-first', async () => {
      await setup(a => {
        const now = Date.now();
        a.projects.push(project({ id: 'p-old', name: 'Alpha', createdAt: new Date(now - 9000).toISOString() }));
        a.projects.push(project({ id: 'p-new', name: 'Zeta', createdAt: new Date(now).toISOString() }));
      });

      // Newest first is the default.
      expect(component.sortMode()).toBe('updated');
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Zeta', 'Alpha']);
      expect(updatedBtn().classList.contains('active')).toBe(true);
      expect(updatedBtn().title).toBe(i18n.t('sort.updatedNew'));

      updatedBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.updatedDesc()).toBe(false);
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Alpha', 'Zeta']);
      expect(updatedBtn().title).toBe(i18n.t('sort.updatedOld'));

      // Clicking again restores newest-first.
      updatedBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.updatedDesc()).toBe(true);
      expect(component.filteredProjects().map(p => p.name)).toEqual(['Zeta', 'Alpha']);
      expect(updatedBtn().title).toBe(i18n.t('sort.updatedNew'));
    });

    it('keeps sort order when a chat is merely opened (no pin)', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Alpha' }));
        a.projects.push(project({ id: 'p-2', name: 'Zeta' }));
        a.chats.push(chat({ id: 'c1', title: 'Story', projectId: 'p-2' }));
      });
      await chatService.selectChat('c1');
      await settle();
      // Opening a chat must not reorder the list.
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-1', 'p-2']);
    });

    it('pins the current project to the top when a sort button is pressed', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Alpha' }));
        a.projects.push(project({ id: 'p-2', name: 'Zeta' }));
        a.chats.push(chat({ id: 'c1', title: 'Story', projectId: 'p-2' }));
      });
      await chatService.selectChat('c1');
      await settle();

      // Press a sort button twice so the direction returns to A–Z but the
      // pin is still applied.
      alphaBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      alphaBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(component.pinnedProjectId()).toBe('p-2');
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-2', 'p-1']);
    });

    it('sorts chats by newest first within a project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Old', projectId: 'p-1', updated_at: '2020-01-01T00:00:00Z' }));
        a.chats.push(chat({ id: 'c2', title: 'New', projectId: 'p-1', updated_at: '2024-01-01T00:00:00Z' }));
      });
      expandProject('Env A');
      expect(component.getChatsForProject('p-1').map(c => c.id)).toEqual(['c2', 'c1']);
    });

    it('orders environments by their youngest chat (newest-first)', async () => {
      await setup(a => {
        const now = Date.now();
        // Alpha's project row is NEWER than Bravo's, but Bravo owns the most
        // recently touched chat — environments must follow their chats.
        a.projects.push(project({ id: 'p-a', name: 'Alpha', createdAt: new Date(now).toISOString() }));
        a.projects.push(project({ id: 'p-b', name: 'Bravo', createdAt: new Date(now - 9000).toISOString() }));
        a.chats.push(chat({ id: 'c-a', title: 'A story', projectId: 'p-a', updated_at: '2020-01-01T00:00:00Z' }));
        a.chats.push(chat({ id: 'c-b', title: 'B story', projectId: 'p-b', updated_at: '2024-01-01T00:00:00Z' }));
      });
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-b', 'p-a']);
    });

    it('orders environments by their oldest chat (oldest-first)', async () => {
      await setup(a => {
        const now = Date.now();
        // Alpha has one very new chat (2025) and one very old chat (2018);
        // Bravo's only chat is 2020. Oldest-first must rank by the OLDEST
        // chat, so Alpha (2018) precedes Bravo (2020) despite Alpha's 2025.
        a.projects.push(project({ id: 'p-a', name: 'Alpha', createdAt: new Date(now - 9000).toISOString() }));
        a.projects.push(project({ id: 'p-b', name: 'Bravo', createdAt: new Date(now - 1000).toISOString() }));
        a.chats.push(chat({ id: 'c-a1', title: 'A old', projectId: 'p-a', updated_at: '2018-01-01T00:00:00Z' }));
        a.chats.push(chat({ id: 'c-a2', title: 'A new', projectId: 'p-a', updated_at: '2025-01-01T00:00:00Z' }));
        a.chats.push(chat({ id: 'c-b', title: 'B story', projectId: 'p-b', updated_at: '2020-01-01T00:00:00Z' }));
      });
      sortPrefs.setUpdatedDesc('sidebar', false);
      await settle();
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-a', 'p-b']);
    });

    it('moves an environment up when one of its chats is updated', async () => {
      await setup(a => {
        const now = Date.now();
        a.projects.push(project({ id: 'p-a', name: 'Alpha', createdAt: new Date(now - 9000).toISOString() }));
        a.projects.push(project({ id: 'p-b', name: 'Bravo', createdAt: new Date(now - 1000).toISOString() }));
        a.chats.push(chat({ id: 'c-a', title: 'A story', projectId: 'p-a', updated_at: '2020-01-01T00:00:00Z' }));
        a.chats.push(chat({ id: 'c-b', title: 'B story', projectId: 'p-b', updated_at: '2019-01-01T00:00:00Z' }));
      });
      // Newest chat: Alpha (2020) before Bravo (2019).
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-a', 'p-b']);

      // Editing a chat patches its updated_at (server returns a fresh stamp) —
      // Bravo's youngest chat is now "now" → Bravo jumps to the top.
      await chatService.updateChatTitle('c-b', 'B story edited');
      await settle();
      expect(component.filteredProjects().map(p => p.id)).toEqual(['p-b', 'p-a']);
    });
  });

  // ------------------------------------------------------------------
  // Project actions
  // ------------------------------------------------------------------

  describe('project actions', () => {
    it('edit-project button navigates to /projects with editProject query param', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      const edit = btn(projectBlock('Env A'), 'sidebar.editEnvironment')!;
      edit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(
        ['/projects'],
        { queryParams: { editProject: 'p-1' } }
      );
    });

    it('edit-project stops propagation (project stays expanded)', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      expandProject('Env A');
      btn(projectBlock('Env A'), 'sidebar.editEnvironment')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      assertExpanded('Env A', true);
    });

    it('startEditProject (double click on name) records the project for inline editing', async () => {
      await setup(a => {
        a.projects.push(project({
          id: 'p-1',
          systemPrompt: 'You are a bard',
          defaultModelId: 'm-1'
        }));
      });
      const nameEl = projectBlock('Env A')!.querySelector('.project-name')!;
      nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      fixture.detectChanges();
      expect(component.editingProjectId()).toBe('p-1');
      expect(component.editName()).toBe('Env A');
      expect(component.editSystemPrompt()).toBe('You are a bard');
      expect(component.editDefaultModelId()).toBe('m-1');
    });

    it('create-chat button creates a story with seed nodes, expands and selects it', async () => {
      await setup(a => {
        a.projects.push(project({
          id: 'p-1',
          systemPrompt: 'You are a world-building assistant.',
          greeting: 'Welcome',
          defaultModelId: 'm-1'
        }));
        a.models.push(makeModel({ id: 'm-1' }));
      });
      const newBtn = btn(projectBlock('Env A'), 'sidebar.newStory')!;
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(api.chats.length).toBe(1);
      const created = api.chats[0];
      expect(created.title).toBe(i18n.t('sidebar.newChatTitle', { name: 'Env A' }));
      expect(created.projectId).toBe('p-1');
      // user + greeting assistant nodes injected by buildSeedNodeDrafts
      // (selectChat may add an extra root draft leaf, so assert the seeds exist)
      const nodes = api.nodes.filter(n => n.chatId === created.id);
      const userNode = nodes.find(n => n.role === 'user' && n.content.includes('world-building'));
      const greetingNode = nodes.find(n => n.role === 'assistant' && n.content.includes('Welcome'));
      expect(userNode).toBeDefined();
      expect(greetingNode).toBeDefined();
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      expect(component.currentChatId()).toBe(created.id);
      expect(component.isExpanded('p-1')).toBe(true);
    });

    it('create-chat seeds the system node from the sidebar-selected topic only', async () => {
      await setup(a => {
        a.projects.push(project({
          id: 'p-1',
          systemPrompt: 'You are a world-building assistant.',
          greeting: 'Welcome'
        }));
        a.topics.push(makeTopic({
          id: 't-a',
          name: 'Gothic',
          defaultSystemPrompt: 'Prompt A',
          projectIds: ['p-1']
        }));
        a.topics.push(makeTopic({
          id: 't-b',
          name: 'Epic',
          defaultSystemPrompt: 'Prompt B',
          projectIds: ['p-1']
        }));
      });
      component.selectTopicFilter('t-a');
      const newBtn = btn(projectBlock('Env A'), 'sidebar.newStory')!;
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const nodes = api.nodes.filter(n => n.chatId === api.chats[0].id);
      const systemNode = nodes.find(n => n.role === 'system');
      expect(systemNode).toBeDefined();
      expect(systemNode!.content).toBe('Prompt A');
      expect(systemNode!.content).not.toContain('Prompt B');
    });

    it('creates a chat through the chat service (inserting into the list)', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
      });
      await component.createChatForProject(component.projects()[0]);
      await settle();
      expect(chatService.chats().some(c => c.projectId === 'p-1')).toBe(true);
      expect(api.chats.length).toBe(1);
    });

    it('delete-project with confirmation removes the project and its chats', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story', projectId: 'p-1' }));
      });
      const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
      btn(projectBlock('Env A'), 'sidebar.deleteBook')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(ask).toHaveBeenCalled();
      expect(projectService.projects().find(p => p.id === 'p-1')).toBeUndefined();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeUndefined();
      expect(projectBlock('Env A')).toBeNull();
    });

    it('delete-project keeps everything when the confirmation is dismissed', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story', projectId: 'p-1' }));
      });
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      btn(projectBlock('Env A'), 'sidebar.deleteBook')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(projectService.projects().find(p => p.id === 'p-1')).toBeDefined();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Chat actions
  // ------------------------------------------------------------------

  describe('chat actions', () => {
    it('selects a chat on click and expands its project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Story 2', projectId: 'p-1' }));
      });
      expandProject('Env A');
      chatItem('Env A', 'Story 2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.currentChatId()).toBe('c2');
      expect(component.isExpanded('p-1')).toBe(true);
    });

    it('unassign button moves a chat out of its project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const unassign = btn(chatItem('Env A', 'Story 1'), 'sidebar.moveUnassigned')!;
      unassign.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBeNull();
      expect(component.getChatsForProject('p-1').length).toBe(0);
    });

    it('reassign button toggles the dropdown, and choosing a project moves the chat', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.projects.push(project({ id: 'p-2', name: 'Env B' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const move = btn(chatItem('Env A', 'Story 1'), 'sidebar.moveEnvironment')!;
      move.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(component.reassigningChatId()).toBe('c1');

      const dropdown = chatItem('Env A', 'Story 1')!.closest('.chat-item')!
        .parentElement!.querySelector('.reassign-dropdown') as HTMLElement;
      expect(dropdown).not.toBeNull();
      const select = dropdown.querySelector('.reassign-select') as HTMLSelectElement;
      expect(select).not.toBeNull();

      select.value = 'p-2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();

      expect(component.reassigningChatId()).toBeNull();
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-2');
    });

    it('clone button duplicates the chat (including nodes) into the same project', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Original', projectId: 'p-1', node_number: 1 }));
        a.nodes.push({
          id: 'n1', chatId: 'c1', parentId: null, role: 'user',
          content: 'hello', version: 1, isCurrent: true, createdAt: new Date().toISOString()
        } as any);
      });
      expandProject('Env A');
      const clone = btn(chatItem('Env A', 'Original'), 'sidebar.cloneStory')!;
      clone.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(api.chats.length).toBe(2);
      const copy = api.chats.find(c => c.id !== 'c1')!;
      expect(copy.title).toContain('(copy)');
      expect(copy.projectId).toBe('p-1');
      // The cloned story keeps its original node; selecting the copy appends
      // an empty composer leaf so the active path always ends on a draft.
      const copyNodes = api.nodes.filter(n => n.chatId === copy.id);
      expect(copyNodes.map(n => n.content).filter(Boolean)).toContain('hello');
      expect(copyNodes.some(n => n.role === 'user' && !n.content?.trim())).toBe(true);
    });

    it('delete-chat removes the chat after confirmation', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      vi.spyOn(confirm, 'ask').mockResolvedValue(true);
      btn(chatItem('Env A', 'Story 1'), 'common.delete')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeUndefined();
    });

    it('delete-chat keeps the chat when the confirmation is dismissed', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      btn(chatItem('Env A', 'Story 1'), 'common.delete')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Inline chat-title editing (inserting into the input)
  // ------------------------------------------------------------------

  describe('inline chat-title editing', () => {
    it('rename button enters edit mode with the current title prefilled', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      const rename = btn(row, 'sidebar.renameStory')!;
      rename.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(component.editingChatId()).toBe('c1');
      expect(component.titleDraft()).toBe('Story 1');
      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('Story 1');
    });

    it('types into the input (inserting text) and saves with Enter', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Renamed Story';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      expect(component.titleDraft()).toBe('Renamed Story');

      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();

      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Renamed Story');
      expect(component.editingChatId()).toBeNull();
      expect(chatItem('Env A', 'Renamed Story')).not.toBeNull();
    });

    it('trims whitespace and ignores blank renames', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const spy = vi.spyOn(chatService, 'updateChatTitle');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = '   Padded   ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(spy).toHaveBeenCalledWith('c1', 'Padded');

      // blank → not saved (re-enter edit mode on the saved title)
      const row2 = chatRow('Env A', 'Padded')!;
      btn(row2, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const input2 = row2.querySelector('.chat-title-input') as HTMLInputElement;
      input2.value = '   ';
      input2.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input2.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Padded');
    });

    it('cancels editing with Escape without saving', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Should not stick';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
      await settle();

      expect(component.editingChatId()).toBeNull();
      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Story 1');
    });

    it('saves on blur', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Via Blur';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      await settle();

      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Via Blur');
    });

    it('does not save when the title is unchanged', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
      });
      expandProject('Env A');
      const spy = vi.spyOn(chatService, 'updateChatTitle');
      const row = chatRow('Env A', 'Story 1')!;
      btn(row, 'sidebar.renameStory')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const input = row.querySelector('.chat-title-input') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(spy).not.toHaveBeenCalled();
      expect(component.editingChatId()).toBeNull();
    });

    it('renames a chat in the unassigned block too', async () => {
      await setup(a => {
        a.chats.push(chat({ id: 'c1', title: 'Loose', projectId: null }));
      });
      const unassigned = projectBlock(i18n.t('sidebar.unfiled'))!;
      unassigned.querySelector('.expand-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      const item = chatItem(i18n.t('sidebar.unfiled'), 'Loose')!;
      btn(item, 'sidebar.renameStory')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const input = item.querySelector('.chat-title-input') as HTMLInputElement;
      input.value = 'Tight';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      await settle();
      expect(chatService.chats().find(c => c.id === 'c1')?.title).toBe('Tight');
    });
  });

  // ------------------------------------------------------------------
  // Persona navigation
  // ------------------------------------------------------------------

  describe('persona navigation', () => {
    it('avatar click navigates to the personas page', async () => {
      await setup(a => {
        a.personas.push(persona({ id: 'pers-1', name: 'Author' }));
      });
      TestBed.inject(PersonaService).setCurrentPersona('pers-1');
      fixture.detectChanges();
      const avatar = fixture.nativeElement.querySelector('.current-persona-avatar') as HTMLElement;
      expect(avatar).not.toBeNull();
      avatar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(['/personas']);
    });

    it('goToPersonas navigates to the personas page', async () => {
      await setup();
      await component.goToPersonas();
      await settle();
      expect(router.navigate).toHaveBeenCalledWith(['/personas']);
    });
  });

  // ------------------------------------------------------------------
  // Story multi-selection & move (Ctrl+click, cut&paste, drag&drop)
  // ------------------------------------------------------------------

  describe('story multi-selection & move', () => {
    async function seedTwoEnvs(): Promise<void> {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.projects.push(project({ id: 'p-2', name: 'Env B' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Story 2', projectId: 'p-1' }));
        // An unassigned chat so the "Unfiled stories" block is present.
        a.chats.push(chat({ id: 'c3', title: 'Loose', projectId: null }));
      });
      expandProject('Env A');
      expandProject('Env B');
    }

    async function compareNodeSets(leftNodes: ReturnType<typeof makeNode>[], rightNodes: ReturnType<typeof makeNode>[]) {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Story 2', projectId: 'p-1' }));
        a.nodes.push(...leftNodes, ...rightNodes);
      });
      expandProject('Env A');
      ctrlClickStory('Env A', 'Story 1');
      ctrlClickStory('Env A', 'Story 2');
      await component.compareSelectedChats();
      return component.chatComparison();
    }

    /** Drain the full microtask chain (deep async handlers) via a macrotask. */
    const flush = () => new Promise<void>((res) => setTimeout(res, 0));

    /** flush() + settle(): wait for async handlers AND refresh the DOM. */
    async function settleDeep(): Promise<void> {
      await flush();
      await settle();
    }

    function ctrlClickStory(projectName: string, title: string): HTMLElement {
      const item = chatItem(projectName, title)!;
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      fixture.detectChanges();
      return item;
    }

    function storyTools(): HTMLElement | null {
      return fixture.nativeElement.querySelector('.story-tools') as HTMLElement | null;
    }

    function contextMenu(): HTMLElement | null {
      return fixture.nativeElement.querySelector('.sidebar-context-menu') as HTMLElement | null;
    }

    function rightClick(target: Element): MouseEvent {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 90
      });
      target.dispatchEvent(event);
      fixture.detectChanges();
      return event;
    }

    function clickContextItem(label: string): void {
      const buttons = Array.from(contextMenu()?.querySelectorAll('button') ?? []);
      const button = buttons.find(candidate => candidate.textContent?.trim() === label);
      expect(button, `context menu item '${label}'`).toBeDefined();
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
    }

    function clickTool(i18nKey: string): void {
      (storyTools()!.querySelector(`button[title="${i18n.t(i18nKey)}"]`) as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
    }

    /** jsdom has no DragEvent/DataTransfer — an event-shaped stand-in. */
    function dragEvent(extra: Record<string, unknown> = {}): DragEvent {
      const transferOverride = extra['dataTransfer'] ?? {};
      return {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          effectAllowed: '',
          dropEffect: '',
          setData: vi.fn(),
          getData: () => '',
          ...(transferOverride as object)
        },
        ...extra
      } as unknown as DragEvent;
    }

    it('Ctrl+click marks a story without opening it', async () => {
      await seedTwoEnvs();
      const item = ctrlClickStory('Env A', 'Story 1');
      expect(item.classList.contains('selected')).toBe(true);
      expect(chatService.currentChatId()).toBeNull();
      expect(component.selectedChatIds()).toEqual(['c1']);
    });

    it('Ctrl+click toggles the mark off on a second click', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      const item = ctrlClickStory('Env A', 'Story 1');
      expect(item.classList.contains('selected')).toBe(false);
      expect(component.selectedChatIds()).toEqual([]);
    });

    it('marks multiple stories via Ctrl+click', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      ctrlClickStory('Env A', 'Story 2');
      expect(component.selectedChatIds()).toEqual(['c1', 'c2']);
      expect(chatItem('Env A', 'Story 2')?.classList.contains('selected')).toBe(true);
    });

    it('plain click opens the story and keeps the mark', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      chatItem('Env A', 'Story 2')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      await settle();
      expect(chatService.currentChatId()).toBe('c2');
      expect(component.selectedChatIds()).toEqual(['c1']);
    });

    it('shows a toolbar with the selection count', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      ctrlClickStory('Env A', 'Story 2');
      expect(storyTools()).not.toBeNull();
      expect(storyTools()!.textContent)
        .toContain(i18n.t('sidebar.selectedCount', { count: 2 }));
    });

    it('opens an environment context menu with the corresponding environment button actions', async () => {
      await seedTwoEnvs();
      const header = projectBlock('Env A')!.querySelector('.project-header')!;
      const event = rightClick(header);

      expect(event.defaultPrevented).toBe(true);
      const menu = contextMenu()!;
      const labels = Array.from(menu.querySelectorAll('button')).map(button => button.textContent?.trim());
      expect(labels).toContain(i18n.t('sidebar.editEnvironment'));
      expect(labels).toContain(i18n.t('sidebar.newStory'));
      expect(labels).toContain(i18n.t('sidebar.deleteBook'));

      clickContextItem(i18n.t('sidebar.editEnvironment'));
      expect(router.navigate).toHaveBeenCalledWith(['/projects'], { queryParams: { editProject: 'p-1' } });
      expect(contextMenu()).toBeNull();
    });

    it('opens a chat context menu with that chat’s button actions', async () => {
      await seedTwoEnvs();
      const row = chatItem('Env A', 'Story 1')!;
      rightClick(row);

      const labels = Array.from(contextMenu()!.querySelectorAll('button')).map(button => button.textContent?.trim());
      expect(labels).toContain(i18n.t('sidebar.moveUnassigned'));
      expect(labels).toContain(i18n.t('sidebar.renameStory'));
      expect(labels).toContain(i18n.t('sidebar.moveEnvironment'));
      expect(labels).toContain(i18n.t('sidebar.cloneStory'));
      expect(labels).toContain(i18n.t('sidebar.sumTotalCost'));
      expect(labels).toContain(i18n.t('common.delete'));

      clickContextItem(i18n.t('sidebar.renameStory'));
      expect(component.editingChatId()).toBe('c1');
      expect(contextMenu()).toBeNull();
    });

    it('offers a chat’s own reader-variant comparison only when no chats are selected', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.chats.push(chat({ id: 'c1', title: 'Forked story', projectId: 'p-1' }));
        a.nodes.push(
          makeNode({ id: 'root', chatId: 'c1', role: 'user', content: 'Start', position: 1 }),
          makeNode({ id: 'branch-a', chatId: 'c1', parentId: 'root', role: 'assistant', content: 'Reader A', position: 1 }),
          makeNode({ id: 'branch-b', chatId: 'c1', parentId: 'root', role: 'assistant', content: 'Reader B', position: 2 })
        );
      });
      expandProject('Env A');
      rightClick(chatItem('Env A', 'Forked story')!);
      const actionLabel = i18n.t('sidebar.compareChatVariants');
      expect(Array.from(contextMenu()!.querySelectorAll('button')).map(button => button.textContent?.trim()))
        .toContain(actionLabel);

      const openSpy = vi.spyOn(textDiff, 'open').mockResolvedValue(null);
      clickContextItem(actionLabel);
      await settleDeep();
      expect(openSpy).toHaveBeenCalledOnce();
      expect(openSpy.mock.calls[0][0].texts).toHaveLength(2);
      expect(openSpy.mock.calls[0][0].modifiedTexts).toHaveLength(2);
      expect(openSpy.mock.calls[0][0].texts?.[0].text).toContain('Reader A');
      expect(openSpy.mock.calls[0][0].texts?.[1].text).toContain('Reader B');

      ctrlClickStory('Env A', 'Forked story');
      rightClick(chatItem('Env A', 'Forked story')!);
      expect(Array.from(contextMenu()!.querySelectorAll('button')).map(button => button.textContent?.trim()))
        .not.toContain(actionLabel);
    });

    it('removes excluded sections through the chat context menu and preserves following content', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1', node_number: 3 }));
        a.nodes.push(
          makeNode({ id: 'root', chatId: 'c1', role: 'assistant', content: 'Opening', parentId: null }),
          makeNode({ id: 'excluded', chatId: 'c1', role: 'user', content: 'Hidden directive', parentId: 'root', excludeFromContext: true }),
          makeNode({ id: 'answer', chatId: 'c1', role: 'assistant', content: 'Keep this answer', parentId: 'excluded' })
        );
      });
      expandProject('Env A');
      rightClick(chatItem('Env A', 'Story 1')!);

      const label = i18n.t('sidebar.removeExcludedNodes');
      expect(Array.from(contextMenu()!.querySelectorAll('button')).map(button => button.textContent?.trim()))
        .toContain(label);
      clickContextItem(label);
      await settleDeep();

      const nodes = await chatService.fetchNodes('c1');
      expect(nodes.some(node => node.id === 'excluded')).toBe(false);
      expect(nodes.find(node => node.id === 'answer')?.parentId).toBe('root');
      expect(chatService.chats().find(item => item.id === 'c1')?.node_number).toBe(2);
    });

    it('adds selected-chat clipboard actions to the sidebar context menu and compare only for two selections', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      rightClick(projectBlock('Env A')!.querySelector('.project-header')!);
      let labels = Array.from(contextMenu()!.querySelectorAll('button')).map(button => button.textContent?.trim());
      expect(labels).toContain(i18n.t('sidebar.copySelected'));
      expect(labels).toContain(i18n.t('sidebar.cutSelected'));
      expect(labels).toContain(i18n.t('sidebar.clearSelection'));
      expect(labels).not.toContain(i18n.t('sidebar.compareSelected'));
      component.closeContextMenu();

      ctrlClickStory('Env A', 'Story 2');
      rightClick(chatItem('Env A', 'Story 1')!);
      labels = Array.from(contextMenu()!.querySelectorAll('button')).map(button => button.textContent?.trim());
      expect(labels).toContain(i18n.t('sidebar.compareSelected'));
      expect(labels).toContain(i18n.t('sidebar.compareReaderViews'));
      expect(labels).toContain(i18n.t('sidebar.copySelected'));
      clickContextItem(i18n.t('sidebar.compareSelected'));
      await settleDeep();
      expect(component.chatComparison()).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: true,
        attachmentsIdentical: true
      });

      rightClick(chatItem('Env A', 'Story 1')!);
      clickContextItem(i18n.t('sidebar.copySelected'));
      expect(component.clipboard.hasContent()).toBe(true);
    });

    it('adds staged clipboard cancellation to the context menu', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.cutSelectedTitle');
      rightClick(projectBlock('Env B')!.querySelector('.project-header')!);

      expect(Array.from(contextMenu()!.querySelectorAll('button')).map(button => button.textContent?.trim()))
        .toContain(i18n.t('sidebar.cancelClipboard'));
      clickContextItem(i18n.t('sidebar.cancelClipboard'));
      expect(component.clipboard.hasContent()).toBe(false);
    });

    it('prepends the current topic system prompt and nests existing root nodes beneath it', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A', mainTopicId: 't-1' }));
        a.topics.push(topic({ id: 't-1', name: 'Topic A', projectIds: ['p-1'], defaultSystemPrompt: 'Topic rules' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1', node_number: 2 }));
        a.nodes.push(
          makeNode({ id: 'root-user', chatId: 'c1', role: 'user', content: 'Opening direction', parentId: null }),
          makeNode({ id: 'root-answer', chatId: 'c1', role: 'assistant', content: 'Opening answer', parentId: null, position: 2 })
        );
      });

      await component.prependProjectSystemPrompt(chatService.chats().find(item => item.id === 'c1')!);
      const nodes = await chatService.fetchNodes('c1');
      const system = nodes.find(node => node.role === 'system')!;

      expect(system.content).toBe('Topic rules');
      expect(system.parentId).toBeNull();
      expect(nodes.find(node => node.id === 'root-user')?.parentId).toBe(system.id);
      expect(nodes.find(node => node.id === 'root-answer')?.parentId).toBe(system.id);
      expect(chatService.chats().find(item => item.id === 'c1')?.node_number).toBe(3);
    });

    it('updates an existing root system prompt to the current topic prompt without adding a node', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A', mainTopicId: 't-1' }));
        a.topics.push(topic({ id: 't-1', name: 'Topic A', projectIds: ['p-1'], defaultSystemPrompt: 'Updated topic rules' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1', node_number: 2 }));
        a.nodes.push(
          makeNode({ id: 'system-root', chatId: 'c1', role: 'system', content: 'Old prompt text', parentId: null }),
          makeNode({ id: 'user-root', chatId: 'c1', role: 'user', content: 'Opening direction', parentId: 'system-root' })
        );
      });

      await component.prependProjectSystemPrompt(chatService.chats().find(item => item.id === 'c1')!);
      const nodes = await chatService.fetchNodes('c1');

      expect(nodes).toHaveLength(2);
      expect(nodes.find(node => node.id === 'system-root')?.content).toBe('Updated topic rules');
      expect(nodes.find(node => node.id === 'user-root')?.parentId).toBe('system-root');
      expect(chatService.chats().find(item => item.id === 'c1')?.node_number).toBe(2);
    });

    it('corrects a stale node_number from the actual non-deleted node count', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1', node_number: 99 }));
        a.nodes.push(
          makeNode({ id: 'node-1', chatId: 'c1' }),
          makeNode({ id: 'node-2', chatId: 'c1', parentId: 'node-1' })
        );
      });
      const story = chatService.chats().find(item => item.id === 'c1')!;

      await component.repairChatNodeNumber(story);

      expect(chatService.chats().find(item => item.id === 'c1')?.node_number).toBe(2);
      expect(api.chats.find(item => item.id === 'c1')?.node_number).toBe(2);
    });

    it('attaches parentless and dangling-parent current nodes beneath a system node', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A', mainTopicId: 't-1' }));
        a.topics.push(topic({ id: 't-1', name: 'Topic A', projectIds: ['p-1'], defaultSystemPrompt: 'Topic rules' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1', node_number: 2 }));
        a.nodes.push(
          makeNode({ id: 'system-root', chatId: 'c1', role: 'system', content: 'Topic rules', parentId: null }),
          makeNode({ id: 'root-without-parent', chatId: 'c1', role: 'assistant', content: 'Orphan root', parentId: null }),
          makeNode({ id: 'dangling-parent', chatId: 'c1', role: 'user', content: 'Dangling orphan', parentId: 'missing-parent' })
        );
      });

      await component.attachOrphanRootsToSystemPrompt(chatService.chats().find(item => item.id === 'c1')!);
      const nodes = await chatService.fetchNodes('c1');

      expect(nodes.find(node => node.id === 'root-without-parent')?.parentId).toBe('system-root');
      expect(nodes.find(node => node.id === 'dangling-parent')?.parentId).toBe('system-root');
      expect(chatService.chats().find(item => item.id === 'c1')?.node_number).toBe(3);
    });

    it('opens a read-only Monaco diff for the two reader views', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Story 2', projectId: 'p-1' }));
        a.nodes.push(
          makeNode({ id: 'a-system', chatId: 'c1', role: 'system', content: 'Rules', parentId: null }),
          makeNode({ id: 'a-user', chatId: 'c1', role: 'user', content: 'Direction', parentId: 'a-system' }),
          makeNode({ id: 'a-answer', chatId: 'c1', role: 'assistant', content: '# Chapter\n\nHello reader.', parentId: 'a-user' }),
          makeNode({ id: 'a-fork', chatId: 'c1', role: 'user', content: 'Alternate direction', parentId: 'a-system', position: 2 }),
          makeNode({ id: 'a-fork-answer', chatId: 'c1', role: 'assistant', content: '# Alternate\n\nAlternate reader.', parentId: 'a-fork' }),
          makeNode({ id: 'b-system', chatId: 'c2', role: 'system', content: 'Rules', parentId: null }),
          makeNode({ id: 'b-user', chatId: 'c2', role: 'user', content: 'Direction', parentId: 'b-system' }),
          makeNode({ id: 'b-answer', chatId: 'c2', role: 'assistant', content: '# Chapter\n\nDifferent reader text.', parentId: 'b-user' }),
          makeNode({ id: 'b-fork', chatId: 'c2', role: 'user', content: 'Alternate direction', parentId: 'b-system', position: 2 }),
          makeNode({ id: 'b-fork-answer', chatId: 'c2', role: 'assistant', content: '# Alternate\n\nDifferent alternate reader.', parentId: 'b-fork' })
        );
      });
      component.selectedChatIds.set(['c1', 'c2']);
      const openSpy = vi.spyOn(textDiff, 'open').mockResolvedValue(null);

      await component.compareSelectedReaderViews();

      expect(openSpy).toHaveBeenCalledOnce();
      const state = openSpy.mock.calls[0][0];
      expect(state.readOnly).toBe(true);
      expect(state.originalLabel).toBe('Story 1');
      expect(state.modifiedLabel).toBe('Story 2');
      expect(state.texts).toHaveLength(2);
      expect(state.modifiedTexts).toHaveLength(2);
      expect(state.texts?.[0].text).toContain('# Chapter\n\nHello reader.');
      expect(state.texts?.[1].text).toContain('# Alternate\n\nAlternate reader.');
      expect(state.texts?.[0].text).not.toContain('<h1>');
      expect(state.modifiedTexts?.[0].text).toContain('Different reader text.');
      expect(state.modifiedTexts?.[1].text).toContain('Different alternate reader.');
      expect(state.newText).toBe(state.modifiedTexts?.[0].text);
    });

    it('pastes staged stories through the target environment context menu', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.cutSelectedTitle');
      rightClick(projectBlock('Env B')!.querySelector('.project-header')!);
      clickContextItem(component.pasteHereTitle('p-2'));
      await settleDeep();

      expect(chatService.chats().find(candidate => candidate.id === 'c1')?.projectId).toBe('p-2');
      expect(component.clipboard.hasContent()).toBe(false);
    });

    it('closes the sidebar context menu on Escape', async () => {
      await seedTwoEnvs();
      rightClick(projectBlock('Env A')!.querySelector('.project-header')!);
      expect(contextMenu()).not.toBeNull();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();

      expect(contextMenu()).toBeNull();
    });

    it('compares the selected chats by structure, content, and attachment data', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.chats.push(chat({ id: 'c1', title: 'Story 1', projectId: 'p-1' }));
        a.chats.push(chat({ id: 'c2', title: 'Story 2', projectId: 'p-1' }));
        a.nodes.push(
          makeNode({ id: 'a-root', chatId: 'c1', role: 'user', content: 'Same direction', position: 1 }),
          makeNode({ id: 'a-answer', chatId: 'c1', parentId: 'a-root', role: 'assistant', content: 'Same answer', position: 1,
            attachments: [makeAttachment({ id: 'a-file', dataUrl: 'data:text/plain;base64,c2FtZQ==' })] }),
          makeNode({ id: 'b-root', chatId: 'c2', role: 'user', content: 'Same direction', position: 1 }),
          makeNode({ id: 'b-answer', chatId: 'c2', parentId: 'b-root', role: 'assistant', content: 'Different answer', position: 1,
            attachments: [makeAttachment({ id: 'b-file', dataUrl: 'data:text/plain;base64,ZGlmZmVyZW50' })] })
        );
      });
      expandProject('Env A');
      ctrlClickStory('Env A', 'Story 1');
      ctrlClickStory('Env A', 'Story 2');
      expect(storyTools()?.querySelector(`button[title="${i18n.t('sidebar.compareSelectedTitle')}"]`)).not.toBeNull();

      await component.compareSelectedChats();
      fixture.detectChanges();

      expect(component.chatComparison()).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: false,
        attachmentsIdentical: false
      });
      const result = fixture.nativeElement.querySelector('.chat-comparison') as HTMLElement;
      expect(result.textContent).toContain(i18n.t('sidebar.compareStructureSame'));
      expect(result.textContent).toContain(i18n.t('sidebar.compareVersionsSame'));
      expect(result.textContent).toContain(i18n.t('sidebar.compareContentDifferent'));
      expect(result.textContent).toContain(i18n.t('sidebar.compareAttachmentsDifferent'));
    });

    it('treats two empty chats as identical in all comparison dimensions', async () => {
      const result = await compareNodeSets([], []);
      expect(result).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: true,
        attachmentsIdentical: true
      });
    });

    it('marks the structure different when a node has a different child count', async () => {
      const left = [
        makeNode({ id: 'left-root', chatId: 'c1', content: 'Root', role: 'user', position: 1 }),
        makeNode({ id: 'left-child-1', chatId: 'c1', parentId: 'left-root', content: 'First', role: 'assistant', position: 1 }),
        makeNode({ id: 'left-child-2', chatId: 'c1', parentId: 'left-root', content: 'Second', role: 'assistant', position: 2 })
      ];
      const right = [
        makeNode({ id: 'right-root', chatId: 'c2', content: 'Root', role: 'user', position: 1 }),
        makeNode({ id: 'right-child-1', chatId: 'c2', parentId: 'right-root', content: 'First', role: 'assistant', position: 1 })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: false,
        olderVersionsIdentical: false,
        contentsIdentical: false,
        attachmentsIdentical: false
      });
    });

    it('marks the structure different when matching nodes have different version-chain lengths', async () => {
      const left = [
        makeNode({ id: 'left-question', chatId: 'c1', role: 'user', content: 'Question', position: 1 }),
        makeNode({ id: 'left-old', chatId: 'c1', parentId: 'left-question', role: 'assistant', content: 'Old answer',
          version: 1, isCurrent: false, position: 1 }),
        makeNode({ id: 'left-current', chatId: 'c1', parentId: 'left-question', role: 'assistant', content: 'Current answer',
          version: 2, previousVersionId: 'left-old', isCurrent: true, position: 1 })
      ];
      const right = [
        makeNode({ id: 'right-question', chatId: 'c2', role: 'user', content: 'Question', position: 1 }),
        makeNode({ id: 'right-current', chatId: 'c2', parentId: 'right-question', role: 'assistant', content: 'Current answer',
          version: 1, isCurrent: true, position: 1 })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: false,
        olderVersionsIdentical: false,
        contentsIdentical: false,
        attachmentsIdentical: false
      });
    });

    it('reports older versions separately when the current nodes match', async () => {
      const left = [
        makeNode({ id: 'left-question', chatId: 'c1', role: 'user', content: 'Question', position: 1 }),
        makeNode({ id: 'left-old', chatId: 'c1', parentId: 'left-question', role: 'assistant', content: 'Earlier wording',
          version: 1, isCurrent: false, position: 1 }),
        makeNode({ id: 'left-current', chatId: 'c1', parentId: 'left-question', role: 'assistant', content: 'Current answer',
          version: 2, previousVersionId: 'left-old', isCurrent: true, position: 1 })
      ];
      const right = [
        makeNode({ id: 'right-question', chatId: 'c2', role: 'user', content: 'Question', position: 1 }),
        makeNode({ id: 'right-old', chatId: 'c2', parentId: 'right-question', role: 'assistant', content: 'Different prior wording',
          version: 1, isCurrent: false, position: 1 }),
        makeNode({ id: 'right-current', chatId: 'c2', parentId: 'right-question', role: 'assistant', content: 'Current answer',
          version: 2, previousVersionId: 'right-old', isCurrent: true, position: 1 })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: false,
        contentsIdentical: true,
        attachmentsIdentical: true
      });
    });

    it('compares contents and attachments only after matching branch counts and versions', async () => {
      const left = [
        makeNode({ id: 'left-root', chatId: 'c1', role: 'user', content: 'Root', position: 1 }),
        makeNode({ id: 'left-a', chatId: 'c1', parentId: 'left-root', role: 'assistant', content: 'A', position: 1 }),
        makeNode({ id: 'left-b', chatId: 'c1', parentId: 'left-root', role: 'assistant', content: 'B', position: 2 })
      ];
      const right = [
        makeNode({ id: 'right-root', chatId: 'c2', role: 'user', content: 'Root', position: 1 }),
        makeNode({ id: 'right-a', chatId: 'c2', parentId: 'right-root', role: 'assistant', content: 'A changed', position: 1 }),
        makeNode({ id: 'right-b', chatId: 'c2', parentId: 'right-root', role: 'assistant', content: 'B', position: 2 })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: false,
        attachmentsIdentical: true
      });
    });

    it('keeps matching fork structure when only an attachment payload differs', async () => {
      const left = [
        makeNode({ id: 'left-root', chatId: 'c1', role: 'assistant', content: 'Same', position: 1,
          attachments: [makeAttachment({ id: 'left-file', dataUrl: 'data:text/plain;base64,b25l' })] })
      ];
      const right = [
        makeNode({ id: 'right-root', chatId: 'c2', role: 'assistant', content: 'Same', position: 1,
          attachments: [makeAttachment({ id: 'right-file', dataUrl: 'data:text/plain;base64,dHdv' })] })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: true,
        attachmentsIdentical: false
      });
    });

    it('treats equivalent linear chats without forks as identical despite different ids', async () => {
      const left = [
        makeNode({ id: 'l-q1', chatId: 'c1', role: 'user', content: 'Direction', position: 1 }),
        makeNode({ id: 'l-a1', chatId: 'c1', parentId: 'l-q1', role: 'assistant', content: 'Answer', position: 1,
          attachments: [makeAttachment({ id: 'left-attachment' })] }),
        makeNode({ id: 'l-q2', chatId: 'c1', parentId: 'l-a1', role: 'user', content: 'Next direction', position: 1 })
      ];
      const right = [
        makeNode({ id: 'r-q1', chatId: 'c2', role: 'user', content: 'Direction', position: 1 }),
        makeNode({ id: 'r-a1', chatId: 'c2', parentId: 'r-q1', role: 'assistant', content: 'Answer', position: 1,
          attachments: [makeAttachment({ id: 'right-attachment' })] }),
        makeNode({ id: 'r-q2', chatId: 'c2', parentId: 'r-a1', role: 'user', content: 'Next direction', position: 1 })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: true,
        attachmentsIdentical: true
      });
    });

    it('treats matching forks nested after earlier forks as identical', async () => {
      const tree = (prefix: string, chatId: string) => {
        const q = `${prefix}-q`;
        const a = `${prefix}-a`;
        const forkA = `${prefix}-fork-a`;
        const forkB = `${prefix}-fork-b`;
        const forkAnswerA = `${prefix}-fork-answer-a`;
        const forkAnswerB = `${prefix}-fork-answer-b`;
        const nestedA = `${prefix}-nested-a`;
        const nestedB = `${prefix}-nested-b`;
        return [
          makeNode({ id: q, chatId, role: 'user', content: 'Start', position: 1 }),
          makeNode({ id: a, chatId, parentId: q, role: 'assistant', content: 'Opening', position: 1 }),
          makeNode({ id: forkA, chatId, parentId: a, role: 'user', content: 'First fork', position: 1 }),
          makeNode({ id: forkB, chatId, parentId: a, role: 'user', content: 'Alternate fork', position: 2 }),
          makeNode({ id: forkAnswerA, chatId, parentId: forkA, role: 'assistant', content: 'First continuation', position: 1 }),
          makeNode({ id: forkAnswerB, chatId, parentId: forkB, role: 'assistant', content: 'Alternate continuation', position: 1 }),
          makeNode({ id: nestedA, chatId, parentId: forkAnswerA, role: 'user', content: 'Nested fork', position: 1 }),
          makeNode({ id: nestedB, chatId, parentId: forkAnswerA, role: 'user', content: 'Nested alternative', position: 2 }),
          makeNode({ id: `${prefix}-nested-answer-a`, chatId, parentId: nestedA, role: 'assistant', content: 'Nested answer A', position: 1 }),
          makeNode({ id: `${prefix}-nested-answer-b`, chatId, parentId: nestedB, role: 'assistant', content: 'Nested answer B', position: 1 })
        ];
      };

      expect(await compareNodeSets(tree('left', 'c1'), tree('right', 'c2'))).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: true,
        attachmentsIdentical: true
      });
    });

    it('matches equivalent siblings when their persisted order differs between chats', async () => {
      const left = [
        makeNode({ id: 'l-root', chatId: 'c1', role: 'user', content: 'Root', position: 1 }),
        makeNode({ id: 'l-a', chatId: 'c1', parentId: 'l-root', role: 'user', content: 'Branch A', position: 1 }),
        makeNode({ id: 'l-a-answer', chatId: 'c1', parentId: 'l-a', role: 'assistant', content: 'Answer A', position: 1,
          attachments: [makeAttachment({ id: 'l-attachment-a', name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' })] }),
        makeNode({ id: 'l-b', chatId: 'c1', parentId: 'l-root', role: 'user', content: 'Branch B', position: 2 }),
        makeNode({ id: 'l-b-answer', chatId: 'c1', parentId: 'l-b', role: 'assistant', content: 'Answer B', position: 1,
          attachments: [makeAttachment({ id: 'l-attachment-b', name: 'b.txt', dataUrl: 'data:text/plain;base64,Yg==' })] })
      ];
      const right = [
        makeNode({ id: 'r-root', chatId: 'c2', role: 'user', content: 'Root', position: 1 }),
        makeNode({ id: 'r-b', chatId: 'c2', parentId: 'r-root', role: 'user', content: 'Branch B', position: 1 }),
        makeNode({ id: 'r-b-answer', chatId: 'c2', parentId: 'r-b', role: 'assistant', content: 'Answer B', position: 1,
          attachments: [makeAttachment({ id: 'r-attachment-b', name: 'b.txt', dataUrl: 'data:text/plain;base64,Yg==' })] }),
        makeNode({ id: 'r-a', chatId: 'c2', parentId: 'r-root', role: 'user', content: 'Branch A', position: 2 }),
        makeNode({ id: 'r-a-answer', chatId: 'c2', parentId: 'r-a', role: 'assistant', content: 'Answer A', position: 1,
          attachments: [makeAttachment({ id: 'r-attachment-a', name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' })] })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: true,
        attachmentsIdentical: true
      });
    });

    it('still detects a content change in one matched sibling regardless of order', async () => {
      const left = [
        makeNode({ id: 'l-root', chatId: 'c1', role: 'user', content: 'Root' }),
        makeNode({ id: 'l-a', chatId: 'c1', parentId: 'l-root', role: 'user', content: 'Branch A', position: 1 }),
        makeNode({ id: 'l-b', chatId: 'c1', parentId: 'l-root', role: 'user', content: 'Branch B', position: 2 })
      ];
      const right = [
        makeNode({ id: 'r-root', chatId: 'c2', role: 'user', content: 'Root' }),
        makeNode({ id: 'r-b', chatId: 'c2', parentId: 'r-root', role: 'user', content: 'Branch B', position: 1 }),
        makeNode({ id: 'r-a', chatId: 'c2', parentId: 'r-root', role: 'user', content: 'Changed A', position: 2 })
      ];

      expect(await compareNodeSets(left, right)).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: false,
        attachmentsIdentical: true
      });
    });

    it('clones a complex forked chat and compares the clone identical to its source', async () => {
      await setup(a => {
        a.projects.push(project({ id: 'p-1', name: 'Env A' }));
        a.chats.push(chat({ id: 'c1', title: 'Forked Story', projectId: 'p-1' }));
        a.nodes.push(
          makeNode({ id: 'root-q', chatId: 'c1', role: 'user', content: 'Opening direction', position: 1 }),
          makeNode({ id: 'root-a', chatId: 'c1', parentId: 'root-q', role: 'assistant', content: 'Opening chapter', position: 1,
            attachments: [makeAttachment({ id: 'source-image', name: 'opening.png', mimeType: 'image/png',
              size: 20, dataUrl: 'data:image/png;base64,b3BlbmluZw==' })] }),
          makeNode({ id: 'fork-q1', chatId: 'c1', parentId: 'root-a', role: 'user', content: 'First continuation', position: 1 }),
          makeNode({ id: 'fork-q2', chatId: 'c1', parentId: 'root-a', role: 'user', content: 'Alternative continuation', position: 2 }),
          makeNode({ id: 'fork-a1', chatId: 'c1', parentId: 'fork-q1', role: 'assistant', content: 'First branch answer', position: 1 }),
          makeNode({ id: 'fork-a2', chatId: 'c1', parentId: 'fork-q2', role: 'assistant', content: 'Alternative branch answer', position: 1 }),
          makeNode({ id: 'nested-q1', chatId: 'c1', parentId: 'fork-a1', role: 'user', content: 'Nested continuation A', position: 1 }),
          makeNode({ id: 'nested-q2', chatId: 'c1', parentId: 'fork-a1', role: 'user', content: 'Nested continuation B', position: 2 }),
          makeNode({ id: 'nested-a1-old', chatId: 'c1', parentId: 'nested-q1', role: 'assistant', content: 'Earlier nested answer',
            position: 1, version: 1, isCurrent: false }),
          makeNode({ id: 'nested-a1', chatId: 'c1', parentId: 'nested-q1', role: 'assistant', content: 'Revised nested answer',
            position: 1, version: 2, previousVersionId: 'nested-a1-old', isCurrent: true,
            attachments: [makeAttachment({ id: 'nested-file', name: 'notes.txt', dataUrl: 'data:text/plain;base64,bm90ZXM=' })] }),
          makeNode({ id: 'nested-a2', chatId: 'c1', parentId: 'nested-q2', role: 'assistant', content: 'Other nested answer', position: 1 }),
          makeNode({ id: 'tail-q', chatId: 'c1', parentId: 'fork-a2', role: 'user', content: 'Continue the alternative', position: 1 }),
          makeNode({ id: 'tail-a', chatId: 'c1', parentId: 'tail-q', role: 'assistant', content: 'Alternative ending', position: 1 }),
          // Existing composer prevents selecting the clone from adding a new
          // empty draft that was not part of the source tree.
          makeNode({ id: 'tail-draft', chatId: 'c1', parentId: 'tail-a', role: 'user', content: '', position: 1 })
        );
      });
      const copy = await chatService.cloneChat('c1');

      expect(copy.title).toBe('Forked Story (copy)');
      const originalNodes = await chatService.fetchNodes('c1');
      const copiedNodes = await chatService.fetchNodes(copy.id);
      expect(copiedNodes).toHaveLength(originalNodes.length);
      expect(new Set(copiedNodes.map(node => node.id)).size).toBe(copiedNodes.length);
      expect(copiedNodes.every(node => node.chatId === copy.id)).toBe(true);

      // Check every graph edge and version link was remapped into the clone,
      // rather than left pointing at the source tree.
      const copiedIds = new Set(copiedNodes.map(node => node.id));
      expect(copiedNodes.filter(node => node.parentId).every(node => copiedIds.has(node.parentId!))).toBe(true);
      expect(copiedNodes.filter(node => node.previousVersionId)
        .every(node => copiedIds.has(node.previousVersionId!))).toBe(true);
      expect(copiedNodes.some(node => node.previousVersionId && node.previousVersionId !== 'nested-a1-old')).toBe(true);

      component.selectedChatIds.set(['c1', copy.id]);
      await component.compareSelectedChats();

      expect(component.chatComparison()).toEqual({
        structureIdentical: true,
        olderVersionsIdentical: true,
        contentsIdentical: true,
        attachmentsIdentical: true
      });
    });

    it('Clear empties the selection and hides the toolbar', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.clearSelectionTitle');
      expect(component.selectedChatIds()).toEqual([]);
      expect(storyTools()).toBeNull();
    });

    it('Cut stages the stories without removing them', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      ctrlClickStory('Env A', 'Story 2');
      clickTool('sidebar.cutSelectedTitle');

      // staged: nothing moved or deleted yet
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-1');
      expect(chatService.chats().find(c => c.id === 'c2')?.projectId).toBe('p-1');
      expect(component.isCutChat('c1')).toBe(true);
      expect(component.isCutChat('c2')).toBe(true);
      expect(chatItem('Env A', 'Story 1')?.classList.contains('cut')).toBe(true);
      expect(chatItem('Env A', 'Story 1')?.querySelector('.cut-badge')).not.toBeNull();
      expect(storyTools()!.textContent)
        .toContain(i18n.t('sidebar.cutStaged', { count: 2 }));
    });

    it('Cancel leaves the stories untouched', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.cutSelectedTitle');
      clickTool('sidebar.cancelClipboardTitle');
      expect(component.isCutChat('c1')).toBe(false);
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-1');
    });

    it('pasting a staged cut moves the stories into the target environment', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      ctrlClickStory('Env A', 'Story 2');
      clickTool('sidebar.cutSelectedTitle');

      expect(projectBlock('Env B')!.querySelector('.paste-btn')).not.toBeNull();
      (projectBlock('Env B')!.querySelector('.paste-btn') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settleDeep();

      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-2');
      expect(chatService.chats().find(c => c.id === 'c2')?.projectId).toBe('p-2');
      expect(component.clipboard.hasContent()).toBe(false);
      expect(component.selectedChatIds()).toEqual([]);
      expect(chatItem('Env A', 'Story 1')).toBeNull();
    });

    it('pasting after copy clones the stories into the target environment', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.copySelectedTitle');

      (projectBlock('Env B')!.querySelector('.paste-btn') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settleDeep();

      // original stays in Env A, a clone appears in Env B
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-1');
      const clones = chatService.chats().filter(c => c.projectId === 'p-2');
      expect(clones.length).toBe(1);
      expect(clones[0].id).not.toBe('c1');
      expect(component.clipboard.hasContent()).toBe(false);
    });

    it('cut&paste to the unassigned block moves the stories there', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.cutSelectedTitle');
      const unassigned = projectBlock(i18n.t('sidebar.unfiled'))!;
      expect(unassigned.querySelector('.paste-btn')).not.toBeNull();
      (unassigned.querySelector('.paste-btn') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settleDeep();
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBeNull();
    });

    it('dragging a story onto another environment moves it', async () => {
      await seedTwoEnvs();
      component.onChatDragStart(
        dragEvent({ dataTransfer: { setData: vi.fn(), effectAllowed: '' } }),
        chatService.chats().find(c => c.id === 'c1')!
      );
      await component.onDropEnvironment('p-2', dragEvent({ dataTransfer: { getData: () => '' } }));
      await settleDeep();
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-2');
      expect(component.dropTargetKey()).toBeNull();
    });

    it('dragging a marked group moves all marked stories', async () => {
      await seedTwoEnvs();
      ctrlClickStory('Env A', 'Story 1');
      ctrlClickStory('Env A', 'Story 2');
      component.onChatDragStart(
        dragEvent({ dataTransfer: { setData: vi.fn() } }),
        chatService.chats().find(c => c.id === 'c1')!
      );
      await component.onDropEnvironment('p-2', dragEvent({ dataTransfer: { getData: () => '' } }));
      await settleDeep();
      expect(chatService.chats().find(c => c.id === 'c1')?.projectId).toBe('p-2');
      expect(chatService.chats().find(c => c.id === 'c2')?.projectId).toBe('p-2');
    });

    it('dropping onto a collapsed environment expands it', async () => {
      await seedTwoEnvs();
      component.toggleExpanded('p-2');
      fixture.detectChanges();
      expect(component.isExpanded('p-2')).toBe(false);

      component.onChatDragStart(
        dragEvent({ dataTransfer: { setData: vi.fn() } }),
        chatService.chats().find(c => c.id === 'c2')!
      );
      await component.onDropEnvironment('p-2', dragEvent({ dataTransfer: { getData: () => '' } }));
      await settleDeep();

      expect(chatService.chats().find(c => c.id === 'c2')?.projectId).toBe('p-2');
      expect(component.isExpanded('p-2')).toBe(true);
    });

    it('marks the hovered environment as a drop target', async () => {
      await seedTwoEnvs();
      component.onDragEnter('p-2');
      fixture.detectChanges();
      expect(component.isDropTarget('p-2')).toBe(true);
      expect(projectBlock('Env B')!.querySelector('.project-header')?.classList.contains('drop-target'))
        .toBe(true);
      component.onDragLeave('p-2');
      fixture.detectChanges();
      expect(projectBlock('Env B')!.querySelector('.project-header')?.classList.contains('drop-target'))
        .toBe(false);
      component.onDragEnter('p-2');
      component.onDragEnter('p-2');
      component.onDragLeave('p-2');
      fixture.detectChanges();
      // nested enter/leave keep the target highlighted until the last leave
      expect(component.isDropTarget('p-2')).toBe(true);
      component.onDragLeave('p-2');
      fixture.detectChanges();
      expect(component.isDropTarget('p-2')).toBe(false);
    });

    it('delete-selected removes the marked stories after confirmation', async () => {
      await seedTwoEnvs();
      vi.spyOn(confirm, 'ask').mockResolvedValue(true);
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.deleteSelectedTitle');
      await settleDeep();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeUndefined();
      expect(component.selectedChatIds()).toEqual([]);
    });

    it('delete-selected keeps the stories when confirmation is dismissed', async () => {
      await seedTwoEnvs();
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);
      ctrlClickStory('Env A', 'Story 1');
      clickTool('sidebar.deleteSelectedTitle');
      await settleDeep();
      expect(chatService.chats().find(c => c.id === 'c1')).toBeDefined();
      expect(component.selectedChatIds()).toEqual(['c1']);
    });
  });
});
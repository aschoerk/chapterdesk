import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { ChatNavBarComponent } from './chat-nav-bar.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat/chat.service';
import { ChatNavMenuService } from '../../core/chat/chat-nav-menu.service';
import { buildLoreNodeContent } from '../../core/chat/chat-lore.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodeClipboardService } from '../../core/clipboard/node-clipboard.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeNode } from '../../../../test-helpers/factories';
import { ChatNode } from '../../models/chat';

/**
 * ChatNavBarComponent tests — everything that is LOCAL to the bar: the
 * visible-path filtering, the edit/frame marks (driven straight through the
 * inputs), the multi-selection gestures, the context-menu rows and which
 * output every menu/tool action fires. The page-side tree mutations behind
 * those outputs stay covered by `chat.component.spec.ts`.
 */
describe('ChatNavBarComponent', () => {
  let fixture: ComponentFixture<ChatNavBarComponent>;
  let component: ChatNavBarComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let clipboard: NodeClipboardService;
  let i18n: I18nService;

  const node = makeNode;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    localStorage.clear();

    await TestBed.configureTestingModule({
      imports: [ChatNavBarComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        // One per chat page — the component binds itself as the menu host.
        ChatNavMenuService,
      ],
    }).compileComponents();

    chatService = TestBed.inject(ChatService);
    clipboard = TestBed.inject(NodeClipboardService);
    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');
  });

  // ------------------------------------------------------------------
  // Harness
  // ------------------------------------------------------------------

  /** Render the bar over an explicit active path (the page's getActivePath()). */
  function createBar(
    path: ChatNode[],
    opts: { visibleNodeIds?: string[]; editingNodeId?: string | null } = {},
  ): void {
    fixture = TestBed.createComponent(ChatNavBarComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('activePath', path);
    fixture.componentRef.setInput('visibleNodeIds', opts.visibleNodeIds ?? []);
    fixture.componentRef.setInput('editingNodeId', opts.editingNodeId ?? null);
    fixture.detectChanges();
  }

  /** Seed chat state so getChildren / active-path queries see the tree. */
  async function seed(tree: ChatNode[]): Promise<void> {
    api.chats.push({
      id: 'chat-1',
      title: 'Story',
      projectId: null,
      node_number: tree.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    api.nodes = tree;
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
  }

  function navNode(id: string): HTMLElement {
    return fixture.nativeElement.querySelector(`[data-nav-id="${id}"]`) as HTMLElement;
  }

  function badgeText(id: string): string {
    return (navNode(id).querySelector('.nav-badge') as HTMLElement).textContent?.trim() ?? '';
  }

  /** Find a button by its (translated) title attribute. */
  function btn(titleKey: string): HTMLButtonElement | null {
    const title = i18n.t(titleKey);
    return (
      Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[]
    ).find((b) => b.getAttribute('title') === title) ?? null;
  }

  /** Find a context-menu row by its (translated) label. */
  function menuRow(labelKey: string): ReturnType<ChatNavBarComponent['navNodeMenuItems']>[number] {
    const label = i18n.t(labelKey);
    const item = component.navNodeMenuItems().find((i) => !i.divider && i.label === label);
    expect(item).toBeDefined();
    return item!;
  }

  function ctrlPointerEvent(): PointerEvent {
    return {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as PointerEvent;
  }

  function navMenuEvent(): MouseEvent {
    return {
      clientX: 10,
      clientY: 10,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  describe('rendering', () => {
    it('renders one nav node per path entry with the role badge (D/C/S)', () => {
      createBar([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Question' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Answer' }),
        node({ id: 't1', parentId: 'a1', role: 'structural', content: 'Title' }),
      ]);

      expect(fixture.nativeElement.querySelectorAll('.nav-node').length).toBe(3);
      expect(badgeText('q1')).toBe('D');
      expect(badgeText('a1')).toBe('C');
      expect(badgeText('t1')).toBe('S');
      // separator between neighbours, none behind the last node
      expect(fixture.nativeElement.querySelectorAll('.nav-separator').length).toBe(2);
    });

    it('shows the branch count on a node with siblings', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'One' }),
        node({ id: 'a2', parentId: 'q1', role: 'assistant', content: 'Two' }),
      ]);
      chatService.setActiveChild('q1', 'a1');

      createBar(chatService.getActivePath());

      const count = navNode('a1').querySelector('.nav-branch-count') as HTMLElement;
      expect(count).not.toBeNull();
      expect(count.textContent).toContain('1');
      expect(count.textContent).toContain('2');
    });

    it('hides excluded nodes without siblings but keeps excluded branch points', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'x', parentId: 'q1', role: 'user', content: 'hidden', excludeFromContext: true }),
        node({ id: 'b', parentId: 'q1', role: 'user', content: 'branch' }),
        node({ id: 'a1', parentId: 'x', role: 'assistant', content: 'A' }),
      ]);
      chatService.setActiveChild('q1', 'x');
      chatService.setActiveChild('x', 'a1');

      // x is excluded but has a sibling (b) → stays visible as a branch point.
      createBar(chatService.getActivePath());
      expect(navNode('x')).not.toBeNull();

      // without the sibling the excluded node drops out of the bar.
      chatService.setActiveChild('q1', 'b');
      await chatService.deleteNode('chat-1', 'b', { keepChildren: true });
      chatService.setActiveChild('q1', 'x');
      fixture.componentRef.setInput('activePath', chatService.getActivePath());
      fixture.detectChanges();
      expect(navNode('x')).toBeNull();
    });

    it('shows a documented lore node (first appearance) as a ⟡ pill even though it is excluded', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
        node({
          id: 'lore1', parentId: 'a1', role: 'user',
          content: buildLoreNodeContent('Ashley is married to Dr. Harvey.'),
          excludeFromContext: true,
        }),
        node({ id: 'd1', parentId: 'lore1', role: 'user', content: 'Next' }),
      ]);
      chatService.setActiveChild('q1', 'a1');
      chatService.setActiveChild('a1', 'lore1');
      chatService.setActiveChild('lore1', 'd1');

      createBar(chatService.getActivePath());

      // A sent lore node is excluded from context and has no sibling — a
      // normal node would drop out of the bar entirely, but the first
      // appearance of the lore stays as a documented ⟡ pill.
      const lore = navNode('lore1');
      expect(lore).not.toBeNull();
      expect(lore.classList.contains('lore')).toBe(true);
      expect(lore.classList.contains('lore-documented')).toBe(true);
      expect(lore.classList.contains('lore-armed')).toBe(false);
      expect(badgeText('lore1')).toBe('⟡');
      expect(lore.getAttribute('title')).toBe(i18n.t('node.loreDocumentedTitle'));
    });

    it('shows the armed lore node emphasized with the ⟡ badge', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
        node({
          id: 'lore1', parentId: 'a1', role: 'user',
          content: buildLoreNodeContent('Ashley is married to Dr. Harvey.'),
          excludeAfterSend: true,
        }),
        node({ id: 'd1', parentId: 'lore1', role: 'user', content: 'Next' }),
      ]);
      chatService.setActiveChild('q1', 'a1');
      chatService.setActiveChild('a1', 'lore1');
      chatService.setActiveChild('lore1', 'd1');

      createBar(chatService.getActivePath());

      const lore = navNode('lore1');
      expect(lore).not.toBeNull();
      expect(lore.classList.contains('lore-armed')).toBe(true);
      expect(lore.classList.contains('lore-documented')).toBe(false);
      expect(badgeText('lore1')).toBe('⟡');
      expect(lore.getAttribute('title')).toBe(i18n.t('node.loreArmedTitle'));
    });

    it('hides identical lore repeats — only the first appearance is shown', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' }),
        node({ id: 'lore1', parentId: 'a1', role: 'user', content: buildLoreNodeContent('Ashley is married to Dr. Harvey.'), excludeFromContext: true }),
        node({ id: 'd1', parentId: 'lore1', role: 'user', content: 'D1' }),
        node({ id: 'a2', parentId: 'd1', role: 'assistant', content: 'A2' }),
        node({ id: 'lore2', parentId: 'a2', role: 'user', content: buildLoreNodeContent('Ashley is married to Dr. Harvey.'), excludeAfterSend: true }),
        node({ id: 'd2', parentId: 'lore2', role: 'user', content: 'D2' }),
      ]);
      chatService.setActiveChild('q1', 'a1');
      chatService.setActiveChild('a1', 'lore1');
      chatService.setActiveChild('lore1', 'd1');
      chatService.setActiveChild('d1', 'a2');
      chatService.setActiveChild('a2', 'lore2');
      chatService.setActiveChild('lore2', 'd2');

      createBar(chatService.getActivePath());

      // lore2 carries the SAME canon as lore1 — it is a repeat and stays
      // hidden, even though it is the armed (current) lore.
      expect(navNode('lore1')).not.toBeNull();
      expect(navNode('lore2')).toBeNull();
    });

    it('shows a new ⟡ pill when the lore content changes', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A1' }),
        node({ id: 'lore1', parentId: 'a1', role: 'user', content: buildLoreNodeContent('Ashley is married to Dr. Harvey.'), excludeFromContext: true }),
        node({ id: 'd1', parentId: 'lore1', role: 'user', content: 'D1' }),
        node({ id: 'a2', parentId: 'd1', role: 'assistant', content: 'A2' }),
        node({ id: 'lore2', parentId: 'a2', role: 'user', content: buildLoreNodeContent('Ashley is now the keeper of the gate.'), excludeAfterSend: true }),
        node({ id: 'd2', parentId: 'lore2', role: 'user', content: 'D2' }),
      ]);
      chatService.setActiveChild('q1', 'a1');
      chatService.setActiveChild('a1', 'lore1');
      chatService.setActiveChild('lore1', 'd1');
      chatService.setActiveChild('d1', 'a2');
      chatService.setActiveChild('a2', 'lore2');
      chatService.setActiveChild('lore2', 'd2');

      createBar(chatService.getActivePath());

      // lore2 is a DIFFERENT canon — both the documented first appearance and
      // the new armed lore get their own pill.
      expect(navNode('lore1')).not.toBeNull();
      expect(navNode('lore2')).not.toBeNull();
      expect(navNode('lore2').classList.contains('lore-armed')).toBe(true);
      expect(navNode('lore1').classList.contains('lore-documented')).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Marks (edit dot + current frame)
  // ------------------------------------------------------------------

  describe('marks', () => {
    const path = () => [
      node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
    ];

    it('marks the node being edited with a dot and the frame', () => {
      createBar(path(), { editingNodeId: 'a1' });

      expect(navNode('a1').querySelector('.nav-edit-dot')).not.toBeNull();
      expect(navNode('a1').classList.contains('editing')).toBe(true);
      expect(navNode('a1').classList.contains('active')).toBe(true);
      expect(navNode('q1').querySelector('.nav-edit-dot')).toBeNull();
    });

    it('falls back to the next visible node when the edited node is hidden', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'x', parentId: 'q1', role: 'user', content: 'excluded', excludeFromContext: true }),
        node({ id: 'a1', parentId: 'x', role: 'assistant', content: 'A' }),
      ]);
      chatService.setActiveChild('q1', 'x');
      chatService.setActiveChild('x', 'a1');

      createBar(chatService.getActivePath(), { editingNodeId: 'x' });

      expect(navNode('x')).toBeNull(); // hidden — no sibling
      expect(navNode('a1').querySelector('.nav-edit-dot')).not.toBeNull();
      expect(navNode('a1').classList.contains('editing')).toBe(true);
    });

    it('falls back to the next visible node when the frame node is hidden', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'x', parentId: 'q1', role: 'user', content: 'excluded', excludeFromContext: true }),
        node({ id: 'a1', parentId: 'x', role: 'assistant', content: 'A' }),
      ]);
      chatService.setActiveChild('q1', 'x');
      chatService.setActiveChild('x', 'a1');

      createBar(chatService.getActivePath(), { visibleNodeIds: ['x'] });

      expect(navNode('x')).toBeNull();
      expect(navNode('a1').classList.contains('active')).toBe(true);
    });

    it('frames EVERY node currently visible in the viewport (long chapter sharing the view)', () => {
      createBar(path(), { visibleNodeIds: ['q1', 'a1'] });

      expect(navNode('q1').classList.contains('active')).toBe(true);
      expect(navNode('a1').classList.contains('active')).toBe(true);
    });

    it('does not frame a node that is not visible in the viewport', () => {
      createBar(path(), { visibleNodeIds: ['q1'] });

      expect(navNode('q1').classList.contains('active')).toBe(true);
      expect(navNode('a1').classList.contains('active')).toBe(false);
    });

    it('deduplicates the frame when several visible nodes fall back to one nav node', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'x', parentId: 'q1', role: 'user', content: 'excluded', excludeFromContext: true }),
        node({ id: 'y', parentId: 'x', role: 'user', content: 'excluded', excludeFromContext: true }),
        node({ id: 'a1', parentId: 'y', role: 'assistant', content: 'A' }),
      ]);
      chatService.setActiveChild('q1', 'x');
      chatService.setActiveChild('x', 'y');
      chatService.setActiveChild('y', 'a1');

      // Both hidden nodes are visible in the tree viewport — both fall back
      // to the SAME next visible nav node, so it carries exactly one frame.
      createBar(chatService.getActivePath(), { visibleNodeIds: ['x', 'y'] });

      expect(navNode('x')).toBeNull();
      expect(navNode('a1').classList.contains('active')).toBe(true);
    });

    it('keeps both marks on an excluded node that has siblings', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'x', parentId: 'q1', role: 'user', content: 'excluded', excludeFromContext: true }),
        node({ id: 'b', parentId: 'q1', role: 'user', content: 'branch' }),
      ]);
      chatService.setActiveChild('q1', 'x');

      createBar(chatService.getActivePath(), { editingNodeId: 'x' });

      expect(navNode('x').querySelector('.nav-edit-dot')).not.toBeNull();
      expect(navNode('x').classList.contains('active')).toBe(true);
      expect(navNode('b')).toBeNull(); // the non-active sibling is not a nav node
    });
  });

  // ------------------------------------------------------------------
  // Manual nav-bar scroll suppression (auto-scroll only follows the tree)
  // ------------------------------------------------------------------

  describe('manual nav-bar scroll suppression', () => {
    /** Render a bar whose marked node sits ABOVE the bar's viewport (cut off
     *  at the top), so a genuine auto-scroll would move the bar up. */
    function barWithCutOffMark(): { bar: HTMLElement; marked: HTMLElement } {
      createBar([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
      ], { visibleNodeIds: ['a1'] });

      const bar = fixture.nativeElement.querySelector('.node-nav-bar') as HTMLElement;
      vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100 } as DOMRect);
      const marked = bar.querySelector('[data-nav-id="a1"]') as HTMLElement;
      vi.spyOn(marked, 'getBoundingClientRect').mockReturnValue({ top: -50, bottom: 0 } as DOMRect);
      bar.scrollTop = 100;
      return { bar, marked };
    }

    it('auto-scrolls the bar to reveal a cut-off mark (tree-driven)', () => {
      const { bar } = barWithCutOffMark();

      component.scrollNavBarToMarked();

      expect(bar.scrollTop).toBe(49); // moved up by 51 to bring the mark into view
    });

    it('does NOT auto-scroll right after the user scrolled the nav bar', () => {
      const { bar } = barWithCutOffMark();
      // First call performs the auto-scroll AND attaches the gesture listener
      // (the page's effect calls it regularly, so it is always armed in the
      // real app).
      component.scrollNavBarToMarked();
      expect(bar.scrollTop).toBe(49);

      // A manual wheel gesture over the bar suppresses the next auto-scroll.
      bar.dispatchEvent(new Event('wheel', { bubbles: true, cancelable: true }));
      const before = bar.scrollTop;
      component.scrollNavBarToMarked();

      expect(bar.scrollTop).toBe(before); // not reverted to the marked node
    });
  });

  // ------------------------------------------------------------------
  // Multi-selection (Ctrl+click / Ctrl+drag)
  // ------------------------------------------------------------------

  describe('multi-selection', () => {
    it('toggles a nav node on Ctrl+click (decided on pointer-up)', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
      ]);
      createBar(chatService.getActivePath());
      const a1 = chatService.nodes().find((n) => n.id === 'a1')!;

      component.onNavPointerDown(ctrlPointerEvent(), a1);
      expect(component.navSelectedIds()).toEqual([]); // decided on pointer-up
      component.onNavDocumentPointerUp(ctrlPointerEvent());
      expect(component.navSelectedIds()).toEqual(['a1']);

      // second Ctrl+click deselects
      component.onNavPointerDown(ctrlPointerEvent(), a1);
      component.onNavDocumentPointerUp(ctrlPointerEvent());
      expect(component.navSelectedIds()).toEqual([]);
    });

    it('selects a range with Ctrl+drag in navbar order', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
      ]);
      createBar(chatService.getActivePath());
      const [q1, a1] = chatService.nodes();

      component.onNavPointerDown(ctrlPointerEvent(), q1);
      component.onNavPointerEnter(a1);
      component.onNavDocumentPointerUp(ctrlPointerEvent());
      expect(component.navSelectedIds()).toEqual(['q1', 'a1']);
    });

    it('never selects the empty terminal direction node', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
      ]);
      // selectChat appended the auto draft leaf — the terminal direction.
      const path = chatService.getActivePath();
      const draft = path.at(-1)!;
      expect(chatService.isDraftQuestion(draft)).toBe(true);
      createBar(path);
      const [q1] = chatService.nodes();

      component.toggleNavSelection(draft.id);
      expect(component.navSelectedIds()).toEqual([]);

      component.onNavPointerDown(ctrlPointerEvent(), draft);
      component.onNavDocumentPointerUp(ctrlPointerEvent());
      expect(component.navSelectedIds()).toEqual([]);

      // a Ctrl+drag that ENDS on the draft excludes it from the range
      component.onNavPointerDown(ctrlPointerEvent(), q1);
      component.onNavPointerEnter(draft);
      component.onNavDocumentPointerUp(ctrlPointerEvent());
      expect(component.navSelectedIds()).toEqual(['q1', 'a1']);
    });
  });

  // ------------------------------------------------------------------
  // Tools row (multi-select actions → outputs)
  // ------------------------------------------------------------------

  it('shows the tools row while nodes are selected and emits the selection actions', async () => {
    await seed([
      node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
    ]);
    createBar(chatService.getActivePath());
    expect(fixture.nativeElement.querySelector('.nav-tools')).toBeNull();

    component.toggleNavSelection('q1');
    component.toggleNavSelection('a1');
    fixture.detectChanges();

    const tools = fixture.nativeElement.querySelector('.nav-tools') as HTMLElement;
    expect(tools).not.toBeNull();
    expect(tools.textContent).toContain(i18n.t('node.selectedCount', { n: 2, chapters: 1 }));

    const copies: number[] = [];
    const cuts: number[] = [];
    const deletes: number[] = [];
    component.copySelection.subscribe(() => copies.push(1));
    component.cutSelection.subscribe(() => cuts.push(1));
    component.deleteSelection.subscribe(() => deletes.push(1));

    btn('node.copySelectedTitle')!.click();
    btn('node.cutSelectedTitle')!.click();
    btn('node.deleteSelectedTitle')!.click();

    expect(copies).toHaveLength(1);
    expect(cuts).toHaveLength(1);
    expect(deletes).toHaveLength(1);
  });

  // ------------------------------------------------------------------
  // Selection word counts (single node vs. chain)
  // ------------------------------------------------------------------

  describe('selection word counts', () => {
    /** Seed q1 → a1 → q2 → a2, each with distinct word counts. */
    async function seedStory(): Promise<void> {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'one two three' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'alpha beta' }),
        node({ id: 'q2', parentId: 'a1', role: 'user', content: 'gamma delta epsilon' }),
        node({ id: 'a2', parentId: 'q2', role: 'assistant', content: 'zeta' }),
      ]);
      chatService.setActiveChild('q1', 'a1');
      chatService.setActiveChild('a1', 'q2');
      chatService.setActiveChild('q2', 'a2');
      createBar(chatService.getActivePath());
    }

    function wordsEl(): HTMLElement | null {
      return fixture.nativeElement.querySelector('.nav-selection-words') as HTMLElement | null;
    }

    it('single node: shows the node words and its whole subtree words (assistant-only)', async () => {
      await seedStory();
      component.toggleNavSelection('q2');
      fixture.detectChanges();

      // q2 is a direction → its own count is 0; its subtree's only assistant
      // (a2) = 1 word.
      expect(component.selectedAssistantCount()).toBe(0);
      expect(component.selectionWords()).toEqual({ node: 0, subtree: 1 });
      expect(wordsEl()).not.toBeNull();
      expect(wordsEl()!.textContent).toContain(
        i18n.t('node.selectedWordsNodeSubtree', { node: 0, subtree: 1 }),
      );

      // A single CHAPTER selection counts its own words + subtree chapters.
      component.toggleNavSelection('q2');
      component.toggleNavSelection('a2');
      fixture.detectChanges();
      expect(component.selectedAssistantCount()).toBe(1);
      expect(component.selectionWords()).toEqual({ node: 1, subtree: 1 });
    });

    it('chain (multi-select): counts only the assistant nodes WITHIN the selected chain', async () => {
      await seedStory();
      component.toggleNavSelection('q1');
      component.toggleNavSelection('a1');
      component.toggleNavSelection('q2');
      component.toggleNavSelection('a2');
      fixture.detectChanges();

      // The selected chain contains 2 assistant nodes (a1=2, a2=1) = 3 words;
      // directions do not count and deeper subtrees are NOT included.
      expect(component.selectedAssistantCount()).toBe(2);
      expect(component.isSingleSelection()).toBe(false);
      expect(component.selectionWords()).toEqual({ node: 0, subtree: 3 });
      expect(wordsEl()).not.toBeNull();
      expect(wordsEl()!.textContent).toContain(
        i18n.t('node.selectedWordsChain', { words: 3 }),
      );
    });

    it('chain stopping short of the first node subtree: counts only the selected assistants', async () => {
      await seedStory();
      // Select q1 → a1 only. a1 HAS a child subtree (q2 → a2, with assistant
      // a2=1 word) but it is NOT part of the selection — only a1's own words
      // (2) may count.
      component.toggleNavSelection('q1');
      component.toggleNavSelection('a1');
      fixture.detectChanges();

      expect(component.isSingleSelection()).toBe(false);
      expect(component.selectedAssistantCount()).toBe(1);
      expect(component.selectionWords()).toEqual({ node: 0, subtree: 2 });
      expect(wordsEl()).not.toBeNull();
      expect(wordsEl()!.textContent).toContain(
        i18n.t('node.selectedWordsChain', { words: 2 }),
      );
    });

    it('shows no word-count element when the selection is empty', async () => {
      await seedStory();
      fixture.detectChanges();
      expect(wordsEl()).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Node context menu (host → outputs)
  // ------------------------------------------------------------------

  describe('node context menu', () => {
    /** Seed q1 → a1 (active) with a2 as a sibling branch. */
    async function seedBranch(): Promise<void> {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'One' }),
        node({ id: 'a2', parentId: 'q1', role: 'assistant', content: 'Two' }),
      ]);
      chatService.setActiveChild('q1', 'a1');
      createBar(chatService.getActivePath());
    }

    it('offers branch, switch, selection and clipboard rows (no paste rows on an empty clipboard)', async () => {
      await seedBranch();
      const a1 = chatService.nodes().find((n) => n.id === 'a1')!;
      component.openNavNodeMenu(navMenuEvent(), a1);

      const labels = component.navNodeMenuItems().filter((i) => !i.divider).map((i) => i.label);
      expect(labels).toContain(i18n.t('node.branchHere'));
      expect(labels).toContain(i18n.t('node.prevBranch'));
      expect(labels).toContain(i18n.t('node.nextBranch'));
      expect(labels).toContain(i18n.t('node.navSelect'));
      expect(labels).toContain(i18n.t('node.copySelected'));
      expect(labels).toContain(i18n.t('node.cutSelected'));
      expect(labels).toContain(i18n.t('node.deleteSelected'));
      // empty clipboard → no paste group; destructive row comes last
      expect(labels.some((l) => l.includes(i18n.t('node.navPasteBefore')))).toBe(false);
      expect(labels.at(-1)).toBe(i18n.t('node.deleteSelected'));
    });

    it('emits the tree-mutation outputs for the clipboard rows', async () => {
      await seedBranch();
      const a1 = chatService.nodes().find((n) => n.id === 'a1')!;
      const starts: ChatNode[] = [];
      const copies: ChatNode[] = [];
      const cuts: ChatNode[] = [];
      const deletes: ChatNode[] = [];
      component.startBranch.subscribe((n) => starts.push(n));
      component.copyNode.subscribe((n) => copies.push(n));
      component.cutNode.subscribe((n) => cuts.push(n));
      component.deleteNode.subscribe((n) => deletes.push(n));

      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.branchHere'));
      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.copySelected'));
      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.cutSelected'));
      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.deleteSelected'));

      expect(starts).toEqual([a1]);
      expect(copies).toEqual([a1]);
      expect(cuts).toEqual([a1]);
      expect(deletes).toEqual([a1]);
    });

    it('emits switchSibling for the branch rows and toggles the selection locally', async () => {
      await seedBranch();
      const a1 = chatService.nodes().find((n) => n.id === 'a1')!;
      const switches: { node: ChatNode; dir: -1 | 1 }[] = [];
      component.switchSibling.subscribe((s) => switches.push(s));

      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.nextBranch'));
      expect(switches).toEqual([{ node: a1, dir: 1 }]);

      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.navSelect'));
      expect(component.navSelectedIds()).toEqual(['a1']);
      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.navUnselect'));
      expect(component.navSelectedIds()).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // Paste button + paste menu
  // ------------------------------------------------------------------

  describe('paste button', () => {
    /** Seed the chain q1 → a1 → q2 and copy q1 into the clipboard. */
    async function seedChain(): Promise<void> {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q1' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
        node({ id: 'q2', parentId: 'a1', role: 'user', content: 'Q2' }),
      ]);
      chatService.setActiveChild('q1', 'a1');
      chatService.setActiveChild('a1', 'q2');
      clipboard.copySequence([chatService.nodes().find((n) => n.id === 'q1')!]);
      createBar(chatService.getActivePath());
    }

    it('gates the paste button: never left of the terminal empty direction', async () => {
      await seed([
        node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
        node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
      ]);
      clipboard.copySequence([chatService.nodes().find((n) => n.id === 'q1')!]);
      const path = chatService.getActivePath();
      const draft = path.at(-1)!;
      createBar(path);

      // a1 sits LEFT of the terminal direction → no button; behind the
      // terminal direction (the very end) stays allowed. A button may also
      // sit after q1 (pasting between q1 and a1 is fine).
      expect(component.canPasteAfter(chatService.nodes().find((n) => n.id === 'a1')!)).toBe(false);
      expect(component.canPasteAfter(draft)).toBe(true);
      expect(fixture.nativeElement.querySelectorAll('.nav-paste-after').length).toBe(2);
    });

    it('the ⤵ click emits pasteAfter, the paste menu emits insert/append with the targets', async () => {
      await seedChain();
      const a1 = chatService.nodes().find((n) => n.id === 'a1')!;
      const afters: string[] = [];
      const chains: { mode: 'insert' | 'append'; leftId: string; rightId: string | null }[] = [];
      component.pasteAfter.subscribe((id) => afters.push(id));
      component.pasteChain.subscribe((c) => chains.push(c));

      // ⤵ buttons sit after q1, a1 and the terminal draft (not after q2 —
      // nothing may be pasted left of the terminal direction). Click a1's.
      const pasteButtons = fixture.nativeElement.querySelectorAll('.nav-paste-after');
      (pasteButtons[1] as HTMLButtonElement).click();
      expect(afters).toEqual(['a1']);

      component.openNavPasteMenu(navMenuEvent(), a1);
      const menu = component.navPasteMenu();
      expect(menu).not.toBeNull();
      expect(menu!.leftId).toBe('a1');
      expect(menu!.rightId).toBe('q2');

      const items = component.navPasteMenuItems(menu!);
      expect(items.map((i) => i.label)).toEqual([
        i18n.t('node.pasteInsert'),
        i18n.t('node.pasteAppend'),
      ]);
      component.runNavPasteAction(items[0]);
      expect(chains).toEqual([{ mode: 'insert', leftId: 'a1', rightId: 'q2' }]);
    });

    it('the node menu paste rows emit pasteBefore / pasteAfter', async () => {
      await seedChain();
      const q2 = chatService.nodes().find((n) => n.id === 'q2')!;
      const a1 = chatService.nodes().find((n) => n.id === 'a1')!;
      const befores: string[] = [];
      const afters: string[] = [];
      component.pasteBefore.subscribe((id) => befores.push(id));
      component.pasteAfter.subscribe((id) => afters.push(id));

      component.openNavNodeMenu(navMenuEvent(), q2);
      component.runNavNodeAction(menuRow('node.navPasteBefore'));
      // "Paste behind" needs a non-terminal right node → use a1 (q2 is only
      // followed by the terminal direction, so its row is disabled).
      component.openNavNodeMenu(navMenuEvent(), a1);
      component.runNavNodeAction(menuRow('node.navPasteAfter'));

      expect(befores).toEqual(['q2']);
      expect(afters).toEqual(['a1']);
    });
  });

  // ------------------------------------------------------------------
  // Vertical resizer
  // ------------------------------------------------------------------

  it('dragging the separator grows the bar height (persisted) and double-click resets it', async () => {
    await seed([
      node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'A' }),
    ]);
    createBar(chatService.getActivePath());
    expect(component.navBarHeight()).toBeNull();

    component.startNavResize({
      button: 0, clientX: 0, clientY: 100,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as PointerEvent);
    expect(component.isNavResizing()).toBe(true);
    (component as unknown as { onNavResizePointerMove: (e: { clientY: number; preventDefault: () => void }) => void })
      .onNavResizePointerMove({ clientY: 160, preventDefault: vi.fn() });
    (component as unknown as { onNavResizePointerUp: () => void }).onNavResizePointerUp();

    const grown = component.navBarHeight();
    expect(grown).toBeGreaterThan(40); // grows beyond the 40px minimum
    expect(Number(localStorage.getItem('chat-client.navbar.height.chat-1'))).toBe(grown);
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.node-nav-bar') as HTMLElement)
      .classList.contains('grown')).toBe(true);

    // a huge drag clamps at the max…
    component.startNavResize({
      button: 0, clientX: 0, clientY: 100,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as PointerEvent);
    (component as unknown as { onNavResizePointerMove: (e: { clientY: number; preventDefault: () => void }) => void })
      .onNavResizePointerMove({ clientY: 100000, preventDefault: vi.fn() });
    (component as unknown as { onNavResizePointerUp: () => void }).onNavResizePointerUp();
    expect(component.navBarHeight()).toBeLessThanOrEqual(320);

    // …and the double-click restores the auto height.
    component.resetNavBarHeight();
    expect(component.navBarHeight()).toBeNull();
    expect(localStorage.getItem('chat-client.navbar.height.chat-1')).toBeNull();
  });
});

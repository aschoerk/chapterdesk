import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi } from '../../../../test-helpers/factories';
import { I18nService } from '../../core/i18n/i18n.service';
import { NameReplaceDialogService } from '../../core/dialogs/name-replace-dialog.service';
import { NameDictionaryService } from '../../core/names/name-dictionary.service';
import { NameReplaceDialogComponent } from './name-replace-dialog.component';
import {
  EXCLUDED_WORD_LANGUAGE,
  type NameEntry,
  type NameReplacement,
} from '../../models/name-entry';

function entry(partial: Partial<NameEntry> & { name: string }): NameEntry {
  const category = partial.category ?? partial.gender ?? null;
  return {
    id: partial.id ?? 'e1',
    language: partial.language ?? null,
    name: partial.name,
    category: (category as NameEntry['category']) ?? null,
    gender: category === 'male' || category === 'female' ? category : null,
    prename: partial.prename ?? null,
    surname: partial.surname ?? null,
    shortName: partial.shortName ?? null,
    capitalized: partial.capitalized ?? null,
    initials: partial.initials ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('NameReplaceDialogComponent', () => {
  let fixture: ComponentFixture<NameReplaceDialogComponent>;
  let component: NameReplaceDialogComponent;
  let dialog: NameReplaceDialogService;
  let dictionary: {
    entries: () => NameEntry[];
    load: ReturnType<typeof vi.fn>;
    loading: () => boolean;
    entriesForLanguage: (language: string | null) => NameEntry[];
    create: ReturnType<typeof vi.fn>;
    replacements: () => NameReplacement[];
    savedReplacementFor: (form: string, language?: string | null) => NameReplacement | null;
    saveReplacement: ReturnType<typeof vi.fn>;
    deleteReplacement: ReturnType<typeof vi.fn>;
  };
  /** Persisted replacements the mock dictionary knows about. */
  let savedReplacements: NameReplacement[];
  const applyMock: ReturnType<typeof vi.fn<(...args: any[]) => Promise<void>>> = vi.fn(async () => {});

  beforeEach(async () => {
    // The dialog persists size + position; never leak between tests.
    localStorage.removeItem('name-replace-dialog.size');
    localStorage.removeItem('name-replace-dialog.pos');
    const api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model', providerId: 'prov-1' },
      ],
    });
    const example = entry({
      id: 'e1',
      name: 'Elizabeth',
      language: 'en',
      category: 'female',
    });
    const lizEntry = entry({ id: 'e2', name: 'Liz', language: 'en', category: 'female' });
    applyMock.mockClear();
    savedReplacements = [];
    const replacement = (from: string, to: string, language: string | null = null): NameReplacement => ({
      id: `r-${from.toLowerCase()}`,
      from,
      to,
      language,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    dictionary = {
      entries: () => [example, lizEntry],
      load: vi.fn(async () => []),
      loading: () => false,
      entriesForLanguage: () => [example, lizEntry],
      create: vi
        .fn(async (data: { name: string; language: string | null }) =>
          entry({ name: data.name, language: data.language }),
        )
        .mockClear(),
      replacements: () => savedReplacements,
      savedReplacementFor: (form: string, language: string | null = null) => {
        const match = savedReplacements.find((r) => r.from.toLowerCase() === form.toLowerCase());
        if (!match) return null;
        if (!language || !match.language) return match;
        return match.language === language ? match : null;
      },
      saveReplacement: vi.fn(async (data: { from: string; to: string; language?: string | null }) => {
        const saved = replacement(data.from, data.to, data.language ?? null);
        savedReplacements = [
          ...savedReplacements.filter((r) => r.from.toLowerCase() !== data.from.toLowerCase()),
          saved,
        ];
        return saved;
      }).mockClear(),
      deleteReplacement: vi.fn(async (id: string) => {
        savedReplacements = savedReplacements.filter((r) => r.id !== id);
      }).mockClear(),
    };
    await TestBed.configureTestingModule({
      imports: [NameReplaceDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        { provide: NameDictionaryService, useValue: dictionary },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(NameReplaceDialogService);
    fixture = TestBed.createComponent(NameReplaceDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when closed', () => {
    expect(fixture.nativeElement.querySelector('.nr-dialog')).toBeNull();
  });

  it('finds and lists names with count + proposal when opened', async () => {
    const p = dialog.open({
      units: [
        { key: 'n1', text: 'Elizabeth met Liz. Elizabeth smiled.' },
      ],
      apply: applyMock,
      language: 'en',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.nr-dialog')).not.toBeNull();
    const rows = component.rows();
    const elizabeth = rows.find((r) => r.form === 'Elizabeth');
    const liz = rows.find((r) => r.form === 'Liz');
    expect(elizabeth?.count).toBe(2);
    expect(elizabeth?.proposed).toBe('Elizabeth');
    expect(liz?.count).toBe(1);
    expect(liz?.proposed).toBe('Liz'); // keeps first letter
    dialog.cancel();
    await p;
  });

  it('approves a row and applies the replacement', async () => {
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth met Liz.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const liz = component.rows().find((r) => r.form === 'Liz')!;
    // Setting the proposal manually (editbox) marks the row approved.
    component.setProposed(liz, 'Elizabeth');
    expect(liz.approved).toBe(true);
    await component.replaceApproved();
    await p;

    expect(applyMock).toHaveBeenCalledTimes(1);
    const updated = applyMock.mock.calls[0][0] as unknown as { key: string; text: string }[];
    expect(updated[0].text).toBe('Elizabeth met Elizabeth.');
  });

  it('scopes to assistant messages by default and can widen to all roles', async () => {
    expect(component.onlyAssistant()).toBe(true);

    const p = dialog.open({
      units: [
        { key: 'a1', text: 'Elizabeth smiled.', role: 'assistant' },
        { key: 'u1', text: 'Elizabeth asked.', role: 'user' },
      ],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    expect(elizabeth.count).toBe(1);
    expect(elizabeth.occurrences?.map((o) => o.key)).toEqual(['a1']);

    // Widen the scope → the user prompt is scanned too.
    component.onlyAssistant.set(false);
    component.onOnlyAssistantChange();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    expect(elizabeth.count).toBe(2);
    expect(elizabeth.occurrences?.map((o) => o.key)).toEqual(['a1', 'u1']);

    dialog.cancel();
    await p;
  });

  it('applies replacements to ALL units even when the search is scoped to assistant messages', async () => {
    const p = dialog.open({
      units: [
        { key: 'a1', text: 'Elizabeth smiled.', role: 'assistant' },
        { key: 'u1', text: 'Elizabeth asked.', role: 'user' },
      ],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Only the assistant unit was scanned → the row lists just a1.
    const elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    expect(elizabeth.occurrences?.map((o) => o.key)).toEqual(['a1']);

    component.setProposed(elizabeth, 'Liz');
    await component.replaceApproved();
    await p;

    const updated = applyMock.mock.calls[0][0] as unknown as { key: string; text: string }[];
    // BOTH units are rewritten: replacing is not limited by the search scope.
    expect(updated).toHaveLength(2);
    expect(updated[0]).toMatchObject({ key: 'a1', text: 'Liz smiled.' });
    expect(updated[1]).toMatchObject({ key: 'u1', text: 'Liz asked.' });
  });

  it('excludes an unknown word forever and persists it on apply', async () => {
    // "Darcy" is always capitalised (and appears mid-sentence, not only at a
    // sentence start), so with includeUnknown it surfaces as an unknown row.
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Darcy spoke. Later, Darcy smiled.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Enable the "find by capital letter" option so the unknown row appears.
    component.includeUnknown.set(true);
    component.onIncludeUnknownChange();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const darcy = component.rows().find((r) => r.form === 'Darcy');
    expect(darcy).toBeDefined();

    // Tick "exclude forever" → greys the row (approved cleared).
    component.toggleExcluded(darcy!);
    expect(darcy!.excluded).toBe(true);
    expect(darcy!.approved).toBe(false);

    // Apply persists the exclusion, and does NOT touch the units (no approved
    // replacements).
    await component.replaceApproved();
    await p;

    expect(applyMock).not.toHaveBeenCalled();
    expect(dictionary.create).toHaveBeenCalledWith({
      name: 'Darcy',
      language: EXCLUDED_WORD_LANGUAGE,
    });
  });

  it('navigates per name with ◀/▶ through case-sensitive, whole-word occurrences', async () => {
    const navigate = vi.fn();
    const p = dialog.open({
      units: [
        { key: 'n1', text: 'Elizabeth met elizabeth. Lizzie stayed.' },
        { key: 'n2', text: 'Elizabeth smiled.' },
      ],
      apply: applyMock,
      navigate,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    // exact-case, whole-word occurrences only → "elizabeth" and "Lizzie" are
    // NOT matches, so there are exactly 2 (n1 + n2).
    expect(component.navTotal(elizabeth)).toBe(2);
    expect(component.navPos(elizabeth)).toBe(0);

    // ▶ → first occurrence (n1), ▶ → second occurrence (n2).
    component.nextOccurrence(elizabeth);
    expect(navigate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: 'n1', localNth: 0, text: 'Elizabeth' }),
    );
    component.nextOccurrence(elizabeth);
    expect(navigate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: 'n2', localNth: 0, text: 'Elizabeth' }),
    );
    expect(component.navPos(elizabeth)).toBe(2);

    // ▶ wraps around to the first again.
    component.nextOccurrence(elizabeth);
    expect(navigate).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ key: 'n1', localNth: 0 }),
    );

    // ◀ wraps to the last.
    component.prevOccurrence(elizabeth);
    expect(navigate).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ key: 'n2', localNth: 0 }),
    );

    // ◀/▶ buttons are rendered in the row.
    const buttons = fixture.nativeElement.querySelectorAll('.nr-nav-btn');
    expect(buttons.length).toBeGreaterThanOrEqual(2);

    dialog.cancel();
    await p;
  });

  it('renders a draggable header and drags the dialog', async () => {
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const handle = fixture.nativeElement.querySelector('.nr-drag-handle') as HTMLElement;
    expect(handle).not.toBeNull();

    const down = new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 } as PointerEventInit);
    (handle as any).setPointerCapture = vi.fn();
    (handle as any).releasePointerCapture = vi.fn();
    handle.dispatchEvent(down);
    expect(component.dragging()).toBe(true);

    const move = new PointerEvent('pointermove', { clientX: 50, clientY: 60 } as PointerEventInit);
    handle.dispatchEvent(move);
    expect(component.dragPos().x).toBe(40);
    expect(component.dragPos().y).toBe(50);

    const up = new PointerEvent('pointerup', { clientX: 50, clientY: 60 } as PointerEventInit);
    handle.dispatchEvent(up);
    expect(component.dragging()).toBe(false);

    dialog.cancel();
    return p;
  });

  it('persists the dragged position and restores it on the next open', async () => {
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const handle = fixture.nativeElement.querySelector('.nr-drag-handle') as HTMLElement;
    (handle as any).setPointerCapture = vi.fn();
    (handle as any).releasePointerCapture = vi.fn();
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 } as PointerEventInit),
    );
    handle.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 50, clientY: 60 } as PointerEventInit),
    );
    handle.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 50, clientY: 60 } as PointerEventInit),
    );

    // The offset was written to localStorage when the drag ended.
    const stored = JSON.parse(localStorage.getItem('name-replace-dialog.pos')!);
    expect(stored).toEqual(component.dragPos());
    expect(stored.x).toBe(40);
    expect(stored.y).toBe(50);

    dialog.cancel();
    await p;
    fixture.destroy();

    // A fresh instance restores the stored offset when the dialog opens.
    fixture = TestBed.createComponent(NameReplaceDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    const p2 = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.dragPos()).toEqual({ x: 40, y: 50 });
    dialog.cancel();
    await p2;
  });

  it('clamps the drag so the dialog always stays at least partly visible', async () => {
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const handle = fixture.nativeElement.querySelector('.nr-drag-handle') as HTMLElement;
    (handle as any).setPointerCapture = vi.fn();
    (handle as any).releasePointerCapture = vi.fn();
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 } as PointerEventInit),
    );
    // Drag far past the bottom-right corner of the viewport.
    handle.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 99999, clientY: 99999 } as PointerEventInit),
    );
    handle.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 99999, clientY: 99999 } as PointerEventInit),
    );

    const KEEP = 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // jsdom reports a zero-size rect → the MIN dialog size is used as fallback.
    const width = 420;
    const height = 320;
    const baseLeft = (vw - width) / 2;
    const baseTop = (vh - height) / 2;
    const pos = component.dragPos();
    // At least KEEP px of the dialog stays inside the viewport on both axes.
    expect(baseLeft + pos.x).toBeLessThanOrEqual(vw - KEEP);
    expect(baseTop + pos.y).toBeLessThanOrEqual(vh - KEEP);

    dialog.cancel();
    await p;
  });

  it('re-clamps the position when the window is resized', async () => {
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Simulate a position that was valid on a huge screen.
    component.dragPos.set({ x: 5000, y: 5000 });
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();

    const KEEP = 120;
    const width = 420;
    const baseLeft = (window.innerWidth - width) / 2;
    expect(baseLeft + component.dragPos().x).toBeLessThanOrEqual(window.innerWidth - KEEP);

    dialog.cancel();
    await p;
  });

  it('defaults includeUnknown ON and filters the listbox by m/f/s checkboxes', async () => {
    expect(component.includeUnknown()).toBe(true);

    // A gender-aware dictionary: female "Elizabeth", male "Edward", surname "Ellis".
    const female = entry({ id: 'e1', name: 'Elizabeth', category: 'female', language: 'en' });
    const male = entry({ id: 'e2', name: 'Edward', category: 'male', language: 'en' });
    const surname = entry({ id: 'e3', name: 'Ellis', category: 'surname', language: 'en' });
    dictionary.entriesForLanguage = () => [female, male, surname];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth met Edward.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    // A FEMALE prename activates only F by default → male candidates filtered out.
    expect(elizabeth.filters).toEqual({ male: false, female: true, surname: false });
    expect(elizabeth.candidates).toEqual(['Elizabeth']);

    // Toggle the surname checkbox → surname candidates appear.
    component.setFilter(elizabeth, 'surname', true);
    expect(elizabeth.candidates).toContain('Ellis');

    // The m/f/s checkboxes are rendered (2 rows × 3 checkboxes).
    const kindInputs = fixture.nativeElement.querySelectorAll('.nr-col-kind input');
    expect(kindInputs.length).toBe(6);

    dialog.cancel();
    await p;
  });

  it('sorts by first occurrence in the text by default and can switch to alphabetical', async () => {
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth. Elizabeth smiled.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // "First occurrence" is the default: Liz appears before Elizabeth.
    expect(component.sortMode()).toBe('first');
    expect(component.rows().map((r) => r.form)).toEqual(['Liz', 'Elizabeth']);

    component.setSortMode('alpha');
    expect(component.rows().map((r) => r.form)).toEqual(['Elizabeth', 'Liz']);

    component.setSortMode('first');
    expect(component.rows().map((r) => r.form)).toEqual(['Liz', 'Elizabeth']);

    dialog.cancel();
    await p;
  });

  it('shows only surnames when the surname filter is on', async () => {
    const female = entry({ id: 'e1', name: 'Elizabeth', category: 'female', language: 'en' });
    const surname = entry({ id: 'e2', name: 'Rivers', category: 'surname', language: 'en' });
    dictionary.entriesForLanguage = () => [female, surname];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Rivers met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.rows().map((r) => r.form)).toEqual(['Rivers', 'Elizabeth']);

    component.setOnlySurnames(true);
    expect(component.onlySurnames()).toBe(true);
    // Only the positively known GIVEN name is hidden.
    expect(component.rows().map((r) => r.form)).toEqual(['Rivers']);

    component.setOnlySurnames(false);
    expect(component.rows().map((r) => r.form)).toEqual(['Rivers', 'Elizabeth']);

    dialog.cancel();
    await p;
  });

  it('"only surnames" keeps names with an UNKNOWN classification (they might be surnames)', async () => {
    const female = entry({ id: 'e1', name: 'Elizabeth', category: 'female', language: 'en' });
    const male = entry({ id: 'e2', name: 'Edward', category: 'male', language: 'en' });
    const surname = entry({ id: 'e3', name: 'Rivers', category: 'surname', language: 'en' });
    const place = entry({ id: 'e4', name: 'Riverton', category: 'place', language: 'en' });
    // A legacy entry without any category/marker: the kind of name is unknown.
    const uncategorised = entry({ id: 'e5', name: 'Rutherford', language: 'en' });
    dictionary.entriesForLanguage = () => [female, male, surname, place, uncategorised];

    const p = dialog.open({
      units: [{
        key: 'n1',
        // "Darcy" has NO dictionary entry → capital-letter detection only
        // (needs 2 occurrences, at least one NOT sentence-initial).
        text: 'Rivers met Elizabeth, Edward, Riverton, Rutherford and Darcy. Later, Darcy left.',
      }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.setOnlySurnames(true);
    const forms = component.rows().map((r) => r.form);
    // Surname candidates: classification unknown OR surname/place/brand.
    expect(forms).toContain('Rivers');
    expect(forms).toContain('Riverton');
    expect(forms).toContain('Rutherford');
    expect(forms).toContain('Darcy');
    // Known given names are hidden.
    expect(forms).not.toContain('Elizabeth');
    expect(forms).not.toContain('Edward');

    dialog.cancel();
    await p;
  });

  it('excludes a name from the name list FOREVER (dictionary write, not a handled entry)', async () => {
    const saveHandled = vi.fn(async (_names: string[]) => {});
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
      handled: [],
      saveHandled,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const liz = component.rows().find((r) => r.form === 'Liz')!;
    expect(liz.entry).not.toBeNull();
    // Name-list names can be excluded too — exclusion means "never a name again".
    component.toggleExcluded(liz);
    expect(liz.excluded).toBe(true);
    expect(liz.approved).toBe(false);

    await component.replaceApproved();
    await p;

    // Permanent, dictionary-level exclusion — and no per-chat handled entry.
    expect(applyMock).not.toHaveBeenCalled();
    expect(dictionary.create).toHaveBeenCalledWith({
      name: 'Liz',
      language: EXCLUDED_WORD_LANGUAGE,
    });
    expect(saveHandled).not.toHaveBeenCalled();
  });

  it('keeps excluded names out of the handled list even when an approval is applied too', async () => {
    const saveHandled = vi.fn(async (_names: string[]) => {});
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
      handled: [],
      saveHandled,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const liz = component.rows().find((r) => r.form === 'Liz')!;
    const elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;

    // Exclude one name, approve the other.
    component.toggleExcluded(liz);
    component.setProposed(elizabeth, 'Eliza');
    await component.replaceApproved();
    await p;

    // The exclusion went to the dictionary, the approval to the handled list.
    expect(dictionary.create).toHaveBeenCalledWith({
      name: 'Liz',
      language: EXCLUDED_WORD_LANGUAGE,
    });
    expect(saveHandled).toHaveBeenCalledWith(['Eliza']);
  });

  it('hides handled names and restores them from the handled panel', async () => {
    const saveHandled = vi.fn(async (_names: string[]) => {});
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
      handled: ['Liz'],
      saveHandled,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The already-handled name is not offered again …
    expect(component.rows().map((r) => r.form)).toEqual(['Elizabeth']);
    // … but it is listed in the handled panel with a restore button.
    const chip = fixture.nativeElement.querySelector('.nr-handled-chip') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain('Liz');

    await component.removeHandled('Liz');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(saveHandled).toHaveBeenCalledWith([]);
    expect(component.handled()).toEqual([]);
    expect(component.rows().map((r) => r.form).sort()).toEqual(['Elizabeth', 'Liz']);

    dialog.cancel();
    await p;
  });

  it('remembers approved names as handled on apply — by their REPLACEMENT', async () => {
    const saveHandled = vi.fn(async (_names: string[]) => {});
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
      handled: ['Rivers'],
      saveHandled,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const liz = component.rows().find((r) => r.form === 'Liz')!;
    component.setProposed(liz, 'Elizabeth');
    await component.replaceApproved();
    await p;

    // The text now carries "Elizabeth", so THAT is the name to remember —
    // storing "Liz" would leave the replacement to be offered again.
    expect(saveHandled).toHaveBeenCalledWith(['Rivers', 'Elizabeth']);
  });

  it('does not offer a replaced name again on the next open', async () => {
    const units = [{ key: 'n1', text: 'Liz met Elizabeth.' }];
    const handled: string[] = [];
    const saveHandled = vi.fn(async (names: string[]) => {
      handled.splice(0, handled.length, ...names);
    });

    // 1) Approve "Liz" → "Elizabeth" and apply.
    const p1 = dialog.open({ units, apply: applyMock, handled: [...handled], saveHandled });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const liz = component.rows().find((r) => r.form === 'Liz')!;
    component.setProposed(liz, 'Elizabeth');
    await component.replaceApproved();
    await p1;

    expect(handled).toEqual(['Elizabeth']);
    // The replacement really landed in the text …
    const updated = applyMock.mock.calls[0][0] as unknown as { key: string; text: string }[];
    expect(updated[0].text).toBe('Elizabeth met Elizabeth.');

    // 2) Re-open on the REPLACED text with the stored handled list: nothing
    //    is offered any more (the old "Liz" is gone, "Elizabeth" is handled).
    const p2 = dialog.open({
      units: updated.map((u) => ({ key: u.key, text: u.text })),
      apply: applyMock,
      handled: [...handled],
      saveHandled,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.rows()).toHaveLength(0);

    dialog.cancel();
    await p2;
  });

  it('uses a saved replacement as the proposal and accepts ONLY those proposals', async () => {
    savedReplacements = [
      {
        id: 'r-liz',
        from: 'Liz',
        to: 'Eliza',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const before = component.rows().find((r) => r.form === 'Liz')!;
    expect(before.proposed).toBe('Liz'); // no saved proposal applied yet

    // The button sets the remembered replacement as the proposal …
    component.useSavedReplacements();
    fixture.detectChanges();

    const liz = component.rows().find((r) => r.form === 'Liz')!;
    const elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    expect(liz.proposed).toBe('Eliza');
    expect(liz.fromSaved).toBe(true);
    expect(liz.approved).toBe(false);
    // A name without a saved replacement is untouched (the flag stays unset).
    expect(elizabeth.fromSaved).toBeUndefined();
    expect(elizabeth.proposed).toBe('Elizabeth');
    expect(component.savedProposalCount()).toBe(1);

    // "Accept proposals" approves ONLY the saved ones.
    component.acceptSavedProposals();
    fixture.detectChanges();

    expect(component.rows().find((r) => r.form === 'Liz')!.approved).toBe(true);
    expect(component.rows().find((r) => r.form === 'Elizabeth')!.approved).toBe(false);
    expect(component.approvedCount()).toBe(1);

    dialog.cancel();
    await p;
  });

  it('turns the saved-replacements button into a two-state button', async () => {
    savedReplacements = [
      {
        id: 'r-liz',
        from: 'Liz',
        to: 'Eliza',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('.nr-saved-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(component.savedProposalsFilled()).toBe(false);
    expect(btn.textContent).toContain('Use saved replacements');
    expect(btn.textContent).toContain('(1)');

    // FIRST click: fills the proposal but approves nothing.
    btn.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const filled = component.rows().find((r) => r.form === 'Liz')!;
    expect(filled.proposed).toBe('Eliza');
    expect(filled.fromSaved).toBe(true);
    expect(filled.approved).toBe(false);

    // The button now offers to ACTIVATE the proposals.
    expect(component.savedProposalsFilled()).toBe(true);
    expect(component.savedPendingCount()).toBe(1);
    expect(btn.textContent).toContain('Accept proposals');
    expect(btn.textContent).toContain('(1)');
    expect(btn.classList.contains('nr-saved-btn-active')).toBe(true);

    // SECOND click: approves the pending saved row (sets the checkbox).
    btn.click();
    fixture.detectChanges();
    await fixture.whenStable();

    // Re-read the row: accepting replaces the row objects.
    const approved = component.rows().find((r) => r.form === 'Liz')!;
    expect(approved.approved).toBe(true);
    expect(component.approvedCount()).toBe(1);
    // The button returns to its propose state.
    expect(component.savedProposalsFilled()).toBe(false);
    expect(btn.textContent).toContain('Use saved replacements');
    expect(btn.classList.contains('nr-saved-btn-active')).toBe(false);

    dialog.cancel();
    await p;
  });

  it('counts a manually changed proposal as already approved', async () => {
    // Two saved replacements; the user changes one proposal manually.
    savedReplacements = [
      {
        id: 'r-liz',
        from: 'Liz',
        to: 'Eliza',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'r-elizabeth',
        from: 'Elizabeth',
        to: 'Beth',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('.nr-saved-btn') as HTMLButtonElement;

    // FIRST click: both saved proposals are filled in.
    btn.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.savedPendingCount()).toBe(2);

    // The user changes ONE proposal manually → its checkbox is already set.
    const elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    component.setProposed(elizabeth, 'Lizzie');
    fixture.detectChanges();

    expect(elizabeth.approved).toBe(true);
    expect(elizabeth.fromSaved).toBe(false);
    // Only the remaining saved row is still pending.
    expect(component.savedPendingCount()).toBe(1);
    expect(btn.textContent).toContain('Accept proposals');
    expect(btn.textContent).toContain('(1)');

    // SECOND click: activates only the remaining saved row.
    btn.click();
    fixture.detectChanges();
    await fixture.whenStable();

    // Re-read the rows: accepting replaces the row objects.
    const liz = component.rows().find((r) => r.form === 'Liz')!;
    const edited = component.rows().find((r) => r.form === 'Elizabeth')!;
    expect(liz.approved).toBe(true);
    // The manually edited row keeps its own proposal.
    expect(edited.proposed).toBe('Lizzie');
    expect(component.approvedCount()).toBe(2);

    dialog.cancel();
    await p;
  });

  it('shows only the saved replacements that fit the current found names', async () => {
    // Three saved replacements exist in the database, but only "Liz" matches
    // the names found in this dialog.
    savedReplacements = [
      {
        id: 'r-liz',
        from: 'Liz',
        to: 'Eliza',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'r-bob',
        from: 'Bob',
        to: 'Robert',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'r-alice',
        from: 'Alice',
        to: 'Alicia',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The absolute count is 3, but only 1 saved replacement fits the found names.
    expect(component.savedCount()).toBe(3);
    expect(component.savedMatchCount()).toBe(1);

    const btn = fixture.nativeElement.querySelector('.nr-saved-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('(1)');
    expect(btn.textContent).not.toContain('(3)');
    expect(btn.disabled).toBe(false);

    // The saved-replacements panel lists ONLY the fitting replacement.
    const chips = fixture.nativeElement.querySelectorAll('.nr-saved-chip');
    expect(chips).toHaveLength(1);
    expect((chips[0] as HTMLElement).textContent).toContain('Liz');
    expect((chips[0] as HTMLElement).textContent).toContain('Eliza');

    dialog.cancel();
    await p;
  });

  it('hides the saved-replacements panel when no saved replacement fits', async () => {
    savedReplacements = [
      {
        id: 'r-bob',
        from: 'Bob',
        to: 'Robert',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.savedMatches()).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.nr-saved')).toBeNull();

    dialog.cancel();
    await p;
  });

  it('disables the saved replacements button when no saved replacement fits', async () => {
    savedReplacements = [
      {
        id: 'r-bob',
        from: 'Bob',
        to: 'Robert',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.savedCount()).toBe(1);
    expect(component.savedMatchCount()).toBe(0);
    const btn = fixture.nativeElement.querySelector('.nr-saved-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);

    dialog.cancel();
    await p;
  });

  it('persists an applied replacement in the database (from → to)', async () => {
    savedReplacements = [];
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const liz = component.rows().find((r) => r.form === 'Liz')!;
    component.setProposed(liz, 'Elizabeth');
    await component.replaceApproved();
    await p;

    expect(dictionary.saveReplacement).toHaveBeenCalledWith({
      from: 'Liz',
      to: 'Elizabeth',
      language: null,
    });
    expect(savedReplacements.map((r) => `${r.from}→${r.to}`)).toEqual(['Liz→Elizabeth']);
  });

  it('does not persist a "keep as is" approval (proposal equals the found form)', async () => {
    const p = dialog.open({
      units: [{ key: 'n1', text: 'Elizabeth smiled.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const elizabeth = component.rows().find((r) => r.form === 'Elizabeth')!;
    component.toggleApproved(elizabeth);
    await component.replaceApproved();
    await p;

    expect(dictionary.saveReplacement).not.toHaveBeenCalled();
  });

  it('forgets a saved replacement from the saved panel', async () => {
    savedReplacements = [
      {
        id: 'r-liz',
        from: 'Liz',
        to: 'Eliza',
        language: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Liz met Elizabeth.' }],
      apply: applyMock,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.nr-saved-chip')).not.toBeNull();

    await component.forgetSaved(savedReplacements[0]);
    fixture.detectChanges();

    expect(dictionary.deleteReplacement).toHaveBeenCalledWith('r-liz');
    expect(savedReplacements).toEqual([]);
    expect(fixture.nativeElement.querySelector('.nr-saved-chip')).toBeNull();

    dialog.cancel();
    await p;
  });

  it('does not offer an excluded unknown word again on the next open', async () => {
    // A stateful dictionary: `create` appends, like the real service does.
    const all: NameEntry[] = [];
    dictionary.entriesForLanguage = () => all;
    dictionary.create = vi.fn(async (data: { name: string; language: string | null }) => {
      const created = entry({ id: `x${all.length}`, name: data.name, language: data.language });
      all.push(created);
      return created;
    });

    const units = [{ key: 'n1', text: 'Darcy spoke. Later, Darcy smiled.' }];

    // First open: exclude the unknown word.
    const p1 = dialog.open({ units, apply: applyMock });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const darcy = component.rows().find((r) => r.form === 'Darcy')!;
    expect(darcy).toBeDefined();
    component.toggleExcluded(darcy);
    // Exclude-only Apply must be enabled and must persist the exclusion.
    await component.replaceApproved();
    await p1;

    expect(dictionary.create).toHaveBeenCalledWith({
      name: 'Darcy',
      language: EXCLUDED_WORD_LANGUAGE,
    });
    expect(all).toHaveLength(1);

    // Second open (fresh dialog state, same dictionary): the word is gone.
    const p2 = dialog.open({ units, apply: applyMock });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.rows().find((r) => r.form === 'Darcy')).toBeUndefined();

    dialog.cancel();
    await p2;
  });

  it('does not create a duplicate exclusion for an already excluded name', async () => {
    // The dictionary already knows the exclusion (and a regular name entry).
    const all: NameEntry[] = [
      entry({ id: 'k1', name: 'Rich', language: 'en', category: 'male' }),
      entry({ id: 'x1', name: 'Rich', language: EXCLUDED_WORD_LANGUAGE }),
    ];
    dictionary.entries = () => all;
    dictionary.entriesForLanguage = () => all;

    const p = dialog.open({
      units: [{ key: 'n1', text: 'Rich met Elizabeth.' }],
      apply: applyMock,
      language: 'en',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The excluded name is not offered at all — so nothing can be excluded
    // a second time and no duplicate dictionary row is created.
    expect(component.rows().find((r) => r.form === 'Rich')).toBeUndefined();
    expect(dictionary.create).not.toHaveBeenCalled();

    dialog.cancel();
    await p;
  });
});
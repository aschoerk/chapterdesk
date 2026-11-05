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
import { EXCLUDED_WORD_LANGUAGE, type NameEntry } from '../../models/name-entry';

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
  };
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
});
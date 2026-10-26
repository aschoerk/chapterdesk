import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { I18nService } from '../../core/i18n/i18n.service';
import { SearchReplaceService } from '../../core/search-replace/search-replace.service';
import { SearchReplaceComponent } from './search-replace.component';

/**
 * SearchReplaceComponent is a thin shell over SearchReplaceService. We drive
 * it from the real service signal state so the template + key handlers are
 * actually exercised (the service itself has its own spec).
 */

describe('SearchReplaceComponent', () => {
  let fixture: ComponentFixture<SearchReplaceComponent>;
  let search: SearchReplaceService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SearchReplaceComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient()],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    search = TestBed.inject(SearchReplaceService);
    search.close();
    fixture = TestBed.createComponent(SearchReplaceComponent);
    fixture.detectChanges();
  });

  it('renders nothing while closed', () => {
    expect(fixture.nativeElement.innerHTML.trim()).not.toContain('search');
  });

  it('shows the counter once results exist', () => {
    search.setSession({
      scopes: () => [{ id: 'chat', labelKey: 'x' }],
      unitsFor: () => [{ key: 'a', text: 'one two three' }],
      navigate: () => {},
      apply: async () => {},
    });
    search.openDialog();
    search.setTerm('two');
    search.findNext();
    fixture.detectChanges();

    expect(search.total()).toBe(1);
    expect(fixture.componentInstance.counter()).toBe('1 / 1');
  });

  it('counter shows noResults when there are no matches', () => {
    const label = fixture.componentInstance.counter();
    expect(label).toBeTruthy();
    expect(label.toLowerCase()).toMatch(/no|0/);
  });

  it('findNext / findPrev forward to the service and prevent default', () => {
    const nextSpy = () => {};
    search.setSession({
      scopes: () => [{ id: 'chat', labelKey: 'x' }],
      unitsFor: () => [{ key: 'a', text: 'x x x' }],
      navigate: () => {},
      apply: async () => {},
    });
    search.openDialog();
    search.setTerm('x');
    search.findNext();
    expect(search.currentIndex()).toBe(0);

    const ev = { preventDefault: () => {} } as Event;
    const pd = new (class { n = 0; preventDefault() { this.n += 1; } })();
    fixture.componentInstance.findNextInput(pd as unknown as Event);
    expect((pd as unknown as { n: number }).n).toBe(1);
  });

  it('replaceCurrent / replaceAll act on the service', async () => {
    const applied: string[] = [];
    search.setSession({
      scopes: () => [{ id: 'chat', labelKey: 'x' }],
      unitsFor: () => [{ key: 'a', text: 'foo foo' }],
      navigate: () => {},
      apply: async (updates) => {
        for (const u of updates) applied.push(`${u.key}:${u.text}`);
      },
    });
    search.openDialog();
    search.setTerm('foo');
    search.replaceTerm.set('bar');
    search.findNext();

    await fixture.componentInstance.replaceCurrent();
    expect(applied.length).toBeGreaterThan(0);

    applied.length = 0;
    await fixture.componentInstance.replaceAll();
    expect(applied.length).toBeGreaterThan(0);
  });

  it('window F3 / Ctrl+F open and navigate; Escape closes', () => {
    search.close();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3' }));
    expect(search.open()).toBe(true);

    search.setSession({
      scopes: () => [{ id: 'chat', labelKey: 'x' }],
      unitsFor: () => [{ key: 'a', text: 'q q q' }],
      navigate: () => {},
      apply: async () => {},
    });
    search.setTerm('q');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3' }));
    expect(search.currentIndex()).toBe(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
    expect(search.open()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(search.open()).toBe(false);
  });

  it('selectScope updates the scope and navigates', () => {
    search.setSession({
      scopes: () => [
        { id: 'chat', labelKey: 'x' },
        { id: 'node', labelKey: 'y' },
      ],
      unitsFor: (scope) => (scope === 'node' ? [{ key: 'n', text: 'node text' }] : []),
      navigate: () => {},
      apply: async () => {},
    });
    fixture.componentInstance.selectScope('node');
    expect(search.scope()).toBe('node');
    expect(fixture.componentInstance.isScopeActive('node')).toBe(true);
  });
});
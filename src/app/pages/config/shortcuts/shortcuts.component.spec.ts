import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ShortcutsComponent } from './shortcuts.component';
import { I18nService } from '../../../core/i18n/i18n.service';

describe('ShortcutsComponent', () => {
  let fixture: ComponentFixture<ShortcutsComponent>;
  let component: ShortcutsComponent;

  beforeEach(async () => {
    localStorage.removeItem('chat.view.locale');

    await TestBed.configureTestingModule({
      imports: [ShortcutsComponent],
      providers: [provideZonelessChangeDetection()]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');

    fixture = TestBed.createComponent(ShortcutsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('lists all shortcut groups in document order', () => {
    expect(component.groups().map(g => g.title)).toEqual([
      'View & zoom',
      'Writing',
      'Stories view',
      'Reader (book view)',
      'Paced reading (while running)',
      'Search',
      'Story tree (when sections are selected)',
      'Dialogs & images'
    ]);
  });

  it('documents the page zoom keys', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Zoom in');
    expect(text).toContain('Ctrl + +');
    expect(text).toContain('Ctrl + -');
    expect(text).toContain('Ctrl + 0');
  });

  it('renders keycaps for every row', () => {
    const keycaps = (fixture.nativeElement as HTMLElement).querySelectorAll('.shortcut-keys kbd');
    const rowCount = component.groups().reduce((sum, g) => sum + g.rows.length, 0);
    expect(keycaps.length).toBe(rowCount);
    expect(keycaps.length).toBeGreaterThan(20);
  });

  it('switches the key map to German', () => {
    component.i18n.setLocale('de');
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Tastaturkürzel');
    expect(text).toContain('Ansicht & Zoom');
    expect(text).toContain('Strg + +');
  });
});

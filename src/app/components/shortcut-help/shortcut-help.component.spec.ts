import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ShortcutHelpComponent } from './shortcut-help.component';
import { ShortcutHelpService } from '../../core/dialogs/shortcut-help.service';
import { I18nService } from '../../core/i18n/i18n.service';

describe('ShortcutHelpComponent', () => {
  let fixture: ComponentFixture<ShortcutHelpComponent>;
  let service: ShortcutHelpService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [ShortcutHelpComponent]
    }).compileComponents();
    // Deterministic locale so the keycap assertions below are stable.
    TestBed.inject(I18nService).setLocale('en');
    service = TestBed.inject(ShortcutHelpService);
    service.close();
    fixture = TestBed.createComponent(ShortcutHelpComponent);
    fixture.detectChanges();
  });

  it('renders nothing while closed', () => {
    expect(fixture.nativeElement.querySelector('.shortcut-dialog')).toBeNull();
  });

  it('opens and lists the documented shortcuts from the playbook list', () => {
    service.openDialog();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.shortcut-dialog')).not.toBeNull();

    const keyEls = fixture.nativeElement.querySelectorAll('.shortcut-keys kbd') as NodeListOf<Element>;
    const keys = Array.from(keyEls, (el) => el.textContent?.trim() ?? '');
    // The compact list matches UX playbook §7 (plus the reader / tree extras).
    expect(keys).toContain('Ctrl+Enter');
    expect(keys).toContain('Ctrl+S');
    expect(keys).toContain('Ctrl+B');
    expect(keys).toContain('Ctrl+F');
    expect(keys).toContain('F3 / Shift+F3');
    expect(keys).toContain('Esc');
  });

  it('closes via the Close button', () => {
    service.openDialog();
    fixture.detectChanges();
    const close = fixture.nativeElement.querySelector('.shortcut-actions .btn') as HTMLButtonElement;
    close.click();
    fixture.detectChanges();
    expect(service.open()).toBe(false);
    expect(fixture.nativeElement.querySelector('.shortcut-dialog')).toBeNull();
  });

  it('closes on backdrop click', () => {
    service.openDialog();
    fixture.detectChanges();
    const backdrop = fixture.nativeElement.querySelector('.shortcut-backdrop') as HTMLElement;
    backdrop.click();
    fixture.detectChanges();
    expect(service.open()).toBe(false);
  });

  it('closes on Escape', () => {
    service.openDialog();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(service.open()).toBe(false);
  });

  it('ignores other keys while open', () => {
    service.openDialog();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(service.open()).toBe(true);
  });

  it('is a no-op on Escape while closed', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(service.open()).toBe(false);
  });
});
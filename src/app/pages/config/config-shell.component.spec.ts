import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { ConfigShellComponent } from './config-shell.component';
import { I18nService } from '../../core/i18n/i18n.service';

describe('ConfigShellComponent', () => {
  let fixture: ComponentFixture<ConfigShellComponent>;
  let component: ConfigShellComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfigShellComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([])
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');

    fixture = TestBed.createComponent(ConfigShellComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the five sidebar nav entries', () => {
    // The tool links reuse the item styling, so exclude them here.
    const links = (fixture.nativeElement as HTMLElement)
      .querySelectorAll('.config-nav-item:not(.config-nav-tool)');
    expect(links.length).toBe(5);
    expect(component.tabs.map(t => t.path)).toEqual([
      '/config/appearance',
      '/config/providers',
      '/config/tasks',
      '/config/prompts',
      '/config/shortcuts'
    ]);
  });

  it('labels match the expected subpages', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Appearance');
    expect(text).toContain('Providers / Models');
    expect(text).toContain('Generation Tasks');
    expect(text).toContain('Prompt defaults');
    expect(text).toContain('Keyboard shortcuts');
  });

  it('offers the translator as a tool link below the settings entries', () => {
    const el = fixture.nativeElement as HTMLElement;
    const tools = el.querySelectorAll('.config-nav-tool');
    expect(tools.length).toBe(1);
    expect(tools[0].textContent).toContain('Translator');
    expect(tools[0].getAttribute('href')).toBe('/translate');
    expect(component.tools).toEqual([{ path: '/translate', labelKey: 'config.nav.translator' }]);
    // The tool sits AFTER the settings entries, separated by a divider.
    expect(el.querySelectorAll('.config-nav-divider').length).toBe(1);
  });
});
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings/settings.service';
import { SetupWizardService } from '../../core/dialogs/setup-wizard.service';
import { SetupWizardComponent } from './setup-wizard.component';

describe('SetupWizardComponent', () => {
  let fixture: ComponentFixture<SetupWizardComponent>;
  let component: SetupWizardComponent;
  let wizard: SetupWizardService;

  beforeEach(async () => {
    localStorage.removeItem('chat.setupWizard.dismissed');
    localStorage.removeItem('chat.demoData.loadedV1');
    await TestBed.configureTestingModule({
      imports: [SetupWizardComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    wizard = TestBed.inject(SetupWizardService);
    fixture = TestBed.createComponent(SetupWizardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when the wizard is closed', () => {
    expect(fixture.nativeElement.querySelector('.setup-dialog')).toBeNull();
  });

  it('shows the welcome step with skip + continue', async () => {
    const p = wizard.open();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.setup-dialog')).not.toBeNull();
    expect(el.textContent).toContain('Welcome to ChapterDesk');
    expect(el.textContent).toContain('Skip for now');
    expect(el.querySelectorAll('.btn.primary').length).toBeGreaterThan(0);
    wizard.skip();
    await p;
  });

  it('navigates through the wizard steps', async () => {
    const p = wizard.open();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    wizard.go('provider');
    fixture.detectChanges();
    expect(el.textContent).toContain('AI provider');
    expect(el.textContent).toContain('API key');

    wizard.go('models');
    fixture.detectChanges();
    expect(el.textContent).toContain('Default model');

    wizard.go('demo');
    fixture.detectChanges();
    expect(el.textContent).toContain('Demo data');

    wizard.skip();
    await p;
  });

  it('offers the key-free mock option on the provider step', async () => {
    const p = wizard.open();
    fixture.detectChanges();
    wizard.go('provider');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Play with the built-in mock model (no key)');
    wizard.skip();
    await p;
  });

  it('lists the fetched models on the models step', async () => {
    const p = wizard.open();
    fixture.detectChanges();
    wizard.patch({
      providerId: 'prov-1',
      models: [
        {
          id: 'm-1',
          displayName: 'Claude X',
          modelId: 'claude-x',
          providerId: 'prov-1',
          type: 'fetched',
          enabled: true
        }
      ]
    });
    wizard.go('models');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Claude X');
    wizard.skip();
    await p;
  });

  it('finish resolves "configured" and closes', async () => {
    const p = wizard.open();
    fixture.detectChanges();
    wizard.go('demo');
    fixture.detectChanges();
    await wizard.finish();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.setup-dialog')).toBeNull();
    expect(await p).toBe('configured');
  });
});
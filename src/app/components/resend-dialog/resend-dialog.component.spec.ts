import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { I18nService } from '../../core/i18n/i18n.service';
import { ResendDialogService } from '../../core/dialogs/resend-dialog.service';
import { LlmLogEntry } from '../../core/llm/llm-log.service';
import { ModelEntry } from '../../models/chat-config';
import { ResendDialogComponent } from './resend-dialog.component';

describe('ResendDialogComponent', () => {
  let fixture: ComponentFixture<ResendDialogComponent>;
  let component: ResendDialogComponent;
  let dialog: ResendDialogService;

  const entry: LlmLogEntry = {
    seq: 1,
    ts: Date.now(),
    iso: new Date().toISOString(),
    kind: 'chat',
    modelId: 'openai/gpt-4o-mini',
    provider: 'https://openrouter.ai/api/v1',
    chatId: 'chat-1',
    chatTitle: 'The Great Tale',
    messages: [
      { role: 'system', content: 'You are a writer.' },
      { role: 'user', content: 'Continue the story.' },
    ],
    summary: '[llm:chat] model=…',
  };

  const models: ModelEntry[] = [
    { id: 'm1', displayName: 'Original Model', modelId: 'openai/gpt-4o-mini', providerId: 'p1', type: 'preset', enabled: true },
    { id: 'm2', displayName: 'Better Model', modelId: 'openai/gpt-4o', providerId: 'p1', type: 'preset', enabled: true },
  ];

  function openState(messages?: { role: string; text: string }[], modelId = 'openai/gpt-4o-mini') {
    return dialog.open({
      entry,
      messages: messages ?? [{ role: 'user', text: 'Continue the story.' }],
      models,
      modelId,
    });
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ResendDialogComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient()]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(ResendDialogService);
    fixture = TestBed.createComponent(ResendDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when the dialog is closed', () => {
    expect(fixture.nativeElement.querySelector('.resend-dialog')).toBeNull();
  });

  it('shows the entry’s messages as editable textareas with roles', async () => {
    const p = openState([
      { role: 'system', text: 'You are a writer.' },
      { role: 'user', text: 'Continue the story.' },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.resend-dialog')).not.toBeNull();
    const textareas = fixture.nativeElement.querySelectorAll('textarea') as NodeListOf<HTMLTextAreaElement>;
    expect(textareas.length).toBe(2);
    expect(textareas[0].value).toBe('You are a writer.');
    expect(textareas[1].value).toBe('Continue the story.');
    const roles = fixture.nativeElement.querySelectorAll('.resend-role');
    expect(roles[0].textContent?.trim()).toBe('system');
    expect(roles[1].textContent?.trim()).toBe('user');

    dialog.cancel();
    await p;
  });

  it('shows the chat title, model and provider as read-only badges', async () => {
    const p = openState([{ role: 'user', text: 'Continue.' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('The Great Tale');
    expect(text).toContain('openai/gpt-4o-mini');
    expect(text).toContain('https://openrouter.ai/api/v1');

    dialog.cancel();
    await p;
  });

  it('lists the enabled models in the model select, defaulting to the original call model', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe('openai/gpt-4o-mini');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent?.trim());
    expect(options).toEqual(['Original Model', 'Better Model']);

    dialog.cancel();
    await p;
  });

  it('submit resolves with the edited messages + chosen model and closes', async () => {
    const p = openState([
      { role: 'system', text: 'You are a writer.' },
      { role: 'user', text: 'Continue the story.' },
    ]);
    fixture.detectChanges();

    component.onTextChange(1, 'Continue the story — but make it darker.');
    component.onModelChange('openai/gpt-4o');
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toEqual({
      messages: [
        { role: 'system', text: 'You are a writer.' },
        { role: 'user', text: 'Continue the story — but make it darker.' },
      ],
      modelId: 'openai/gpt-4o',
    });
    expect(fixture.nativeElement.querySelector('.resend-dialog')).toBeNull();
  });

  it('cancel resolves null and closes', async () => {
    const p = openState([{ role: 'user', text: 'Continue.' }]);
    fixture.detectChanges();
    dialog.cancel();
    await expect(p).resolves.toBeNull();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.resend-dialog')).toBeNull();
  });

  it('Escape closes the dialog and resolves null (same as cancel)', async () => {
    const p = openState([{ role: 'user', text: 'Continue.' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.resend-dialog')).not.toBeNull();

    component.onDocumentKey({
      key: 'Escape',
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);
    fixture.detectChanges();

    await expect(p).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.resend-dialog')).toBeNull();
  });

  it('ignores Escape while the dialog is closed', () => {
    const preventDefault = vi.fn();
    component.onDocumentKey({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('shows a hint when the request carried media/file parts that are preserved', async () => {
    const withParts = {
      ...entry,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
        ],
      }],
    };
    const p = dialog.open({
      entry: withParts,
      messages: [{ role: 'user', text: '', parts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } }] }],
      models,
      modelId: 'openai/gpt-4o-mini',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('media/file part(s)');

    dialog.cancel();
    await p;
  });
});

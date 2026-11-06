import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { MarkNoteDialogService } from '../../core/dialogs/mark-note-dialog.service';
import { MarkNoteDialogComponent } from './mark-note-dialog.component';

describe('MarkNoteDialogComponent — notice for a reading mark', () => {
  let fixture: ComponentFixture<MarkNoteDialogComponent>;
  let component: MarkNoteDialogComponent;
  let dialog: MarkNoteDialogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MarkNoteDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(MarkNoteDialogService);
    fixture = TestBed.createComponent(MarkNoteDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden while no mark is being created', () => {
    expect(fixture.nativeElement.querySelector('.mark-note-dialog')).toBeNull();
  });

  it('shows the marked text for a selection mark', async () => {
    const p = dialog.open({ quote: 'the old tower', isPosition: false });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Notice for the marked text');
    expect(fixture.nativeElement.querySelector('.mark-note-quote')?.textContent)
      .toContain('the old tower');

    dialog.cancel();
    await p;
  });

  it('explains that no text was marked for a bare position', async () => {
    const p = dialog.open({ isPosition: true });
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Notice for this position');
    expect(fixture.nativeElement.querySelector('.mark-note-quote')).toBeNull();

    dialog.cancel();
    await p;
  });

  it('saves the typed notice (trimmed) and closes', async () => {
    const p = dialog.open({ isPosition: true });
    fixture.detectChanges();

    component.note.set('  check this later  ');
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toBe('check this later');
    expect(fixture.nativeElement.querySelector('.mark-note-dialog')).toBeNull();
  });

  it('resolves null on cancel (no mark is created)', async () => {
    const p = dialog.open({ isPosition: true });
    fixture.detectChanges();
    dialog.cancel();
    await expect(p).resolves.toBeNull();
  });

  it('Escape at document level cancels even without focus inside', async () => {
    const p = dialog.open({ isPosition: true });
    fixture.detectChanges();

    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(ev);

    await expect(p).resolves.toBeNull();
  });

  it('Ctrl+Enter saves without leaving the textarea', async () => {
    const p = dialog.open({ isPosition: true });
    fixture.detectChanges();
    component.note.set('via shortcut');

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
    );

    await expect(p).resolves.toBe('via shortcut');
  });
});

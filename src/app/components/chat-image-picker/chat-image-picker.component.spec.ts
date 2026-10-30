import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeAttachment } from '../../../../test-helpers/factories';
import { I18nService } from '../../core/i18n/i18n.service';
import { ChatImagePickerService } from '../../core/dialogs/chat-image-picker.service';
import { ChatImageEntry } from '../../core/chat/chat-images.service';
import { ChatImagePickerComponent } from './chat-image-picker.component';

describe('ChatImagePickerComponent', () => {
  let fixture: ComponentFixture<ChatImagePickerComponent>;
  let component: ChatImagePickerComponent;
  let picker: ChatImagePickerService;

  const entries: ChatImageEntry[] = [
    {
      attachment: makeAttachment({ id: 'i1', name: 'one.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUFB' }),
      nodeId: 'a1', nodeRole: 'assistant', nodeLabel: 'Chapter one'
    },
    {
      attachment: makeAttachment({ id: 'i2', name: 'two.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QkJC' }),
      nodeId: 'a2', nodeRole: 'assistant', nodeLabel: 'Chapter two'
    }
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatImagePickerComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    picker = TestBed.inject(ChatImagePickerService);
    fixture = TestBed.createComponent(ChatImagePickerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when the picker is closed', () => {
    expect(fixture.nativeElement.querySelector('.picker-dialog')).toBeNull();
  });

  it('lists the chat images and resolves the selection on submit', async () => {
    const p = picker.open(entries);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.picker-item');
    expect(items.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('Chapter one');
    expect(fixture.nativeElement.textContent).toContain('Chapter two');

    // Select the second image and confirm.
    (items[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    const add = fixture.nativeElement.querySelector('.picker-actions .btn.primary') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    add.click();

    await expect(p).resolves.toEqual([entries[1].attachment]);
    expect(picker.current()).toBeNull();
  });

  it('resolves null on cancel', async () => {
    const p = picker.open(entries);
    fixture.detectChanges();

    const cancel = fixture.nativeElement.querySelector('.picker-actions .btn:not(.primary)') as HTMLButtonElement;
    cancel.click();

    await expect(p).resolves.toBeNull();
  });
});
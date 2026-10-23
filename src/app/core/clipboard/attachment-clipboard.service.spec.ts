import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { AttachmentClipboardService } from './attachment-clipboard.service';
import { makeAttachment } from '../../../../test-helpers/factories';

describe('AttachmentClipboardService', () => {
  let service: AttachmentClipboardService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        AttachmentClipboardService,
      ],
    }).compileComponents();
    service = TestBed.inject(AttachmentClipboardService);
  });

  it('is empty by default', () => {
    expect(service.hasContent()).toBe(false);
    expect(service.count()).toBe(0);
    expect(service.action()).toBeNull();
  });

  it('stages a copy and reports the staged ids', () => {
    const a = makeAttachment({ id: 'att-1' });
    service.copy('node-a', 'chat-1', [a]);
    expect(service.hasContent()).toBe(true);
    expect(service.count()).toBe(1);
    expect(service.action()).toBe('copy');
    expect(service.isStaged('att-1')).toBe(true);
    expect(service.isCutAttachment('att-1')).toBe(false);
  });

  it('stages a cut WITHOUT touching the source attachment (nothing is removed here)', () => {
    const a = makeAttachment({ id: 'att-1' });
    service.cut('node-a', 'chat-1', [a]);
    expect(service.action()).toBe('cut');
    expect(service.isCutAttachment('att-1')).toBe(true);
    expect(service.isStaged('att-1')).toBe(true);
    // The staged payload is a defensive copy — mutating the original input
    // must not change what the clipboard holds.
    a.name = 'changed.txt';
    const staged = service.clipboard()!.attachments[0];
    expect(staged.name).toBe('notes.txt');
  });

  it('drops empty stages and clears cleanly', () => {
    service.copy('node-a', 'chat-1', []);
    expect(service.hasContent()).toBe(false);
    service.copy('node-a', 'chat-1', [makeAttachment({ id: 'x' })]);
    expect(service.hasContent()).toBe(true);
    service.clear();
    expect(service.hasContent()).toBe(false);
    expect(service.isCutAttachment('x')).toBe(false);
  });
});

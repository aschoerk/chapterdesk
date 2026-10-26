import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings/settings.service';
import { ChapterDescriptionsDialogService } from '../../core/dialogs/chapter-descriptions-dialog.service';
import { ChapterDescriptionsDialogComponent } from './chapter-descriptions-dialog.component';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';

function makeNode(id: string) {
  return {
    id,
    chatId: 'c1',
    parentId: null,
    role: 'user' as const,
    content: 'Q?',
    version: 1,
    isCurrent: true,
    createdAt: new Date().toISOString(),
    attachments: [],
  };
}

describe('ChapterDescriptionsDialogComponent', () => {
  let fixture: ComponentFixture<ChapterDescriptionsDialogComponent>;
  let dialog: ChapterDescriptionsDialogService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [ChapterDescriptionsDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(ChapterDescriptionsDialogService);
    dialog.cancel();
    fixture = TestBed.createComponent(ChapterDescriptionsDialogComponent);
    fixture.detectChanges();
  });

  it('is empty while no dialog is open', () => {
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('seeds fields from the service when opened', () => {
    // open() only resolves on submit/cancel — do not await it here.
    void dialog.open({
      chatId: 'c1',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: 'm1',
      defaultProviderId: 'p1',
    });
    fixture.detectChanges();

    const comp = fixture.componentInstance;
    expect(comp.chapterCount()).toBe(10);
    expect(comp.sentencesPerChapter()).toBe(5);
    expect(comp.firstChapter()).toBe(1);
    dialog.cancel();
  });

  it('submit() resolves the dialog with clamped field values and remembers them', async () => {
    const promise = dialog.open({
      chatId: 'c1',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: 'm1',
      defaultProviderId: 'p1',
    });
    fixture.detectChanges();

    const comp = fixture.componentInstance;
    comp.chapterCount.set(3);
    comp.sentencesPerChapter.set(2);
    comp.firstChapter.set(4);
    comp.goal.set('  end the war  ');
    comp.modelId.set('m1');
    comp.providerId.set('p1');
    comp.submit();

    const result = await promise;
    expect(result).toMatchObject({
      chapterCount: 3,
      sentencesPerChapter: 2,
      firstChapter: 4,
      goal: 'end the war',
      modelId: 'm1',
      providerId: 'p1',
    });
  });

  it('clamps bogus numeric input to 1', async () => {
    const promise = dialog.open({
      chatId: 'c1',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: 'm1',
      defaultProviderId: 'p1',
    });
    fixture.detectChanges();
    const comp = fixture.componentInstance;
    comp.chapterCount.set(NaN);
    comp.sentencesPerChapter.set(-5);
    comp.firstChapter.set(0);
    comp.modelId.set('m1');
    comp.submit();
    expect(await promise).toMatchObject({ chapterCount: 1, sentencesPerChapter: 1, firstChapter: 1 });
  });

  it('does not submit without a model and alerts instead', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const promise = dialog.open({
      chatId: 'c1',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: '',
      defaultProviderId: '',
    });
    fixture.detectChanges();
    const comp = fixture.componentInstance;
    comp.modelId.set('');
    comp.submit();
    expect(alertSpy).toHaveBeenCalled();
    expect(dialog.current()).not.toBeNull();
    alertSpy.mockRestore();
    dialog.cancel();
  });

  it('remembers last parameters per chat across open/submit', async () => {
    // First open → submit with params.
    const first = dialog.open({
      chatId: 'c1',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: 'm1',
      defaultProviderId: 'p1',
    });
    fixture.detectChanges();
    let comp = fixture.componentInstance;
    comp.chapterCount.set(8);
    comp.sentencesPerChapter.set(3);
    comp.modelId.set('m1');
    comp.submit();
    await first;

    // Second open for the same chat gets the remembered values.
    const second = dialog.open({
      chatId: 'c1',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: 'm2',
      defaultProviderId: 'p2',
    });
    fixture.detectChanges();
    comp = fixture.componentInstance;
    expect(comp.chapterCount()).toBe(8);
    expect(comp.sentencesPerChapter()).toBe(3);
    // First chapter continues: first (1) + chapterCount (8) = 9
    expect(comp.firstChapter()).toBe(9);
    dialog.cancel();
    await second;
  });

  it('cancel() closes with null and Escape cancels', async () => {
    const promise = dialog.open({
      chatId: 'c1',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: 'm1',
      defaultProviderId: 'p1',
    });
    fixture.detectChanges();
    dialog.cancel();
    expect(await promise).toBeNull();

    const again = dialog.open({
      chatId: 'c2',
      chat: null,
      node: makeNode('n1'),
      defaultModelId: 'm1',
      defaultProviderId: 'p1',
    });
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await again).toBeNull();
  });

  it('onModelChange sets the provider from the enabled model', async () => {
    const comp = fixture.componentInstance;
    comp.onModelChange('some-model-id');
    // With an empty settings model list the provider clears to ''.
    expect(comp.providerId()).toBe('');
  });
});
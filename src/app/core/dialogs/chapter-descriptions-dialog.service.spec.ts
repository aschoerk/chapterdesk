import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ChatNode } from '../../models/chat';
import { ChapterDescriptionsDialogService } from './chapter-descriptions-dialog.service';
import { createModalState } from './modal-state';

/**
 * ChapterDescriptionsDialogService remembers the last dialog parameters per
 * chat (localStorage) and the last chosen model globally, and pre-fills the
 * next open with them (bumping the first chapter number).
 */

function node(id: string): ChatNode {
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

describe('ChapterDescriptionsDialogService', () => {
  let svc: ChapterDescriptionsDialogService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ChapterDescriptionsDialogService);
    svc.cancel();
  });

  it('open() resolves with the submitted result', async () => {
    const p = svc.open({
      chatId: 'c1',
      chat: null,
      node: node('n1'),
      defaultModelId: 'm',
      defaultProviderId: 'p',
    });
    expect(svc.current()).not.toBeNull();
    svc.submit({
      chapterCount: 5,
      sentencesPerChapter: 3,
      firstChapter: 1,
      goal: 'go',
      modelId: 'm',
      providerId: 'p',
    });
    expect(await p).toMatchObject({ chapterCount: 5, firstChapter: 1, goal: 'go' });
    expect(svc.current()).toBeNull();
  });

  it('open() uses defaults on first call and remembered values after', async () => {
    const first = svc.open({
      chatId: 'c1',
      chat: null,
      node: node('n1'),
      defaultModelId: 'm',
      defaultProviderId: 'p',
    });
    expect(svc.current()).toMatchObject({ chapterCount: 10, sentencesPerChapter: 5, firstChapter: 1 });
    svc.submit({
      chapterCount: 4,
      sentencesPerChapter: 2,
      firstChapter: 6,
      goal: 'g',
      modelId: 'm',
      providerId: 'p',
    });
    await first;

    const second = svc.open({
      chatId: 'c1',
      chat: null,
      node: node('n2'),
      defaultModelId: 'other',
      defaultProviderId: 'p2',
    });
    // Remembers the params and bumps the first chapter.
    expect(svc.current()).toMatchObject({
      chapterCount: 4,
      sentencesPerChapter: 2,
      firstChapter: 10, // 6 + 4
      goal: 'g',
      modelId: 'm', // remembered model wins over the new default
    });
    svc.cancel();
    await second;
  });

  it('remembered params are scoped per chat', async () => {
    const first = svc.open({ chatId: 'A', chat: null, node: node('n1'), defaultModelId: 'm', defaultProviderId: 'p' });
    svc.submit({ chapterCount: 9, sentencesPerChapter: 1, firstChapter: 1, goal: '', modelId: 'm', providerId: 'p' });
    await first;

    const otherChat = svc.open({ chatId: 'B', chat: null, node: node('n1'), defaultModelId: 'm', defaultProviderId: 'p' });
    expect(svc.current()).toMatchObject({ chapterCount: 10, firstChapter: 1 });
    svc.cancel();
    await otherChat;
  });

  it('cancel() closes with null and submit() without an open dialog is a no-op', () => {
    svc.cancel(); // must not throw
    expect(svc.current()).toBeNull();
    svc.submit({ chapterCount: 1, sentencesPerChapter: 1, firstChapter: 1, goal: '', modelId: 'm', providerId: 'p' });
    expect(svc.current()).toBeNull();
  });

  it('corrupt localStorage params are ignored', async () => {
    localStorage.setItem('chat.chapterDescriptions.paramsByChatId', '{not valid json');
    const p = svc.open({ chatId: 'X', chat: null, node: node('n3'), defaultModelId: 'm', defaultProviderId: 'p' });
    // Falls back to defaults instead of throwing.
    expect(svc.current()).toMatchObject({ chapterCount: 10, firstChapter: 1 });
    svc.cancel();
    await p;
  });

  it('createModalState is the underlying modal primitive', () => {
    const m = createModalState<{ a: number }, string>();
    const p = m.open({ a: 1 });
    expect(m.current()?.a).toBe(1);
    m.close('ok');
    expect(m.current()).toBeNull();
    void p;
  });
});
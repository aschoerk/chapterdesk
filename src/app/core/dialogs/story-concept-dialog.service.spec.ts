import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ChatNode } from '../../models/chat';
import { StoryConceptDialogService } from './story-concept-dialog.service';

/**
 * StoryConceptDialogService remembers the last dialog inputs per chat and the
 * last chosen model globally, and pre-fills the next open with them.
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

const OPEN = {
  chatId: 'c1',
  chat: null,
  node: node('n1'),
  defaultModelId: 'm',
  defaultProviderId: 'p',
};

describe('StoryConceptDialogService', () => {
  let svc: StoryConceptDialogService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(StoryConceptDialogService);
    svc.cancel();
  });

  it('open() resolves with the submitted result', async () => {
    const p = svc.open(OPEN);
    expect(svc.current()).not.toBeNull();
    svc.submit({
      prompt: '  A heist on the moon  ',
      personaIds: ['pers-1'],
      personas: [{ id: 'pers-1', name: 'Mara', shortName: 'M', description: 'Thief' }],
      chapterCount: 6,
      targetWords: 60000,
      modelId: 'm',
      providerId: 'p',
    });
    const result = await p;
    expect(result).toMatchObject({ prompt: 'A heist on the moon', chapterCount: 6, targetWords: 60000 });
    expect(result?.personas).toHaveLength(1);
    expect(svc.current()).toBeNull();
  });

  it('uses empty defaults on the first call and remembers the inputs after', async () => {
    const first = svc.open(OPEN);
    expect(svc.current()).toMatchObject({
      prompt: '',
      personaIds: [],
      chapterCount: null,
      targetWords: null,
    });
    svc.submit({
      prompt: 'Clockwork city',
      personaIds: ['pers-1', 'pers-2'],
      personas: [],
      chapterCount: 12,
      targetWords: 80000,
      modelId: 'm',
      providerId: 'p',
    });
    await first;

    const second = svc.open({ ...OPEN, node: node('n2'), defaultModelId: 'other', defaultProviderId: 'p2' });
    expect(svc.current()).toMatchObject({
      prompt: 'Clockwork city',
      personaIds: ['pers-1', 'pers-2'],
      chapterCount: 12,
      targetWords: 80000,
      modelId: 'm', // remembered model wins over the new default
    });
    svc.cancel();
    await second;
  });

  it('normalizes empty / invalid numbers to null', async () => {
    const p = svc.open(OPEN);
    svc.submit({
      prompt: '',
      personaIds: [],
      personas: [],
      chapterCount: 0,
      targetWords: -5,
      modelId: 'm',
      providerId: 'p',
    });
    expect(await p).toMatchObject({ chapterCount: null, targetWords: null });
  });

  it('remembered inputs are scoped per chat', async () => {
    const first = svc.open({ ...OPEN, chatId: 'A' });
    svc.submit({
      prompt: 'Only in A',
      personaIds: [],
      personas: [],
      chapterCount: 3,
      targetWords: null,
      modelId: 'm',
      providerId: 'p',
    });
    await first;

    const other = svc.open({ ...OPEN, chatId: 'B' });
    expect(svc.current()).toMatchObject({ prompt: '', chapterCount: null });
    svc.cancel();
    await other;
  });

  it('corrupt localStorage inputs are ignored', async () => {
    localStorage.setItem('chat.storyConcept.paramsByChatId', '{not valid json');
    const p = svc.open({ ...OPEN, chatId: 'X' });
    expect(svc.current()).toMatchObject({ prompt: '', personaIds: [], chapterCount: null });
    svc.cancel();
    await p;
  });

  it('cancel() closes with null and submit() without an open dialog is a no-op', () => {
    svc.cancel(); // must not throw
    expect(svc.current()).toBeNull();
    svc.submit({
      prompt: '',
      personaIds: [],
      personas: [],
      chapterCount: 1,
      targetWords: null,
      modelId: 'm',
      providerId: 'p',
    });
    expect(svc.current()).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { ModelRecencyService } from './model-recency.service';

const LS_KEY = 'chat.view.recentModelIds';

describe('ModelRecencyService', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty', () => {
    const recency = new ModelRecencyService();
    expect(recency.recentIds()).toEqual([]);
  });

  it('puts the most recently used model first', () => {
    const recency = new ModelRecencyService();

    recency.remember('alpha/model');
    recency.remember('beta/model');

    expect(recency.recentIds()).toEqual(['beta/model', 'alpha/model']);
  });

  it('moves a re-used model to the front without duplicating it', () => {
    const recency = new ModelRecencyService();
    recency.remember('alpha/model');
    recency.remember('beta/model');
    recency.remember('gamma/model');

    recency.remember('alpha/model');

    expect(recency.recentIds()).toEqual(['alpha/model', 'gamma/model', 'beta/model']);
  });

  it('caps the list at six models', () => {
    const recency = new ModelRecencyService();
    for (let i = 0; i < 12; i++) recency.remember(`model-${i}`);

    const ids = recency.recentIds();
    expect(ids).toHaveLength(6);
    expect(ids[0]).toBe('model-11');
    expect(ids).not.toContain('model-0');
  });

  it('ignores empty ids', () => {
    const recency = new ModelRecencyService();
    recency.remember('');
    recency.remember('   ');
    recency.remember(null);
    recency.remember(undefined);
    expect(recency.recentIds()).toEqual([]);
  });

  it('persists the list and restores it on the next start', () => {
    const recency = new ModelRecencyService();
    recency.remember('alpha/model');
    recency.remember('beta/model');

    expect(JSON.parse(localStorage.getItem(LS_KEY)!) as string[])
      .toEqual(['beta/model', 'alpha/model']);

    const restored = new ModelRecencyService();
    expect(restored.recentIds()).toEqual(['beta/model', 'alpha/model']);
  });

  it('tolerates corrupt or foreign storage values', () => {
    localStorage.setItem(LS_KEY, 'not json');
    expect(new ModelRecencyService().recentIds()).toEqual([]);

    localStorage.setItem(LS_KEY, JSON.stringify({ a: 1 }));
    expect(new ModelRecencyService().recentIds()).toEqual([]);

    localStorage.setItem(LS_KEY, JSON.stringify(['ok/model', 42, '', null]));
    expect(new ModelRecencyService().recentIds()).toEqual(['ok/model']);
  });

  it('clear() empties the list and the storage', () => {
    const recency = new ModelRecencyService();
    recency.remember('alpha/model');

    recency.clear();

    expect(recency.recentIds()).toEqual([]);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });
});

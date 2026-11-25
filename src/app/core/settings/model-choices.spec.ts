import { describe, it, expect } from 'vitest';
import { orderChoiceGroups, orderModelChoices } from './model-choices';
import { makeModel } from '../../../../test-helpers/factories';

const labels = { current: 'Current', recent: 'Recent', all: 'All' };

const ALPHA = makeModel({ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' });
const BETA = makeModel({ id: 'm-2', displayName: 'Beta', modelId: 'beta/model' });
const GAMMA = makeModel({ id: 'm-3', displayName: 'Gamma', modelId: 'gamma/model' });

describe('model-choices', () => {
  describe('orderModelChoices', () => {
    it('returns one plain group when nothing is current or recent', () => {
      expect(orderModelChoices([ALPHA, BETA], '', [], labels)).toEqual([
        { title: 'All', models: [ALPHA, BETA] },
      ]);
    });

    it('orders current → recent → rest and never repeats an entry', () => {
      const groups = orderModelChoices(
        [ALPHA, BETA, GAMMA], 'alpha/model', ['beta/model', 'alpha/model'], labels,
      );

      expect(groups.map(g => g.title)).toEqual(['Current', 'Recent', 'All']);
      expect(groups[0].models.map(m => m.modelId)).toEqual(['alpha/model']);
      expect(groups[1].models.map(m => m.modelId)).toEqual(['beta/model']);
      expect(groups[2].models.map(m => m.modelId)).toEqual(['gamma/model']);
    });

    it('matches by catalog row id too', () => {
      const groups = orderModelChoices([ALPHA, BETA], 'm-2', [], labels);
      expect(groups[0].models[0]).toBe(BETA);
    });

    it('ignores ids that are not in the given list', () => {
      const groups = orderModelChoices([ALPHA], 'gone/model', ['gone/model'], labels);
      expect(groups).toEqual([{ title: 'All', models: [ALPHA] }]);
    });

    it('returns no groups for an empty model list', () => {
      expect(orderModelChoices([], 'alpha/model', ['beta/model'], labels)).toEqual([]);
    });
  });

  describe('orderChoiceGroups', () => {
    it('works for foreign option shapes with a custom matcher', () => {
      const options = [
        { id: 'alpha/model', label: 'Alpha' },
        { id: 'beta/model', label: 'Beta' },
        { id: 'gamma/model', label: 'Gamma' },
      ];

      const groups = orderChoiceGroups(
        options, 'beta/model', ['gamma/model'], labels,
        (o, id) => o.id === id,
      );

      expect(groups.map(g => g.title)).toEqual(['Current', 'Recent', 'All']);
      expect(groups[0].items.map(o => o.id)).toEqual(['beta/model']);
      expect(groups[1].items.map(o => o.id)).toEqual(['gamma/model']);
      expect(groups[2].items.map(o => o.id)).toEqual(['alpha/model']);
    });
  });
});

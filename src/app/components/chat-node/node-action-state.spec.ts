import { describe, it, expect } from 'vitest';
import { NodeActionState } from './node-action-state';

describe('NodeActionState', () => {
  it('starts idle', () => {
    const state = new NodeActionState();
    expect(state.idle).toBe(true);
    expect(state.loading()).toBe(false);
    expect(state.pending()).toBeNull();
  });

  it('begin() marks the action and blocks a second one', () => {
    const state = new NodeActionState();
    expect(state.begin('image')).toBe(true);
    expect(state.idle).toBe(false);
    expect(state.pending()).toBe('image');
    expect(state.isRunning('image')).toBe(true);
    expect(state.isRunning('send')).toBe(false);

    // One action at a time: a second begin is refused and does not change kind.
    expect(state.begin('send')).toBe(false);
    expect(state.pending()).toBe('image');
  });

  it('end() clears both flags so the next action can start', () => {
    const state = new NodeActionState();
    state.begin('send');
    state.end();
    expect(state.idle).toBe(true);
    expect(state.loading()).toBe(false);
    expect(state.pending()).toBeNull();
    expect(state.begin('version')).toBe(true);
  });
});

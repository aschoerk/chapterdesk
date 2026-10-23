import { describe, expect, it } from 'vitest';
import { createModalState } from './modal-state';

interface FormData {
  label: string;
  count: number;
}

describe('createModalState', () => {
  it('open sets current and resolves the value on close', async () => {
    const m = createModalState<FormData, string>();
    const p = m.open({ label: 'go', count: 2 });
    expect(m.current()).not.toBeNull();
    expect(m.current()!.label).toBe('go');
    m.close('done');
    expect(await p).toBe('done');
    expect(m.current()).toBeNull();
  });

  it('cancel closes with null', async () => {
    const m = createModalState<FormData, string>();
    const p = m.open({ label: 'x', count: 1 });
    m.close(null);
    expect(await p).toBeNull();
    expect(m.current()).toBeNull();
  });

  it('close is a no-op when no dialog is open', () => {
    const m = createModalState<FormData, string>();
    m.close('done'); // must not throw
    expect(m.current()).toBeNull();
  });

  it('only the LAST open is resolvable (re-open replaces state)', async () => {
    const m = createModalState<FormData, string>();
    const first = m.open({ label: 'first', count: 1 });
    const second = m.open({ label: 'second', count: 2 });
    // The first promise never resolves (its resolver was replaced).
    m.close('second-done');
    expect(await second).toBe('second-done');
    expect(m.current()).toBeNull();
    // First stays pending forever — acceptable for our single-instance dialogs.
    let settled = false;
    void first.then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(false);
  });

  it('the current entry carries the data fields (for the component to read)', async () => {
    const m = createModalState<FormData, string>();
    void m.open({ label: 'hello', count: 7 });
    const cur = m.current()!;
    expect(cur.label).toBe('hello');
    expect(cur.count).toBe(7);
    expect(typeof cur.resolve).toBe('function');
    m.close(null);
  });
});
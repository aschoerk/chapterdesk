import { signal, type Signal } from '@angular/core';

/** Resolver stored inside a modal's current entry. */
export type ModalResolver<TResult> = (value: TResult | null) => void;

/** A modal entry: the data fields plus the resolver. */
export type ModalEntry<TData, TResult> = TData & { resolve: ModalResolver<TResult> };

/** The shared open/current/close plumbing of a promise-based modal. */
export interface ModalState<TData, TResult> {
  readonly current: Signal<ModalEntry<TData, TResult> | null>;
  /** Open with `data`; resolves with the result, or null on cancel. */
  open(data: TData): Promise<TResult | null>;
  /** Resolve the open entry (and clear it). No-op when meanwhile closed. */
  close(result: TResult | null): void;
}

/**
 * Shared state machine for the app's promise-based dialog services.
 *
 * Every dialog service used to hand-roll the same plumbing:
 *   readonly current = signal<... | null>(null);
 *   open(...)      → new Promise(resolve => current.set({ ...data, resolve }));
 *   submit/close() → const cur = current(); current.set(null); cur.resolve(x);
 *   cancel()       → same but with null.
 *
 * This factory centralizes that identical plumbing. Each service keeps its OWN
 * public API (the open/submit/cancel method names + any persistence) and just
 * delegates the set/clear/resolve tail to `modal.open`/`modal.close`.
 *
 * NOTE: not every dialog service fits this shape — `confirm` resolves a
 * boolean with no `cancel`/null path, `lightbox` is a pure state holder (no
 * promise), and `setup-wizard` is a re-openable mutable workflow. Those keep
 * their own logic.
 */
export function createModalState<TData, TResult>(): ModalState<TData, TResult> {
  const current = signal<ModalEntry<TData, TResult> | null>(null);

  function open(data: TData): Promise<TResult | null> {
    return new Promise(resolve => {
      current.set({ ...data, resolve } as ModalEntry<TData, TResult>);
    });
  }

  function close(result: TResult | null): void {
    const cur = current();
    if (!cur) return;
    current.set(null);
    cur.resolve(result);
  }

  return { current, open, close };
}
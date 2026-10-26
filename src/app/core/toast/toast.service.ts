import { Injectable, signal } from '@angular/core';

/**
 * Kind of a non-modal toast. `error` is for failed operations, `info` for
 * neutral/progress-ish notices and `success` for confirmed outcomes.
 *
 * The distinction matters for the UX playbooks: errors near the point of
 * failure should be non-modal (never block the streaming flow), and a model
 * refusal must surface its reason — a toast shows the actual reply text.
 */
export type ToastKind = 'info' | 'success' | 'error';

export interface ToastMessage {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
}

/**
 * Small, non-modal notification host used by the steering-loop failures
 * (send / stream / illustrate / structure / rewrite / regenerate) instead of
 * the blocking native `window.alert`. Rendered by `ToastHostComponent`
 * (mounted once in the app root). Toasts auto-dismiss after a kind-dependent
 * duration and can always be dismissed manually.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private idSeq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  /** The toasts currently on screen, newest last (stacked at bottom-right). */
  readonly toasts = signal<ToastMessage[]>([]);

  /** Show a raw toast. `durationMs` overrides the kind default. */
  show(kind: ToastKind, text: string, durationMs?: number): void {
    const id = ++this.idSeq;
    this.toasts.update(list => [...list, { id, kind, text }]);
    const timer = setTimeout(() => this.dismiss(id), durationMs ?? this.defaultFor(kind));
    this.timers.set(id, timer);
  }

  /** Neutral notice (e.g. a rewrite was appended instead of inserted). */
  info(text: string, durationMs?: number): void {
    this.show('info', text, durationMs);
  }

  /** Confirmed outcome (e.g. a partial storyboard completed). */
  success(text: string, durationMs?: number): void {
    this.show('success', text, durationMs);
  }

  /** A failed operation — the default steering-loop failure surface. */
  error(text: string, durationMs?: number): void {
    this.show('error', text, durationMs);
  }

  /** Remove a toast (also cancels its auto-dismiss timer). */
  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts.update(list => list.filter(t => t.id !== id));
  }

  /** Remove every toast (used by tests and when leaving the app). */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.toasts.set([]);
  }

  private defaultFor(kind: ToastKind): number {
    switch (kind) {
      case 'error': return 7000;
      case 'success': return 3500;
      default: return 4500;
    }
  }
}
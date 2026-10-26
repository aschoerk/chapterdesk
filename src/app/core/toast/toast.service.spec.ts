import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  let toast: ToastService;

  beforeEach(() => {
    toast = TestBed.inject(ToastService);
  });

  afterEach(() => {
    toast.clear();
    vi.useRealTimers();
  });

  it('queues toasts in order with sequential ids', () => {
    toast.show('error', 'boom');
    toast.error('oops');
    expect(toast.toasts().map(t => [t.kind, t.text])).toEqual([
      ['error', 'boom'],
      ['error', 'oops']
    ]);
    expect(toast.toasts()[0].id).toBeLessThan(toast.toasts()[1].id);
  });

  it('exposes info / success / error helpers with the right kinds', () => {
    toast.info('i');
    toast.success('s');
    toast.error('e');
    expect(toast.toasts().map(t => t.kind)).toEqual(['info', 'success', 'error']);
  });

  it('honours an explicit per-toast duration override', () => {
    vi.useFakeTimers();
    toast.info('persistent', 20000);
    vi.advanceTimersByTime(10000);
    expect(toast.toasts().length).toBe(1);
    vi.advanceTimersByTime(10000);
    expect(toast.toasts().length).toBe(0);
  });

  it('dismiss removes a single toast', () => {
    toast.info('a');
    toast.error('b');
    const first = toast.toasts()[0].id;
    toast.dismiss(first);
    expect(toast.toasts().map(t => t.text)).toEqual(['b']);
  });

  it('dismiss on an unknown id is a no-op', () => {
    toast.info('a');
    toast.dismiss(9999);
    expect(toast.toasts().length).toBe(1);
  });

  it('clear removes every toast', () => {
    toast.info('a');
    toast.error('b');
    toast.clear();
    expect(toast.toasts().length).toBe(0);
  });

  it('auto-dismisses after the kind default duration', () => {
    vi.useFakeTimers();
    toast.success('s'); // 3500ms
    expect(toast.toasts().length).toBe(1);
    vi.advanceTimersByTime(3600);
    expect(toast.toasts().length).toBe(0);
  });

  it('dismiss cancels the auto-dismiss timer', () => {
    vi.useFakeTimers();
    toast.error('e');
    toast.dismiss(toast.toasts()[0].id);
    vi.advanceTimersByTime(10000);
    expect(toast.toasts().length).toBe(0);
  });
});
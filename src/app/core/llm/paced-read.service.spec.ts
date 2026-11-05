import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatViewPrefsService } from '../chat/chat-view-prefs.service';
import { PacedReadService } from './paced-read.service';

/**
 * Deterministic frame loop: `requestAnimationFrame(cb)` queues `cb`, and
 * `flushFrames(ts)` runs everything queued so far with a fake timestamp.
 * The delta between two timestamps is the pacing time — exactly how the
 * reveal pump measures speed.
 */
interface FrameQueue {
  raf: (cb: FrameRequestCallback) => number;
  flushFrames(ts: number): void;
}

function makeFrames(): FrameQueue {
  const queue: FrameRequestCallback[] = [];
  let nextId = 1;
  return {
    raf: cb => {
      queue.push(cb);
      return nextId++;
    },
    flushFrames(ts: number) {
      const pending = queue.splice(0);
      for (const cb of pending) cb(ts);
    }
  };
}

/** Let the async item/queue chain settle between frame batches. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('PacedReadService — reveal existing text at the reading pace', () => {
  let frames: FrameQueue;
  let prefs: ChatViewPrefsService;
  let service: PacedReadService;

  beforeEach(() => {
    localStorage.clear();
    frames = makeFrames();
    vi.stubGlobal('requestAnimationFrame', frames.raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [ChatViewPrefsService, PacedReadService] });
    prefs = TestBed.inject(ChatViewPrefsService);
    service = TestBed.inject(PacedReadService);
    prefs.streamSpeedUnit.set('char');
    prefs.streamSpeed.set(5); // 5 chars/s
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('reveals the current item unit by unit and renders other items in full', async () => {
    const done = service.start([{ key: 'a', text: 'abcdefghij' }]);
    expect(service.active()).toBe(true);
    expect(service.isCurrent('a')).toBe(true);
    expect(service.displayText('a', 'abcdefghij')).toBe('');
    expect(service.displayText('b', 'xyz')).toBe('xyz');

    await flushMicrotasks(); // the reveal pump is created on the next tick
    frames.flushFrames(1000); // first frame: dt 0
    expect(service.revealedText()).toBe('');
    frames.flushFrames(2000); // 1 second → 5 characters
    expect(service.revealedText()).toBe('abcde');
    expect(service.displayText('a', 'abcdefghij')).toBe('abcde');

    service.stop();
    await done;
    expect(service.active()).toBe(false);
    expect(service.displayText('a', 'abcdefghij')).toBeNull();
  });

  it('pause freezes the reveal and resume continues from the same position', async () => {
    const done = service.start([{ key: 'a', text: 'abcdefghij' }]);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000);
    expect(service.revealedText()).toBe('abcde');

    service.pause();
    expect(service.paused()).toBe(true);
    frames.flushFrames(3000);
    frames.flushFrames(4000);
    expect(service.revealedText()).toBe('abcde'); // frozen while paused

    service.resume();
    expect(service.paused()).toBe(false);
    frames.flushFrames(5000); // first frame after resume: dt 0
    frames.flushFrames(6000); // 1 second more → the rest
    expect(service.revealedText()).toBe('abcdefghij');

    await done;
    expect(service.active()).toBe(false);
  });

  it('skipSeconds(+1) skips a second ahead and skipSeconds(-1) repeats it', async () => {
    const done = service.start([{ key: 'a', text: 'abcdefghij' }]);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000); // 'abcde'
    expect(service.revealedText()).toBe('abcde');

    service.skipSeconds(1); // +5 chars → end
    expect(service.revealedText()).toBe('abcdefghij');

    service.skipSeconds(-1); // -5 chars → repeat the last second
    expect(service.revealedText()).toBe('abcde');

    service.stop();
    await done;
  });

  it('skipLines(+1/-1) moves the reveal head by whole lines', async () => {
    const done = service.start([{ key: 'a', text: 'one\ntwo\nthree' }]);
    await flushMicrotasks();
    frames.flushFrames(1000);

    service.skipLines(1); // through the first newline
    expect(service.revealedText()).toBe('one\n');
    service.skipLines(1);
    expect(service.revealedText()).toBe('one\ntwo\n');
    service.skipLines(-1); // back one line
    expect(service.revealedText()).toBe('one\n');
    service.skipLines(-1);
    expect(service.revealedText()).toBe('');

    service.stop();
    await done;
  });

  it('advances to the next item automatically and keeps the finished one in full', async () => {
    const done = service.start([
      { key: 'a', text: 'abcde' },
      { key: 'b', text: 'vwxyz' }
    ]);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000); // 'abcde' complete
    await flushMicrotasks();

    expect(service.currentKey()).toBe('b');
    expect(service.currentIndex()).toBe(1);
    expect(service.total()).toBe(2);
    expect(service.isCurrent('b')).toBe(true);
    expect(service.displayText('a', 'abcde')).toBe('abcde');
    expect(service.displayText('b', 'vwxyz')).toBe('');

    frames.flushFrames(3000);
    frames.flushFrames(4000); // 'vwxyz' complete
    await done;
    expect(service.active()).toBe(false);
  });

  it('falls back to a readable default pace when the slider is 0 (instant)', async () => {
    prefs.streamSpeed.set(0);
    prefs.streamSpeedUnit.set('word');
    expect(service.secondUnits()).toBe(3); // 3 words/s ≈ 180 wpm

    const done = service.start([{ key: 'a', text: 'one two three four five' }]);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000);
    // 3 words/s → three whole words commit; the next word shows growing.
    expect(service.revealedText()).toBe('one two three four');

    service.stop();
    await done;
  });
});

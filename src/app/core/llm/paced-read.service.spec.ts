import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { ChatService } from '../chat/chat.service';
import { ChatViewPrefsService } from '../chat/chat-view-prefs.service';
import { PacedReadService, type PacedReadHost } from './paced-read.service';

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
    TestBed.configureTestingModule({
      providers: [
        ChatViewPrefsService,
        ChatService,
        PacedReadService,
        { provide: CHAT_API, useValue: new InMemoryChatApi() },
        provideRouter([])
      ]
    });
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

  it('starts the next read at a pending position (chapter + character offset)', async () => {
    service.setNextReadPosition('b', 3);
    expect(service.hasNextReadPositionAt('b')).toBe(true);

    const done = service.start([
      { key: 'a', text: 'aaaaa' },
      { key: 'b', text: 'abcdefghij' }
    ]);
    // The queue begins at 'b' with the first 3 characters already revealed.
    expect(service.currentKey()).toBe('b');
    expect(service.total()).toBe(1);
    expect(service.revealedText()).toBe('abc');
    // One-shot: consumed, so the NEXT read starts normally again.
    expect(service.pendingStart()).toBeNull();

    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000); // 5 more chars from the offset
    expect(service.revealedText()).toBe('abcdefgh');

    service.stop();
    await done;
  });

  it('relocate() moves a PAUSED read to the new spot and stays paused there', async () => {
    const items = [
      { key: 'a', text: 'aaaaaaaaaa' },
      { key: 'b', text: 'bbbbbbbbbb' }
    ];
    const done = service.start(items);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000);
    expect(service.currentKey()).toBe('a');

    service.pause();
    expect(service.paused()).toBe(true);

    // "Set next read position" while paused applies immediately.
    const relocated = service.relocate(items, 'b', 4);
    expect(service.active()).toBe(true);
    expect(service.paused()).toBe(true);
    expect(service.currentKey()).toBe('b');
    expect(service.revealedText()).toBe('bbbb');
    expect(service.resumePoint()?.nodeId).toBe('b');
    // Let the reveal pump for the relocated item be created (it is built on
    // the next microtask, frozen because the session is paused).
    await flushMicrotasks();

    // Nothing advances while still paused.
    frames.flushFrames(3000);
    frames.flushFrames(4000);
    expect(service.revealedText()).toBe('bbbb');

    // Resume continues from the relocated spot.
    service.resume();
    frames.flushFrames(5000);
    frames.flushFrames(6000);
    expect(service.revealedText()).toBe('bbbbbbbbb');

    service.stop();
    await relocated;
    await done;
  });

  it('relocate() keeps a RUNNING read running', async () => {
    const items = [{ key: 'a', text: 'aaaaaaaaaa' }, { key: 'b', text: 'bbbbbbbbbb' }];
    const done = service.start(items);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000);

    const relocated = service.relocate(items, 'b', 2);
    expect(service.paused()).toBe(false);
    expect(service.currentKey()).toBe('b');
    expect(service.revealedText()).toBe('bb');

    await flushMicrotasks();
    frames.flushFrames(3000);
    frames.flushFrames(4000);
    expect(service.revealedText()).toBe('bbbbbbb');

    service.stop();
    await relocated;
    await done;
  });

  it('clamps a pending offset to the chapter length and clears on stop', async () => {
    service.setNextReadPosition('a', 9999);
    expect(service.hasNextReadPositionAt('a')).toBe(true);

    const done = service.start([{ key: 'a', text: 'abcde' }]);
    expect(service.revealedText()).toBe('abcd'); // never starts already-complete
    expect(service.pendingStart()).toBeNull();

    service.stop();
    await done;
  });

  it('pause remembers the place and resume hands it back to the reading view', async () => {
    const restore = vi.fn();
    const host: PacedReadHost = {
      view: 'chat',
      capture: () => ({ view: 'chat', chatId: null, nodeId: service.currentKey(), scrollTop: 420 }),
      restore
    };
    service.registerHost(host);

    const done = service.start([{ key: 'a', text: 'abcdefghij' }]);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000);

    service.pause();
    expect(service.resumePoint()).toEqual({
      view: 'chat', chatId: null, nodeId: 'a', scrollTop: 420
    });

    // The user wandered off and came back: resume replays the position.
    const tick = service.followTick();
    service.resume();
    expect(restore).toHaveBeenCalledWith({ view: 'chat', chatId: null, nodeId: 'a', scrollTop: 420 });
    expect(service.paused()).toBe(false);
    // Follow-scroll is re-armed so the view returns to the reading position.
    expect(service.followTick()).toBeGreaterThan(tick);

    service.stop();
    await done;
    expect(service.resumePoint()).toBeNull();
  });

  it('leaving the reading view pauses the run and remembers the place', async () => {
    const host: PacedReadHost = {
      view: 'chat',
      capture: () => ({ view: 'chat', chatId: null, nodeId: service.currentKey(), scrollTop: 99 }),
      restore: vi.fn()
    };
    service.registerHost(host);
    expect(service.viewLinked()).toBe(true);

    const done = service.start([{ key: 'a', text: 'abcdefghij' }]);
    await flushMicrotasks();
    frames.flushFrames(1000);
    frames.flushFrames(2000);
    const frozen = service.revealedText();

    // Route change: the chat component is destroyed.
    service.unregisterHost(host);
    expect(service.viewLinked()).toBe(false);
    expect(service.paused()).toBe(true);
    expect(service.resumePoint()?.scrollTop).toBe(99);

    frames.flushFrames(3000);
    frames.flushFrames(4000);
    expect(service.revealedText()).toBe(frozen); // nothing reveals in the background

    service.stop();
    await done;
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

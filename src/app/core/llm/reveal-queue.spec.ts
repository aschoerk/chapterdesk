import { describe, expect, it, vi, afterEach } from 'vitest';
import { RevealQueue, type RevealQueueSlot } from './reveal-queue';
import type { StreamRevealPrefs } from './stream-reveal';

/** Manual rAF loop (same harness as stream-reveal.spec / held-answer-stream.spec). */
interface FrameQueue {
  raf: (cb: FrameRequestCallback) => number;
  queue: FrameRequestCallback[];
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
    queue,
    flushFrames(ts: number) {
      const pending = queue.splice(0);
      for (const cb of pending) cb(ts);
    }
  };
}
function stubFrames(frames: FrameQueue): void {
  vi.stubGlobal('requestAnimationFrame', frames.raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

function makePrefs() {
  const state = { speed: 1, unit: 'char' as 'char' | 'word', pace: true };
  const prefs: StreamRevealPrefs = {
    streamSpeed: () => state.speed,
    streamSpeedUnit: () => state.unit,
    paceAfterComplete: () => state.pace
  };
  return { state, prefs };
}

describe('RevealQueue — decoupled presenter with background buffers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('only the HEAD slot paints; background slots buffer invisibly', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { prefs } = makePrefs();

    const paints: Record<string, string[]> = {};
    const queue = new RevealQueue(prefs, (slot, content) => {
      (paints[slot.id] ??= []).push(content);
    });

    const a = queue.enqueue('a'); // head (live)
    const b = queue.enqueue('b'); // background
    expect(a.isFront).toBe(true);
    expect(b.isFront).toBe(false);

    a.update('Hello', '');
    b.update('World', '');
    frames.flushFrames(1000);
    frames.flushFrames(2000);

    // Only A revealed; B never painted anything.
    expect(paints['a']?.length).toBeGreaterThan(0);
    expect(paints['b']).toBeUndefined();
  });

  it('the live head never reveals ahead of the producer (slows to input speed)', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { prefs } = makePrefs(); // speed 1 char/s

    const paints: string[] = [];
    const queue = new RevealQueue(prefs, (_slot, content) => paints.push(content));
    const a = queue.enqueue('a');

    // Producer delivers ONLY 2 chars, then stops for a long while. However
    // much time passes, the presenter can never reveal more than the 2 chars
    // actually available — it slows to the input speed instead of jumping
    // ahead to fill the whole reveal budget.
    a.update('He', '');
    frames.flushFrames(1000);
    for (let ts = 2000; ts <= 10000; ts += 500) frames.flushFrames(ts);

    expect(paints.length).toBeGreaterThan(0);
    for (const painted of paints) {
      expect(painted.length).toBeLessThanOrEqual(2);
    }
  });

  it('finish(head) drains the tail then auto-advances to the next background slot', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { prefs } = makePrefs();
    prefs.streamSpeed(); // speed 1

    const queue = new RevealQueue(prefs, () => {});
    const a = queue.enqueue('a'); // head
    a.update('Hello', '');        // 5 chars, speed 1

    // Enqueue + pre-fill the next background slot BEFORE A drains.
    const b = queue.enqueue('b');
    b.update('Hi', '');

    const done = a.finish('Hello', '');
    // Drive A's tail reveal to completion (5 chars @ 1/s).
    let resolved = false;
    const p = done.then(() => { resolved = true; });
    for (let ts = 1000; ts <= 10000 && !resolved; ts += 1000) frames.flushFrames(ts);
    await p;
    expect(resolved).toBe(true);

    // A drained → the queue advanced: B became the head and is now live.
    expect(queue.current()?.id).toBe('b');
    expect(b.isFront).toBe(true);
  });

  it('after advancing, the promoted slot reveals live on further updates', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { prefs } = makePrefs();

    const paints: Record<string, string[]> = {};
    const queue = new RevealQueue(prefs, (slot, content) => {
      (paints[slot.id] ??= []).push(content);
    });

    const a = queue.enqueue('a');
    a.update('X', '');
    const b = queue.enqueue('b');
    b.update('Hi', '');
    expect(paints['b']).toBeUndefined(); // still buffering

    const done = a.finish('X', '');
    let resolved = false;
    const p = done.then(() => { resolved = true; });
    for (let ts = 1000; ts <= 5000 && !resolved; ts += 1000) frames.flushFrames(ts);
    await p;

    // After promotion B is live — a new producer update now paints it.
    b.update('Hi world', '');
    for (let ts = 6000; ts <= 12000; ts += 1000) frames.flushFrames(ts);
    expect(paints['b']?.length).toBeGreaterThan(0);
  });

  it('destroy removes a slot without activating the next (abort tears the queue down)', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const paints: Record<string, string[]> = {};
    const queue = new RevealQueue(makePrefs().prefs, (slot, content) => {
      (paints[slot.id] ??= []).push(content);
    });
    const a = queue.enqueue('a');
    const b = queue.enqueue('b');
    a.destroy();
    a.destroy(); // idempotent-ish
    // Destroying the head evicts it but does NOT auto-activate the next slot:
    // B is now the queue head, but it was never promoted, so it still buffers.
    expect(queue.size).toBe(1);
    expect(queue.current()?.id).toBe('b');
    b.update('Hi', '');
    frames.flushFrames(1000);
    frames.flushFrames(2000);
    expect(paints['b']).toBeUndefined(); // still held — no painting
  });
});
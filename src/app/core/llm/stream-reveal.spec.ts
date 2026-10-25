import { describe, expect, it, vi, afterEach } from 'vitest';
import { StreamReveal, type StreamRevealPrefs } from './stream-reveal';

/**
 * A tiny manual rAF loop: `requestAnimationFrame(cb)` queues `cb` and
 * `flushFrames(ts)` runs everything queued so far with a fake timestamp. This
 * lets us drive the pump deterministically (delta between timestamps = pacing
 * time) exactly like `vi.useFakeTimers` + a real rAF would, but more reliably
 * in node.
 */
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

/** Mutable prefs (mirrors the signals behind ChatService). */
function makePrefs() {
  const state = { speed: 0, unit: 'char' as 'char' | 'word', pace: false };
  const prefs: StreamRevealPrefs = {
    streamSpeed: () => state.speed,
    streamSpeedUnit: () => state.unit,
    paceAfterComplete: () => state.pace
  };
  return { state, prefs };
}

function stubFrames(frames: FrameQueue): void {
  vi.stubGlobal('requestAnimationFrame', frames.raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

describe('StreamReveal — char speed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reveals one character per second at a streamSpeed of 1', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.speed = 1; // chars/s

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));
    reveal.update('Hello', '');

    frames.flushFrames(1000); // first frame after kick: dt 0, nothing advances
    expect(reveal.revealed).toBe(0);
    expect(paints[paints.length - 1]).toBe('');

    frames.flushFrames(2000); // 1 second later → 1 char
    expect(reveal.revealed).toBe(1);

    frames.flushFrames(3000); // → 2 chars
    frames.flushFrames(4000); // → 3 chars
    expect(reveal.revealed).toBe(3);
    expect(paints[paints.length - 1]).toBe('Hel');

    reveal.destroy();
  });

  it('paces 4 characters/second as one char per 250ms frame', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.speed = 4;

    const reveal = new StreamReveal(prefs, () => {});
    reveal.update('abcd', '');
    frames.flushFrames(1000); // first frame: dt 0
    expect(reveal.revealed).toBe(0);
    frames.flushFrames(1250);
    frames.flushFrames(1500);
    frames.flushFrames(1750);
    frames.flushFrames(2000);
    expect(reveal.revealed).toBe(4);
    reveal.destroy();
  });

  it('instant (streamSpeed 0) reveals the whole buffer on update', () => {
    const { state, prefs } = makePrefs(); // speed stays 0
    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));

    reveal.update('Hello world', '');
    expect(reveal.revealed).toBe(11);
    expect(paints[paints.length - 1]).toBe('Hello world');

    reveal.destroy();
  });
});

describe('StreamReveal — word speed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('commits word + trailing whitespace as one unit, one unit per second at speed 1', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.unit = 'word';
    state.speed = 1; // words/s

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));
    reveal.update('The old tower\n', '');

    frames.flushFrames(1000); // first frame: dt 0
    frames.flushFrames(2000); // word 1: 'The '
    expect(reveal.revealed).toBe(4);
    frames.flushFrames(3000); // word 2: 'old '
    expect(reveal.revealed).toBe(8);
    frames.flushFrames(4000); // word 3: 'tower\n' (trailing newline counts)
    expect(reveal.revealed).toBe(14);
    expect(paints[paints.length - 1]).toBe('The old tower\n');

    reveal.destroy();
  });

  it('waits for the trailing space of a word before committing it', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.unit = 'word';
    state.speed = 1;

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));

    // 'Hello' has NO trailing space → word is incomplete, nothing commits,
    // but visibleEnd still reveals the growing word letter by letter.
    reveal.update('Hello', '');
    frames.flushFrames(1000);
    expect(reveal.revealed).toBe(0);
    expect(paints[paints.length - 1]).toBe('Hello');

    frames.flushFrames(2000);
    frames.flushFrames(3000); // carry builds up but the word has no space yet
    expect(reveal.revealed).toBe(0);
    expect(paints[paints.length - 1]).toBe('Hello');

    // User gets the trailing space → the whole word commits at once.
    reveal.update('Hello ', '');
    frames.flushFrames(4000);
    expect(reveal.revealed).toBe(6);
    expect(paints[paints.length - 1]).toBe('Hello ');

    // Next word without space → still waiting.
    reveal.update('Hello world', '');
    frames.flushFrames(5000);
    expect(reveal.revealed).toBe(6);
    expect(paints[paints.length - 1]).toBe('Hello world');

    reveal.destroy();
  });

  it('reveals the last word once the stream finished, even without a space', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.unit = 'word';
    state.speed = 1;

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));
    reveal.update('Hello world', '');
    frames.flushFrames(1000);
    frames.flushFrames(2000); // commits 'Hello '
    expect(reveal.revealed).toBe(6);

    await reveal.finish('Hello world', '', {});
    expect(reveal.revealed).toBe(11);
    expect(paints[paints.length - 1]).toBe('Hello world');

    reveal.destroy();
  });
});

describe('StreamReveal — finish / pace-after-complete / abort / flush / destroy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finish() without paceAfterComplete reveals the leftover instantly', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.speed = 1;
    state.pace = false;

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));
    reveal.update('Hello', '');
    frames.flushFrames(0);

    await reveal.finish('Hello', '', {});
    expect(reveal.revealed).toBe(5);
    expect(paints[paints.length - 1]).toBe('Hello');

    reveal.destroy();
  });

  it('finish() with paceAfterComplete keeps draining the leftover at streamSpeed', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.speed = 1;
    state.pace = true;

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));
    reveal.update('Hello', '');
    frames.flushFrames(1000);
    frames.flushFrames(2000);
    expect(reveal.revealed).toBe(1); // stream showed the first char before finishing

    let resolved = false;
    const done = reveal.finish('Hello', '', {}).then(() => { resolved = true; });
    // Watch + tick frames — drive until the drain resolves (4 more chars).
    for (let ts = 3000; ts <= 8000 && !resolved; ts += 1000) frames.flushFrames(ts);
    await done;

    expect(resolved).toBe(true);
    expect(reveal.revealed).toBe(5);
    expect(paints[paints.length - 1]).toBe('Hello');

    reveal.destroy();
  });

  it('finish() short-circuits and flushes on an aborted signal', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.speed = 1;
    state.pace = true;

    const reveal = new StreamReveal(prefs, () => {});
    reveal.update('Hello', '');

    const ac = new AbortController();
    ac.abort();
    await reveal.finish('Hello', '', { signal: ac.signal });
    expect(reveal.revealed).toBe(5);

    reveal.destroy();
  });

  it('flush() reveals the whole buffer and stops scheduling further frames', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.speed = 1;

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));
    reveal.update('Hello', '');
    frames.flushFrames(1000);

    reveal.flush();
    expect(reveal.revealed).toBe(5);
    expect(paints[paints.length - 1]).toBe('Hello');

    // The stale frame that was queued before flush must be inert.
    frames.flushFrames(5000);
    expect(reveal.revealed).toBe(5);

    reveal.destroy();
  });

  it('destroy() stops all further painting and pacing', () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { state, prefs } = makePrefs();
    state.speed = 1;

    const paints: string[] = [];
    const reveal = new StreamReveal(prefs, c => paints.push(c));
    reveal.update('Hello', '');
    reveal.destroy();

    const paintsBefore = paints.length;
    reveal.update('Hello world', '');
    reveal.flush();
    expect(paints.length).toBe(paintsBefore); // no painting after destroy
  });
});
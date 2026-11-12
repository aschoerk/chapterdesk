import { describe, expect, it, vi, afterEach } from 'vitest';
import { startHeldAnswerStream, type HeldAnswerStreamDeps } from './held-answer-stream';
import type { StreamRevealPrefs } from './stream-reveal';

/** Manual rAF loop (same harness as stream-reveal.spec). */
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

function makeDeps(overrides: Partial<HeldAnswerStreamDeps> = {}) {
  const paints: { nodeId: string; content: string; thinking: string }[] = [];
  const finalized: Array<{
    placeholderId?: string;
    finalContent?: string;
    finalThinking?: string;
    usage?: unknown;
    logEntry?: unknown;
  }> = [];
  const state = { speed: 1, unit: 'char' as 'char' | 'word', pace: true };
  const prefs: StreamRevealPrefs = {
    streamSpeed: () => state.speed,
    streamSpeedUnit: () => state.unit,
    paceAfterComplete: () => state.pace
  };
  const deps: HeldAnswerStreamDeps = {
    prefs,
    createPlaceholderNode: async () => 'answer-1',
    setActiveChild: vi.fn(),
    startGeneration: () => new AbortController().signal,
    paint: (nodeId, content, thinking) => { paints.push({ nodeId, content, thinking }); },
    runCompletion: async ({ onChunk }) => {
      onChunk({ content: 'Hello ' });
      onChunk({ content: 'world' });
      return { text: { status: 'ok', value: 'Hello world' } };
    },
    finalizeAnswer: async opts => {
      finalized.push({ ...opts });
      return { id: 'answer-1-final', content: opts.finalContent };
    },
    markSentOnceExcluded: vi.fn(async () => {}),
    retargetLog: vi.fn(),
    ...overrides
  };
  return { deps, paints, finalized, state };
}

describe('HeldAnswerStream — background continuation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a HELD stream buffers chunks without painting until finalize/drain', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { deps, paints } = makeDeps();

    const stream = await startHeldAnswerStream(deps, { hold: true });
    await stream.streamDone;
    // Held: nothing painted while streaming.
    expect(paints).toEqual([]);
    expect(stream.fullContent()).toBe('Hello world');

    await stream.finalize();
    // After finalize the node is versioned; the held pump still shows nothing
    // (rebase clamps to the revealed slice = empty).
    expect(paints[paints.length - 1]).toEqual({ nodeId: 'answer-1-final', content: '', thinking: '' });
    expect(stream.answerNodeId).toBe('answer-1-final');

    // Drain activates the held pump and reveals the buffered text at pace.
    let drained = false;
    const done = stream.drain().then(() => { drained = true; });
    for (let ts = 1000; ts <= 20000 && !drained; ts += 1000) frames.flushFrames(ts);
    await done;
    expect(drained).toBe(true);
    expect(paints[paints.length - 1]).toEqual({ nodeId: 'answer-1-final', content: 'Hello world', thinking: '' });
  });

  it('a LIVE stream paints chunks as they arrive (front item)', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { deps, paints } = makeDeps();

    const stream = await startHeldAnswerStream(deps, { hold: false });
    await stream.streamDone;
    // Live: the pump paints the growing buffer on the placeholder node.
    frames.flushFrames(1000); // dt 0
    frames.flushFrames(2000); // 1 char
    expect(paints[paints.length - 1]).toEqual({ nodeId: 'answer-1', content: 'H', thinking: '' });
    // Drive the pump to the full text.
    for (let ts = 3000; ts <= 20000; ts += 1000) frames.flushFrames(ts);
    expect(paints[paints.length - 1]).toEqual({ nodeId: 'answer-1', content: 'Hello world', thinking: '' });

    await stream.finalize();
    await stream.drain();
    expect(stream.answerNodeId).toBe('answer-1-final');
  });

  it('finalize persists the FULL content + usage and re-points the log entry', async () => {
    const logEntry = { seq: 7 } as never;
    const usage = { input: 1, output: 2 } as never;
    const { deps, finalized } = makeDeps({
      runCompletion: async () => ({
        text: { status: 'ok', value: 'Hello world' },
        usage: { status: 'ok', value: usage },
        logEntry
      })
    });
    const retargetLog = vi.fn();
    const stream = await startHeldAnswerStream({ ...deps, retargetLog }, { hold: true });
    await stream.finalize();

    expect(finalized[0].finalContent).toBe('Hello world');
    expect(finalized[0].usage).toBe(usage);
    expect(retargetLog).toHaveBeenCalledWith(logEntry, 'answer-1-final');
  });

  it('finalize flips one-shot excluded nodes after the send', async () => {
    const markSentOnceExcluded = vi.fn(async () => {});
    const { deps } = makeDeps({ markSentOnceExcluded });
    const stream = await startHeldAnswerStream(deps, { hold: true });
    await stream.finalize();
    expect(markSentOnceExcluded).toHaveBeenCalledTimes(1);
  });

  it('abort() flushes the buffer and stops scheduling (error / hard stop)', async () => {
    const frames = makeFrames();
    stubFrames(frames);
    const { deps, paints } = makeDeps();

    const stream = await startHeldAnswerStream(deps, { hold: true });
    await stream.streamDone;
    stream.abort();
    // Flush painted the full buffered text on the placeholder node.
    expect(paints[paints.length - 1]).toEqual({ nodeId: 'answer-1', content: 'Hello world', thinking: '' });
    const before = paints.length;
    frames.flushFrames(5000);
    expect(paints.length).toBe(before); // no further painting after abort
  });

  it('finalize + drain are idempotent', async () => {
    const { deps, finalized, state } = makeDeps();
    state.speed = 0; // instant — no rAF frames needed
    const stream = await startHeldAnswerStream(deps, { hold: true });
    await stream.finalize();
    await stream.finalize();
    await stream.drain();
    await stream.drain();
    expect(finalized).toHaveLength(1);
  });

  it('a hard Stop aborts the completion through the chat operation signal', async () => {
    // The per-stream controller (startGeneration) is only registered AFTER the
    // step's preparation awaits. A Stop pressed in that window must still kill
    // the request — the operation signal is combined into the run signal.
    const op = new AbortController();
    let seen: AbortSignal | null = null;
    const { deps } = makeDeps({
      runCompletion: async ({ signal }) => {
        seen = signal;
        return { text: { status: 'ok', value: '' } };
      }
    });

    await startHeldAnswerStream(deps, { hold: true, signal: op.signal });
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(false);

    op.abort();
    expect(seen!.aborted).toBe(true);
  });

  it('an already-aborted operation signal aborts the completion immediately', async () => {
    const op = new AbortController();
    op.abort();
    let seen: AbortSignal | null = null;
    const { deps } = makeDeps({
      runCompletion: async ({ signal }) => {
        seen = signal;
        return { text: { status: 'ok', value: '' } };
      }
    });

    await startHeldAnswerStream(deps, { hold: true, signal: op.signal });
    expect(seen!.aborted).toBe(true);
  });
});
import {describe, expect, it} from 'vitest';
import {
  createTimingRecorder,
  createMemoryTimingStore,
  type TimingEntry,
  type TimingStore,
} from '../../../src/diagnostics/timings.js';

/** A clock the test drives, so deltas are asserted rather than tolerated. */
function fakeClock(start = 1_000) {
  let t = start;
  return {now: () => t, advance: (ms: number) => (t += ms)};
}

async function enabledRecorder(clock = fakeClock()) {
  const store = createMemoryTimingStore(true);
  return {store, recorder: createTimingRecorder(store, {now: clock.now}), clock};
}

describe('createTimingRecorder', () => {
  it('records nothing while disabled, so call sites need no guard', async () => {
    const store = createMemoryTimingStore(false);
    const recorder = createTimingRecorder(store);
    await recorder.record('marker', 'unlock: start');
    expect(await recorder.list()).toEqual([]);
  });

  it('gives the first entry a zero delta rather than time since the epoch', async () => {
    const {recorder} = await enabledRecorder();
    await recorder.record('marker', 'unlock: start');
    expect((await recorder.list())[0]!.deltaMs).toBe(0);
  });

  it('measures each delta as the gap since the previous entry', async () => {
    const clock = fakeClock();
    const {recorder} = await enabledRecorder(clock);
    await recorder.record('marker', 'unlock: start');
    clock.advance(250);
    await recorder.record('sync', 'Starting shielded wallet…');
    clock.advance(46_700);
    await recorder.record('sync', 'Restoring dust state from cache…');

    expect((await recorder.list()).map((e) => e.deltaMs)).toEqual([0, 250, 46_700]);
  });

  it('keeps source and optional detail, since a duration without its size is uninterpretable', async () => {
    const {recorder} = await enabledRecorder();
    await recorder.record('sync', 'dust restore', {bytes: 5_130_000});
    const [entry] = await recorder.list();
    expect(entry!.source).toBe('sync');
    expect(entry!.detail).toEqual({bytes: 5_130_000});
  });

  it('omits detail entirely when none is given', async () => {
    const {recorder} = await enabledRecorder();
    await recorder.record('marker', 'plain');
    expect('detail' in (await recorder.list())[0]!).toBe(false);
  });

  it('drops the oldest entries past the cap so storage cannot grow without limit', async () => {
    const store = createMemoryTimingStore(true);
    const recorder = createTimingRecorder(store, {maxEntries: 3});
    for (const label of ['a', 'b', 'c', 'd', 'e']) await recorder.record('marker', label);
    expect((await recorder.list()).map((e) => e.label)).toEqual(['c', 'd', 'e']);
  });

  it('stamps a marker when toggled, so a timeline says when recording began', async () => {
    const store = createMemoryTimingStore(false);
    const recorder = createTimingRecorder(store);
    await recorder.setEnabled(true);
    expect((await recorder.list()).map((e) => e.label)).toEqual(['timings: enabled']);
  });

  it('clears entries on demand', async () => {
    const {recorder} = await enabledRecorder();
    await recorder.record('marker', 'a');
    await recorder.clear();
    expect(await recorder.list()).toEqual([]);
  });

  // The instrument must never be able to break the path it measures. These pin
  // that: a store that throws on every operation degrades to silence.
  describe('when the store fails', () => {
    const brokenStore: TimingStore = {
      isEnabled: async () => {
        throw new Error('storage unavailable');
      },
      setEnabled: async () => {
        throw new Error('storage unavailable');
      },
      read: async () => {
        throw new Error('storage unavailable');
      },
      write: async () => {
        throw new Error('storage unavailable');
      },
      clear: async () => {
        throw new Error('storage unavailable');
      },
    };

    it('treats an unanswerable store as disabled instead of throwing', async () => {
      const recorder = createTimingRecorder(brokenStore);
      await expect(recorder.isEnabled()).resolves.toBe(false);
    });

    it('swallows a failed record so a hot path never sees the error', async () => {
      const recorder = createTimingRecorder(brokenStore);
      await expect(recorder.record('sync', 'anything')).resolves.toBeUndefined();
    });

    it('degrades list() to empty rather than propagating', async () => {
      const recorder = createTimingRecorder(brokenStore);
      await expect(recorder.list()).resolves.toEqual([]);
    });

    it('still fails loudly on a write that the USER asked for', async () => {
      // setEnabled and clear are deliberate actions with UI behind them; silently
      // doing nothing would leave the toggle lying about its own state.
      const recorder = createTimingRecorder(brokenStore);
      await expect(recorder.setEnabled(true)).rejects.toThrow('storage unavailable');
      await expect(recorder.clear()).rejects.toThrow('storage unavailable');
    });
  });
});

/**
 * A store like `chrome.storage.local`: every operation is answered in order, one
 * round trip later. The recorder's read-modify-write is what the latency exposes.
 */
function fifoStore(latencyMs: number): TimingStore & {readonly value: TimingEntry[]} {
  let value: TimingEntry[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const op = <T,>(run: () => T): Promise<T> => {
    const next = queue.then(() => new Promise<T>((resolve) => setTimeout(() => resolve(run()), latencyMs)));
    queue = next.catch(() => {});
    return next;
  };
  return {
    get value() {
      return value;
    },
    isEnabled: () => op(() => true),
    setEnabled: () => op(() => {}),
    read: () => op(() => value.slice()),
    write: (entries) => op(() => {
      value = entries;
    }),
    clear: () => op(() => {
      value = [];
    }),
  };
}

describe('createTimingRecorder over a store that answers one round trip later', () => {
  it('keeps a record that another follows a millisecond later — the fast phases are the ones worth measuring', async () => {
    const store = fifoStore(1);
    const recorder = createTimingRecorder(store);
    const first = recorder.record('sync', 'The chain at … is the one the cached state was synced on');
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = recorder.record('sync', 'Restoring transaction history from cache...');
    await Promise.all([first, second]);
    expect(store.value.map((entry) => entry.label)).toEqual([
      'The chain at … is the one the cached state was synced on',
      'Restoring transaction history from cache...',
    ]);
  });

  it('keeps records issued back to back, in the order they were issued', async () => {
    const store = fifoStore(1);
    const recorder = createTimingRecorder(store);
    await Promise.all([recorder.record('sync', 'A'), recorder.record('sync', 'B'), recorder.record('sync', 'C')]);
    expect(store.value.map((entry) => entry.label)).toEqual(['A', 'B', 'C']);
  });

  it('stamps each record when it is called, not when its turn in the queue comes', async () => {
    let t = 1_000;
    const store = fifoStore(5);
    const recorder = createTimingRecorder(store, {now: () => t});
    const first = recorder.record('sync', 'A');
    t = 1_002;
    const second = recorder.record('sync', 'B');
    await Promise.all([first, second]);
    expect(store.value.map((entry) => [entry.at, entry.deltaMs])).toEqual([[1_000, 0], [1_002, 2]]);
  });
});

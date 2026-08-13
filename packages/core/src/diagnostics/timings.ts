// Phase timings: a storage-agnostic recorder for "where did the wall clock go".
//
// The wallet already announces every phase it moves through — sync progress
// messages from core, transaction stages from the transaction paths. Stamping
// those at whatever boundary a surface has turns them into a timeline with no
// further instrumentation: the gap between two labels IS the cost of the phase
// between them. That technique localised the pre-seed reference cost to a single
// 46.7s DustLocalState.deserialize with every other startup stage at 0.0s.
//
// The arithmetic and the policy (enabled/disabled, bounded history, never throw)
// are identical everywhere; only the persistence differs — storage.local in the
// extension, a file under ~/.moth for the CLI, TUI and daemon, memory in tests.
// So the store is an interface and everything else lives here, isomorphic and
// dependency-free: no node builtins, no extension APIs, no WASM. See
// storage/adapter.ts for the same split applied to wallet state.

/** One stamped phase boundary. */
export interface TimingEntry {
  /** Epoch ms. */
  at: number;
  /** ms since the previous entry — the cost of the phase that just ended. */
  deltaMs: number;
  /** Phase label: a sync message, a tx stage, or an explicit marker. */
  label: string;
  /** Where it came from, so a reader can group one stream into runs. */
  source: TimingSource;
  /** Optional numbers a label cannot carry (state sizes, applied/total). A
   *  duration without the size it scaled with is uninterpretable. */
  detail?: Record<string, number | string>;
}

export type TimingSource = 'sync' | 'tx' | 'marker';

/**
 * Persistence for the recorder. Deliberately tiny: four operations, all async,
 * none of which the recorder assumes anything about beyond "it might fail".
 *
 * Implementations must survive process/worker restarts if they want to be useful
 * — the interesting runs (unlock, first sync, an hour-long reference build) span
 * teardown — but that is a property of the store, not a requirement of this
 * interface.
 */
export interface TimingStore {
  isEnabled(): Promise<boolean>;
  setEnabled(on: boolean): Promise<void>;
  read(): Promise<TimingEntry[]>;
  write(entries: TimingEntry[]): Promise<void>;
  clear(): Promise<void>;
}

/** Oldest entries are dropped past this. Bounded so an always-on session cannot
 *  grow storage without limit; ~500 is several unlock+sync runs. */
export const DEFAULT_MAX_ENTRIES = 500;

export interface TimingRecorder {
  /** Append one stamped phase. No-op when disabled, so call sites need no guard. */
  record(source: TimingSource, label: string, detail?: TimingEntry['detail']): Promise<void>;
  isEnabled(): Promise<boolean>;
  setEnabled(on: boolean): Promise<void>;
  list(): Promise<TimingEntry[]>;
  clear(): Promise<void>;
}

/**
 * Build a recorder over any store.
 *
 * `now` is injectable so the arithmetic is testable without faking the clock
 * globally; it defaults to Date.now.
 *
 * Every method is best-effort by design: a failed read or write must never
 * disturb the thing being measured, and an instrument that can break the wallet
 * is worse than no instrument. That is why `record` swallows everything rather
 * than propagating — callers stamp phases on hot paths and cannot be asked to
 * wrap each one.
 */
export function createTimingRecorder(
  store: TimingStore,
  options?: {maxEntries?: number; now?: () => number},
): TimingRecorder {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options?.now ?? (() => Date.now());

  // Cached so the hot path (every ~1s sync emission) does not hit storage just to
  // ask whether it should be recording.
  let enabledCache: boolean | null = null;

  const isEnabled = async (): Promise<boolean> => {
    if (enabledCache !== null) return enabledCache;
    try {
      enabledCache = await store.isEnabled();
    } catch {
      // A store that cannot answer is treated as off: recording is the optional
      // behaviour, so the failure mode is "no data", never "broken wallet".
      enabledCache = false;
    }
    return enabledCache;
  };

  const setEnabled = async (on: boolean): Promise<void> => {
    enabledCache = on;
    await store.setEnabled(on);
    await record('marker', on ? 'timings: enabled' : 'timings: disabled');
  };

  async function record(
    source: TimingSource,
    label: string,
    detail?: TimingEntry['detail'],
  ): Promise<void> {
    try {
      if (!(await isEnabled())) return;
      const entries = await store.read();
      const at = now();
      // First entry of a run has no predecessor, so its delta is 0 rather than
      // the time since the epoch.
      const previous = entries.length > 0 ? entries[entries.length - 1]!.at : at;
      entries.push({at, deltaMs: at - previous, label, source, ...(detail ? {detail} : {})});
      await store.write(entries.slice(-maxEntries));
    } catch {
      /* never let instrumentation break the path it measures */
    }
  }

  return {
    record,
    isEnabled,
    setEnabled,
    list: () => store.read().catch(() => []),
    clear: () => store.clear(),
  };
}

/**
 * In-memory store. For tests, and for a short-lived process that only wants the
 * timeline it prints at exit.
 */
export function createMemoryTimingStore(initiallyEnabled = false): TimingStore {
  let enabled = initiallyEnabled;
  let entries: TimingEntry[] = [];
  return {
    isEnabled: async () => enabled,
    setEnabled: async (on) => {
      enabled = on;
    },
    read: async () => [...entries],
    write: async (next) => {
      entries = [...next];
    },
    clear: async () => {
      entries = [];
    },
  };
}

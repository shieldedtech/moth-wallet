// A file-backed TimingStore, for the surfaces that are not a browser extension.
//
// Replaces an earlier FilesystemTimingStore that shipped with no call sites: it
// baked ~/.moth/timings.json in as a module-level default, which is exactly the
// coupling that made it awkward to use and so left it unused. The path is a
// parameter here, and base-command.ts supplies it.
//
// The recorder in ./timings.ts is storage-agnostic on purpose: the extension
// backs it with `storage.local`, and everything else — CLI, TUI, daemon — needs
// somewhere on disk. Without this, `docs/BENCHMARKING.md` describes a
// `~/.moth/timings.json` that nothing writes.
//
// Why this matters beyond tidiness: the timings are how "where did the wall
// clock go" gets answered, and the questions worth answering are mostly about
// sync — which is exactly the part the CLI and daemon do headlessly, unattended,
// where nobody is watching a progress bar. The surface with the least visible
// feedback is the one that had no instrument at all.

import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {TimingEntry, TimingStore} from './timings.js';

interface Persisted {
  enabled: boolean;
  entries: TimingEntry[];
}

const EMPTY: Persisted = {enabled: false, entries: []};

/**
 * Store timings in a JSON file, creating its directory on first write.
 *
 * Every operation is best-effort. A diagnostic that throws is worse than one
 * that misses an entry: recording happens on the sync hot path, and a
 * permissions problem or a half-written file must never take down the wallet
 * that is merely being measured.
 */
export function createFileTimingStore(path: string): TimingStore {
  const load = async (): Promise<Persisted> => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Persisted>;
      return {
        enabled: parsed.enabled === true,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      // Missing, unreadable or malformed — all mean "nothing recorded yet".
      return {...EMPTY};
    }
  };

  const save = async (state: Persisted): Promise<void> => {
    try {
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch {
      /* diagnostics must not break the thing they measure */
    }
  };

  return {
    async isEnabled() {
      return (await load()).enabled;
    },
    async setEnabled(on: boolean) {
      const state = await load();
      // Clear on disable, so turning it off is also how you discard a timeline
      // you have finished with — and so a stale run cannot be mistaken for the
      // current one when it is turned back on.
      await save(on ? {...state, enabled: true} : {enabled: false, entries: []});
    },
    async read() {
      return (await load()).entries;
    },
    async write(entries: TimingEntry[]) {
      const state = await load();
      await save({...state, entries});
    },
    async clear() {
      const state = await load();
      await save({...state, entries: []});
    },
  };
}

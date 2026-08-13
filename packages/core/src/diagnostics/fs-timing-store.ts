// Node-side persistence for the phase-timings recorder: the CLI, TUI and daemon.
//
// Node-only, and deliberately in its own module rather than beside the recorder,
// so a browser bundle importing diagnostics/timings.js never pulls node:fs in.
// Same split as storage/adapter.ts (isomorphic) versus storage/fs-adapter.ts
// (node) — see those files for the established convention.

import {readFile, writeFile, unlink, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import type {TimingEntry, TimingStore} from './timings.js';

const DEFAULT_PATH = join(homedir(), '.moth', 'timings.json');

interface TimingFile {
  enabled: boolean;
  entries: TimingEntry[];
}

const EMPTY: TimingFile = {enabled: false, entries: []};

/**
 * File-backed timings, one JSON document.
 *
 * A single document rather than an append-only log because the recorder already
 * bounds history to its newest N entries: appending would need a compaction step
 * to honour that, and the file is a few hundred KB at the cap. Rewriting it is
 * cheaper than the phases being measured, which is the only budget that matters.
 *
 * Reads degrade to empty rather than throwing. A timings file that has been
 * hand-edited, truncated by a kill, or written by an older shape must not stop a
 * wallet from starting — losing a diagnostic is always preferable to blocking the
 * thing it diagnoses.
 */
export class FilesystemTimingStore implements TimingStore {
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
  }

  private async load(): Promise<TimingFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return {...EMPTY};
      const file = parsed as Partial<TimingFile>;
      return {
        enabled: file.enabled === true,
        entries: Array.isArray(file.entries) ? file.entries : [],
      };
    } catch {
      // Missing, unreadable, or not JSON — all mean "nothing recorded yet".
      return {...EMPTY};
    }
  }

  private async save(file: TimingFile): Promise<void> {
    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, JSON.stringify(file, null, 2), 'utf8');
  }

  async isEnabled(): Promise<boolean> {
    return (await this.load()).enabled;
  }

  async setEnabled(on: boolean): Promise<void> {
    const file = await this.load();
    file.enabled = on;
    await this.save(file);
  }

  async read(): Promise<TimingEntry[]> {
    return (await this.load()).entries;
  }

  async write(entries: TimingEntry[]): Promise<void> {
    const file = await this.load();
    file.entries = entries;
    await this.save(file);
  }

  /** Drops the entries and the file, but NOT the enabled flag — clearing a
   *  timeline mid-run is how you isolate one phase, and silently switching
   *  recording off would lose whatever came next. */
  async clear(): Promise<void> {
    const enabled = await this.isEnabled();
    try {
      await unlink(this.path);
    } catch {
      /* already gone */
    }
    if (enabled) await this.save({enabled: true, entries: []});
  }
}

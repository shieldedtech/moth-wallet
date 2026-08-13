// Filesystem-backed SyncStateStore preserving the legacy ~/.moth layout
// (sync/<network>/<wallet>/<part>.dat, empty-ref/<network>/...).
// This is the only sync module allowed to import node:* — it is exposed via
// the package's "./*" subpath exports and must never be re-exported from the
// barrel, which has to stay browser-bundleable.

import {existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import type {SyncStateStore} from './sync-store.js';

export class NodeSyncStateStore implements SyncStateStore {
  private readonly base: string;

  constructor(base?: string) {
    this.base = base ?? join(homedir(), '.moth');
  }

  private fileFor(key: string): string {
    return join(this.base, ...key.split('/'));
  }

  async get(key: string): Promise<string | null> {
    const file = this.fileFor(key);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const file = this.fileFor(key);
    mkdirSync(dirname(file), {recursive: true, mode: 0o700});
    writeFileSync(file, value, {encoding: 'utf-8', mode: 0o600});
  }

  async delete(key: string): Promise<void> {
    try {
      unlinkSync(this.fileFor(key));
    } catch {
      /* ignore */
    }
  }
}

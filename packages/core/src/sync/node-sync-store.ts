// Filesystem-backed SyncStateStore preserving the legacy ~/.moth layout
// (sync/<network>/<wallet>/<part>.dat, empty-ref/<network>/...).
// This is the only sync module allowed to import node:* — it is exposed via
// the package's "./*" subpath exports and must never be re-exported from the
// barrel, which has to stay browser-bundleable.

import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
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

  /**
   * Write via a temporary file and rename, so a reader never sees a partial one.
   *
   * A plain writeFileSync leaves the entry truncated for as long as the write
   * takes, and these are large. Any concurrent reader — a second moth process, or
   * an outgoing sync saving its cache while an incoming one restores from a
   * neighbouring entry — could decode a half-written state, and the restore path
   * treats a bad decode as "sync from genesis". A slow, correct-looking resync is
   * the worst way for this to fail, so make the swap atomic instead.
   *
   * The temporary lives in the destination directory: rename is only atomic
   * within a filesystem, and a temp dir may be on another one.
   */
  async put(key: string, value: string): Promise<void> {
    const file = this.fileFor(key);
    mkdirSync(dirname(file), {recursive: true, mode: 0o700});
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, value, {encoding: 'utf-8', mode: 0o600});
      renameSync(temp, file);
    } catch (err) {
      try {
        unlinkSync(temp);
      } catch {
        /* nothing to clean up */
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      unlinkSync(this.fileFor(key));
    } catch {
      /* ignore */
    }
  }
}

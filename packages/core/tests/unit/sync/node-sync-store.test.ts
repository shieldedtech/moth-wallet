// The Node store's writes have to be atomic. Sync state entries are large, and a
// reader that catches one mid-write decodes garbage — which the restore path
// treats as "sync from genesis", the slowest possible way to fail. A switch that
// no longer awaits the outgoing teardown makes concurrent access ordinary rather
// than exotic, so the swap is a rename.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSyncStateStore } from '../../../src/sync/node-sync-store.js';

let base: string;

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'moth-store-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('NodeSyncStateStore', () => {
  it('round-trips a value through the legacy path layout', async () => {
    const store = new NodeSyncStateStore(base);
    await store.put('sync/devnet/alice/shielded.dat', 'state-v1');
    expect(await store.get('sync/devnet/alice/shielded.dat')).toBe('state-v1');
    expect(readFileSync(join(base, 'sync', 'devnet', 'alice', 'shielded.dat'), 'utf-8')).toBe('state-v1');
  });

  it('returns null for an entry that was never written', async () => {
    expect(await new NodeSyncStateStore(base).get('sync/devnet/ghost/dust.dat')).toBeNull();
  });

  // The reader either sees the old value or the new one — never a prefix of the
  // new one, which is what a truncating in-place write exposes.
  it('replaces an existing entry without an intermediate short read', async () => {
    const store = new NodeSyncStateStore(base);
    const key = 'sync/devnet/alice/dust.dat';
    await store.put(key, 'x'.repeat(50_000));

    const reads: (string | null)[] = [];
    await Promise.all([
      store.put(key, 'y'.repeat(120_000)),
      (async () => { reads.push(await store.get(key)); })(),
      (async () => { reads.push(await store.get(key)); })(),
    ]);
    reads.push(await store.get(key));

    for (const value of reads) {
      expect(value === null || value === 'x'.repeat(50_000) || value === 'y'.repeat(120_000)).toBe(true);
    }
    expect(await store.get(key)).toBe('y'.repeat(120_000));
  });

  it('leaves no temporary files behind', async () => {
    const store = new NodeSyncStateStore(base);
    await store.put('sync/devnet/alice/history.dat', 'entries');
    await store.put('sync/devnet/alice/history.dat', 'more entries');

    const files = readdirSync(join(base, 'sync', 'devnet', 'alice'));
    expect(files).toEqual(['history.dat']);
  });

  it('deletes an entry, and ignores deleting one that is not there', async () => {
    const store = new NodeSyncStateStore(base);
    await store.put('sync/devnet/alice/shielded.dat', 'state');
    await store.delete('sync/devnet/alice/shielded.dat');
    expect(await store.get('sync/devnet/alice/shielded.dat')).toBeNull();
    await expect(store.delete('sync/devnet/alice/shielded.dat')).resolves.toBeUndefined();
  });
});

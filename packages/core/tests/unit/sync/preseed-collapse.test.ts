import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {clearEmptyRefCache, ensureEmptyRefCache} from '../../../src/sync/preseed.js';
import {inspectDustSnapshot} from '../../../src/sync/dust-reference-collapse.js';
import {
  emptyRefCollapsedKey,
  emptyRefHeightKey,
  emptyRefStateKey,
  type SyncStateStore,
} from '../../../src/sync/sync-store.js';
import type {NetworkConfig} from '../../../src/types/network.js';

// A reference stored by an earlier version — built, imported or bundled before
// references were collapsed — is collapsed the first time it is handed out, so the
// cost lands once on this machine rather than on every launch of every wallet
// seeded from it. See tests/fixtures/preseed/README.md for the fixture.
const REFERENCE = gunzipSync(
  readFileSync(new URL('../../fixtures/preseed/preview-519470-dust.dat.gz', import.meta.url)),
).toString('utf8');
const REFERENCE_CURSOR = '141062';

class RecordingStore implements SyncStateStore {
  readonly entries = new Map<string, string>();
  readonly writes: string[] = [];
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.writes.push(key);
    this.entries.set(key, value);
  }
  async delete(key: string) {
    this.entries.delete(key);
  }
}

// ensureEmptyRefCache memoises per network id for the life of the process, so
// each test uses its own id. No witnesses are stored, so nothing reaches the
// network: an unwitnessed reference is reported and allowed.
function network(id: string): NetworkConfig {
  return {id, indexerUrl: 'http://127.0.0.1:9/unused', nodeUrl: 'ws://127.0.0.1:9'} as NetworkConfig;
}

function storeWithReference(networkId: string, dust: string): RecordingStore {
  const store = new RecordingStore();
  store.entries.set(emptyRefStateKey(networkId, 'shielded'), '{"offset":"5"}');
  store.entries.set(emptyRefStateKey(networkId, 'unshielded'), '{}');
  store.entries.set(emptyRefStateKey(networkId, 'dust'), dust);
  store.entries.set(emptyRefHeightKey(networkId), '519470');
  return store;
}

describe('a stored reference is collapsed when it is handed out', () => {
  it('collapses an uncollapsed reference once, stores it, and records that it did', async () => {
    const id = 'collapse-first-use';
    const store = storeWithReference(id, REFERENCE);
    const messages: string[] = [];

    const reference = await ensureEmptyRefCache(network(id), (m) => messages.push(m), store);

    expect(reference).not.toBeNull();
    expect(inspectDustSnapshot(reference!.dust).stateBytes).toBeLessThan(8_192);
    expect(store.entries.get(emptyRefStateKey(id, 'dust'))).toBe(reference!.dust);
    expect(store.entries.get(emptyRefCollapsedKey(id))).toBe(REFERENCE_CURSOR);
    expect(messages.some((m) => /collapsed the reference's dust trees/.test(m))).toBe(true);
  });

  it('trusts a marker that matches the stored cursor, and does not collapse again', async () => {
    const id = 'collapse-marker-matches';
    const store = storeWithReference(id, REFERENCE);
    store.entries.set(emptyRefCollapsedKey(id), REFERENCE_CURSOR);

    const reference = await ensureEmptyRefCache(network(id), undefined, store);

    // Handed back exactly as stored: the marker says this state was verified.
    expect(reference!.dust).toBe(REFERENCE);
    expect(store.writes).toEqual([]);
  });

  it('collapses again when the stored state has moved past the marker', async () => {
    // A refresh or resumed build rewrites the state and its cursor; the marker left
    // behind describes a state that no longer exists.
    const id = 'collapse-marker-stale';
    const store = storeWithReference(id, REFERENCE);
    store.entries.set(emptyRefCollapsedKey(id), '1');

    const reference = await ensureEmptyRefCache(network(id), undefined, store);

    expect(inspectDustSnapshot(reference!.dust).stateBytes).toBeLessThan(8_192);
    expect(store.entries.get(emptyRefCollapsedKey(id))).toBe(REFERENCE_CURSOR);
  });

  it('hands out a reference it cannot collapse exactly as it was', async () => {
    // Slower to restore, still correct — never a reason to lose the reference.
    const id = 'collapse-unreadable';
    const unreadable = '{"state":"00ff","offset":"7"}';
    const store = storeWithReference(id, unreadable);
    const messages: string[] = [];

    const reference = await ensureEmptyRefCache(network(id), (m) => messages.push(m), store);

    expect(reference!.dust).toBe(unreadable);
    expect(store.entries.get(emptyRefStateKey(id, 'dust'))).toBe(unreadable);
    expect(store.entries.has(emptyRefCollapsedKey(id))).toBe(false);
    expect(messages.some((m) => /could not collapse/.test(m))).toBe(true);
  });

  it('is forgotten along with the rest of the reference', async () => {
    const id = 'collapse-cleared';
    const store = storeWithReference(id, REFERENCE);
    store.entries.set(emptyRefCollapsedKey(id), REFERENCE_CURSOR);

    await clearEmptyRefCache(id, store);

    expect(store.entries.has(emptyRefCollapsedKey(id))).toBe(false);
  });
});

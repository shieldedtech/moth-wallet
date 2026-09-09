// A local network brought back up from genesis leaves every cached artefact
// wrong: the account's sync state, and the network's pre-seed reference that
// new syncs are seeded from. "Clear cache and resync" has to reach both, or the
// resync restarts from a chain that no longer exists. The account-level clear
// is the existing clearSyncCache; this pins the reference-level half.

import {beforeEach, describe, expect, it} from 'vitest';
import {
  InMemorySyncStateStore,
  EMPTY_REF_WALLET,
  cursorWitnessKey,
  emptyRefHeightKey,
  emptyRefMnemonicKey,
  emptyRefStateKey,
} from '../../../src/sync/sync-store.js';
import {clearEmptyRefCache, preseedReferenceStatus} from '../../../src/sync/preseed.js';
import type {NetworkConfig} from '../../../src/types/network.js';

const NETWORK = 'undeployed';
const network = {id: NETWORK, nodeUrl: 'ws://localhost:9944', indexerUrl: 'http://localhost:8088'} as NetworkConfig;

let store: InMemorySyncStateStore;

beforeEach(() => {
  store = new InMemorySyncStateStore();
});

describe('clearEmptyRefCache', () => {
  it('removes every reference artefact for the network and leaves other networks alone', async () => {
    for (const part of ['shielded', 'unshielded', 'dust'] as const) {
      await store.put(emptyRefStateKey(NETWORK, part), 'state');
      await store.put(cursorWitnessKey(NETWORK, EMPTY_REF_WALLET, part), '{"id":1}');
      await store.put(emptyRefStateKey('preprod', part), 'state');
    }
    await store.put(emptyRefHeightKey(NETWORK), '4200');
    await store.put(emptyRefMnemonicKey(NETWORK), 'word '.repeat(24).trim());
    await store.put(emptyRefHeightKey('preprod'), '99');

    await clearEmptyRefCache(NETWORK, store);

    for (const part of ['shielded', 'unshielded', 'dust'] as const) {
      expect(await store.get(emptyRefStateKey(NETWORK, part))).toBeNull();
      expect(await store.get(cursorWitnessKey(NETWORK, EMPTY_REF_WALLET, part))).toBeNull();
      expect(await store.get(emptyRefStateKey('preprod', part))).toBe('state');
    }
    expect(await store.get(emptyRefHeightKey(NETWORK))).toBeNull();
    expect(await store.get(emptyRefMnemonicKey(NETWORK))).toBeNull();
    expect(await store.get(emptyRefHeightKey('preprod'))).toBe('99');
  });

  it('leaves the network with no usable reference', async () => {
    // A minimal reference the status check accepts: non-empty parts with a
    // positive offset is checked by snapshotOffset, so use the status before and
    // after only as "did the height survive" — the height alone gates usability.
    await store.put(emptyRefHeightKey(NETWORK), '4200');
    await clearEmptyRefCache(NETWORK, store);
    expect(await preseedReferenceStatus(network, store)).toEqual({ready: false, height: null});
  });

  it('is a no-op on a network that never had a reference', async () => {
    await expect(clearEmptyRefCache('never-seen', store)).resolves.toBeUndefined();
  });
});

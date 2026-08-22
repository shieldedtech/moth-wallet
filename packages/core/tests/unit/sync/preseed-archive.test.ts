import {beforeEach, describe, expect, it} from 'vitest';
import {birthdayOutlook, preseedReferenceStatus} from '../../../src/sync/preseed.js';
import {
  archivedRefStateKey,
  emptyRefHeightKey,
  emptyRefStateKey,
  InMemorySyncStateStore,
  refArchiveIndexKey,
  type SyncStateStore,
  type WalletPart,
} from '../../../src/sync/sync-store.js';
import type {NetworkConfig} from '../../../src/types/network.js';

const network = {id: 'preprod', indexerUrl: 'http://unused'} as NetworkConfig;
const PARTS: WalletPart[] = ['shielded', 'unshielded', 'dust'];

/** A snapshot that passes the "actually applied something" check. */
const snapshot = (offset: number) => JSON.stringify({offset: String(offset)});

async function putLive(store: SyncStateStore, height: number) {
  for (const part of PARTS) await store.put(emptyRefStateKey(network.id, part), snapshot(height));
  await store.put(emptyRefHeightKey(network.id), String(height));
}

async function putArchived(store: SyncStateStore, heights: number[]) {
  for (const height of heights) {
    for (const part of PARTS) {
      await store.put(archivedRefStateKey(network.id, height, part), snapshot(height));
    }
  }
  await store.put(refArchiveIndexKey(network.id), JSON.stringify(heights));
}

describe('birthdayOutlook with archived references', () => {
  let store: SyncStateStore;

  beforeEach(() => {
    store = new InMemorySyncStateStore();
  });

  it('uses the live reference when the birthday is at or after it', async () => {
    await putLive(store, 2_104_384);
    await expect(birthdayOutlook(network, 2_104_384, store)).resolves.toEqual({
      seedable: true,
      referenceHeight: 2_104_384,
    });
  });

  // The regression this archive exists for. A wallet imported with a birthday
  // BELOW the newest reference used to fall back to a genesis scan — measured at
  // 2600s+ on preprod with DUST still at 21% — even though a reference built
  // earlier would have covered it.
  it('falls back to the newest archived reference at or below the birthday', async () => {
    await putLive(store, 2_104_384);
    await putArchived(store, [2_104_384, 1_900_000, 1_200_000]);
    const outlook = await birthdayOutlook(network, 1_905_019, store);
    expect(outlook).toEqual({seedable: true, referenceHeight: 1_900_000});
  });

  it('never picks an archived reference above the birthday', async () => {
    await putLive(store, 2_104_384);
    await putArchived(store, [2_104_384, 2_000_000]);
    const outlook = await birthdayOutlook(network, 1_905_019, store);
    expect(outlook.seedable).toBe(false);
    expect(outlook.reason).toMatch(/no archived reference sits at or below it/);
  });

  it('ignores an archived height whose parts were never written', async () => {
    await putLive(store, 2_104_384);
    // Index claims a reference the store does not actually hold — a build that
    // died between writing the index and the parts, or a pruned cache.
    await store.put(refArchiveIndexKey(network.id), JSON.stringify([1_900_000]));
    const outlook = await birthdayOutlook(network, 1_905_019, store);
    expect(outlook.seedable).toBe(false);
  });

  it('reports the live reference height for status, not an archived one', async () => {
    await putLive(store, 2_104_384);
    await putArchived(store, [1_200_000]);
    await expect(preseedReferenceStatus(network, store)).resolves.toEqual({
      ready: true,
      height: 2_104_384,
    });
  });
});

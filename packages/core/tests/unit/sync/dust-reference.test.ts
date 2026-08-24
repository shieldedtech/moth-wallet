import {beforeEach, describe, expect, it} from 'vitest';
import {
  dustRefSlot,
  dustRefStateKey,
  loadDustRefAtOrBelow,
  readDustRefIndex,
  recordDustRef,
  InMemorySyncStateStore,
} from '../../../src/sync/sync-store.js';
import type {SyncStateStore} from '../../../src/sync/sync-store.js';
import {preSeedDustOnly} from '../../../src/sync/preseed.js';

const NET = 'preprod';
const snapshot = (offset: number) =>
  JSON.stringify({publicKey: {publicKey: '111'}, state: `state@${offset}`, protocolVersion: 4, offset: String(offset)});

let store: SyncStateStore;
beforeEach(() => {
  store = new InMemorySyncStateStore();
});

async function put(height: number, offset = height) {
  await store.put(dustRefStateKey(NET, height), snapshot(offset));
  await recordDustRef(store, NET, height);
}

describe('dust-only reference slots', () => {
  // The slot has to differ from the full-reference one: a full reference claims
  // its height for all three sub-wallets, a dust-only reference for dust alone.
  // Sharing the namespace would let a dust-only entry be read as a full one and
  // seed shielded state that was never built.
  it('is a different namespace from the full-reference slot', () => {
    expect(dustRefSlot(1_900_000)).toBe('__empty_ref__dust@1900000');
    expect(dustRefSlot(1_900_000)).not.toBe('__empty_ref__@1900000');
    expect(dustRefStateKey(NET, 1_900_000)).toContain(dustRefSlot(1_900_000));
  });

  it('keeps the index newest first', async () => {
    await put(1_200_000);
    await put(1_900_000);
    await put(1_500_000);
    await expect(readDustRefIndex(store, NET)).resolves.toEqual([1_900_000, 1_500_000, 1_200_000]);
  });

  it('does not duplicate a height', async () => {
    await put(1_900_000);
    await recordDustRef(store, NET, 1_900_000);
    await expect(readDustRefIndex(store, NET)).resolves.toEqual([1_900_000]);
  });
});

describe('loadDustRefAtOrBelow', () => {
  it('takes the newest reference at or below the floor', async () => {
    await put(1_200_000);
    await put(1_700_000);
    await put(2_100_000);
    const got = await loadDustRefAtOrBelow(store, NET, 1_800_000);
    expect(got?.height).toBe(1_700_000);
  });

  it('accepts a reference exactly at the floor', async () => {
    await put(1_697_238);
    const got = await loadDustRefAtOrBelow(store, NET, 1_697_238);
    expect(got?.height).toBe(1_697_238);
  });

  // The whole safety property: a reference above the floor holds none of the
  // wallet's own dust history, so seeding from it would skip real generation.
  it('never returns one above the floor', async () => {
    await put(2_100_000);
    await expect(loadDustRefAtOrBelow(store, NET, 1_697_238)).resolves.toBeNull();
  });

  it('skips an indexed height whose state was never written', async () => {
    await recordDustRef(store, NET, 1_700_000);
    await put(1_200_000);
    const got = await loadDustRefAtOrBelow(store, NET, 1_800_000);
    expect(got?.height).toBe(1_200_000);
  });

  it('is null when nothing is archived', async () => {
    await expect(loadDustRefAtOrBelow(store, NET, 9_000_000)).resolves.toBeNull();
  });
});

describe('preSeedDustOnly', () => {
  const keys = {dustSecretKey: {publicKey: 987n}} as never;

  it('keeps the reference state and cursor, swapping in the wallet key', () => {
    const out = preSeedDustOnly(keys, snapshot(1_294_352), NET);
    const parsed = JSON.parse(out!);
    expect(parsed.state).toBe('state@1294352');
    expect(parsed.offset).toBe('1294352');
    expect(parsed.publicKey.publicKey).toBe('987');
    expect(parsed.networkId).toBe(NET);
  });

  // Non-fatal by design: a wallet that cannot be dust-seeded walks the stream,
  // which is slow and correct. Throwing here would fail the whole sync.
  it.each([
    ['not json', 'nonsense'],
    ['no state', JSON.stringify({offset: '5'})],
    ['no offset', JSON.stringify({state: 'x'})],
    ['empty', ''],
  ])('returns null for %s rather than throwing', (_label, input) => {
    expect(preSeedDustOnly(keys, input, NET)).toBeNull();
  });
});

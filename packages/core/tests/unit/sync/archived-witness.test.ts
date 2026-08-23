import {beforeEach, describe, expect, it, vi} from 'vitest';

const readEventWitness = vi.fn();
vi.mock('../../../src/sync/cursor-witness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/sync/cursor-witness.js')>();
  return {...actual, readEventWitness: (...args: unknown[]) => readEventWitness(...args)};
});

const {ensureEmptyRefCache} = await import('../../../src/sync/preseed.js');
const {
  archiveReference,
  archivedRefSlot,
  archivedRefStateKey,
  cursorWitnessKey,
  emptyRefHeightKey,
  emptyRefStateKey,
  InMemorySyncStateStore,
  refArchiveIndexKey,
} = await import('../../../src/sync/sync-store.js');
import type {SyncStateStore, WalletPart} from '../../../src/sync/sync-store.js';
import type {NetworkConfig} from '../../../src/types/network.js';

const network = {id: 'preprod', indexerUrl: 'http://unused'} as NetworkConfig;
const PARTS: WalletPart[] = ['shielded', 'unshielded', 'dust'];
const snapshot = (offset: number) => JSON.stringify({offset: String(offset)});
const witness = (id: number, digest: string) => ({stream: 'dust', id, digest});

let store: SyncStateStore;

beforeEach(() => {
  store = new InMemorySyncStateStore();
  readEventWitness.mockReset();
});

describe('archiveReference witnesses', () => {
  // The states and their witnesses have to agree on what names a reference.
  // They did not: states went to `__empty_ref__@<height>` while witnesses only
  // ever existed for `__empty_ref__`, so an archived reference had none of its
  // own.
  it('stores witnesses under the same slot as the states', async () => {
    await archiveReference(store, network.id, 1_900_000, {
      shielded: snapshot(10),
      unshielded: snapshot(10),
      dust: snapshot(10),
    }, {dust: JSON.stringify(witness(10, 'abc'))});

    const slot = archivedRefSlot(1_900_000);
    expect(archivedRefStateKey(network.id, 1_900_000, 'dust')).toContain(slot);
    await expect(store.get(cursorWitnessKey(network.id, slot, 'dust'))).resolves.toBe(
      JSON.stringify(witness(10, 'abc')),
    );
  });

  it('does not write the live slot when archiving', async () => {
    await archiveReference(store, network.id, 1_900_000, {
      shielded: snapshot(10), unshielded: snapshot(10), dust: snapshot(10),
    }, {dust: JSON.stringify(witness(10, 'abc'))});

    await expect(store.get(cursorWitnessKey(network.id, '__empty_ref__', 'dust'))).resolves.toBeNull();
  });

  it('archives without witnesses when none are supplied, as before', async () => {
    await archiveReference(store, network.id, 1_900_000, {
      shielded: snapshot(10), unshielded: snapshot(10), dust: snapshot(10),
    });
    await expect(store.get(archivedRefStateKey(network.id, 1_900_000, 'dust'))).resolves.toBe(snapshot(10));
  });
});

describe('an archived reference is verified before it is used', () => {
  async function seedArchive(digest: string) {
    // A live reference ABOVE the birthday, so the lookup falls through to the
    // archive — the path that skipped verification entirely.
    for (const part of PARTS) await store.put(emptyRefStateKey(network.id, part), snapshot(2_100_000));
    await store.put(emptyRefHeightKey(network.id), String(2_100_000));
    await archiveReference(store, network.id, 1_900_000, {
      shielded: snapshot(1_900_000), unshielded: snapshot(1_900_000), dust: snapshot(1_900_000),
    }, {
      shielded: JSON.stringify({stream: 'shielded', id: 1_900_000, digest}),
      dust: JSON.stringify({stream: 'dust', id: 1_900_000, digest}),
    });
    await store.put(refArchiveIndexKey(network.id), JSON.stringify([1_900_000]));
  }

  it('uses it when its cursors still name the same events', async () => {
    await seedArchive('digest-a');
    readEventWitness.mockResolvedValue({stream: 'dust', id: 1_900_000, digest: 'digest-a'});

    const states = await ensureEmptyRefCache(network, undefined, store, {birthday: 1_905_019});
    expect(states?.height).toBe(1_900_000);
  });

  // The gap this closes. #50 refuses the LIVE reference across a renumbering;
  // #51 added the archived path, and the verifier read witnesses only from the
  // live slot — so the archived reference an older wallet takes was handed out
  // unverified, which is where a stale cursor is most likely.
  it('refuses it when the indexer has renumbered underneath it', async () => {
    await seedArchive('digest-a');
    readEventWitness.mockResolvedValue({stream: 'dust', id: 1_900_000, digest: 'digest-DIFFERENT'});

    const messages: string[] = [];
    const states = await ensureEmptyRefCache(network, (m) => messages.push(m), store, {birthday: 1_905_019});

    expect(states).toBeNull();
    expect(messages.join('\n')).toMatch(/renumbered/);
    expect(messages.join('\n')).toMatch(/archived reference 1900000/);
  });

  it('names the archived height in its messages, not just "reference"', async () => {
    await seedArchive('digest-a');
    readEventWitness.mockResolvedValue({stream: 'dust', id: 1_900_000, digest: 'nope'});
    const messages: string[] = [];
    await ensureEmptyRefCache(network, (m) => messages.push(m), store, {birthday: 1_905_019});
    expect(messages.some((m) => m.includes('archived reference 1900000'))).toBe(true);
  });
});

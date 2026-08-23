// Storage abstraction for serialized wallet sync state.
// Keys are relative paths (e.g. "sync/devnet/alice/shielded.dat") so the
// Node store can map them 1:1 onto the legacy ~/.moth file layout while
// browser stores treat them as opaque strings.

export interface SyncStateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type WalletPart = 'shielded' | 'unshielded' | 'dust' | 'history';

export function syncStateKey(networkId: string, walletName: string, part: WalletPart): string {
  return `sync/${networkId}/${walletName}/${part}.dat`;
}

/** Reserved wallet name for the pre-seed reference wallet (see preseed.ts). */
export const EMPTY_REF_WALLET = '__empty_ref__';

/**
 * Where the pre-seed reference wallet's state lives: its ordinary sync-cache
 * location. It MUST match what `startWalletSync(…, EMPTY_REF_WALLET, …)`
 * saves, because the pre-seed reads the reference state back from there.
 */
export function emptyRefStateKey(networkId: string, part: WalletPart): string {
  return syncStateKey(networkId, EMPTY_REF_WALLET, part);
}

/**
 * Chain height the reference wallet was synced to, recorded at build time.
 *
 * The snapshots' own `offset` is an event index, not a block height, so it
 * cannot be compared against a wallet's `birthday` (which is a height). This
 * records the height separately, because pre-seeding a wallet from a reference
 * NEWER than its birthday would skip that wallet's own history.
 */
export function emptyRefHeightKey(networkId: string): string {
  return `empty-ref/${networkId}/height.txt`;
}

/**
 * Where a cursor's witness lives: beside the cache it validates.
 *
 * One per (wallet, part), so a renumbering invalidates only the caches that
 * actually depend on the moved ids. `EMPTY_REF_WALLET` routes through the same
 * function deliberately — the pre-seed reference carries indexer-assigned
 * cursors exactly as a wallet cache does, and it is the one every new wallet
 * inherits, so a reference with a stale cursor spreads the skew rather than
 * containing it.
 */
export function cursorWitnessKey(networkId: string, walletName: string, part: WalletPart): string {
  return `witness/${networkId}/${walletName}/${part}.json`;
}

export function emptyRefMnemonicKey(networkId: string): string {
  return `empty-ref/${networkId}/mnemonic.txt`;
}

/**
 * State of a reference archived at a specific height.
 *
 * One reference only ever exists at the height it was built to, so a wallet
 * whose birthday precedes it cannot use it — the reference holds no record of
 * blocks below its own height. Keeping past references lets such a wallet seed
 * from the newest one at or below its birthday and scan only its own window,
 * instead of walking from genesis.
 */
export function archivedRefStateKey(networkId: string, height: number, part: WalletPart): string {
  return syncStateKey(networkId, archivedRefSlot(height), part);
}

/**
 * The wallet-slot name a reference archived at `height` is stored under.
 *
 * Named rather than inlined because two things key off it — the cached states
 * and their cursor witnesses — and they have to agree. When they did not, an
 * archived reference had no witnesses of its own and was handed out without the
 * renumbering check the live reference gets.
 */
export function archivedRefSlot(height: number): string {
  return `${EMPTY_REF_WALLET}@${height}`;
}

/** Heights for which an archived reference exists on this network. */
export function refArchiveIndexKey(networkId: string): string {
  return `empty-ref/${networkId}/archive.json`;
}

/** Heights with an archived reference on this network, newest first. */
export async function readArchiveIndex(store: SyncStateStore, networkId: string): Promise<number[]> {
  try {
    const raw = await store.get(refArchiveIndexKey(networkId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h): h is number => typeof h === 'number' && h > 0).sort((a, b) => b - a);
  } catch {
    return [];
  }
}

/**
 * Keep a copy of a reference under its own height.
 *
 * A single live reference only serves wallets born after it. Archiving each one
 * means a wallet with an older birthday can seed from the newest archive at or
 * below it and scan just its own window — which is the difference between
 * replaying every DUST event on the chain and replaying its own few hundred
 * thousand.
 *
 * The index is written LAST, matching the live slot's discipline: an entry whose
 * parts are missing is skipped by the reader, so an interrupted archive costs a
 * slow sync rather than a wallet seeded from half a reference.
 */
export async function archiveReference(
  store: SyncStateStore,
  networkId: string,
  height: number,
  states: {shielded: string; unshielded: string; dust: string},
  /**
   * Serialized `CursorWitness` per part, for the archived copy's own slot.
   *
   * Without these an archived reference cannot be verified, and the verifier
   * reads witnesses by slot — so it would fall back to the live reference's
   * witnesses, which belong to a different height and describe different
   * cursors. Passed in rather than copied from the live slot for that reason:
   * the caller knows which height these witnesses go with.
   */
  witnesses?: Partial<Record<WalletPart, string>>,
): Promise<void> {
  try {
    await Promise.all([
      store.put(archivedRefStateKey(networkId, height, 'shielded'), states.shielded),
      store.put(archivedRefStateKey(networkId, height, 'unshielded'), states.unshielded),
      store.put(archivedRefStateKey(networkId, height, 'dust'), states.dust),
    ]);
    // Witnesses before the index, for the same reason the index goes last: the
    // index is what makes the archive readable, and an entry that reads as
    // usable without its witnesses is one that skips verification.
    for (const [part, witness] of Object.entries(witnesses ?? {})) {
      if (witness) {
        await store.put(cursorWitnessKey(networkId, archivedRefSlot(height), part as WalletPart), witness);
      }
    }
    const heights = await readArchiveIndex(store, networkId);
    if (!heights.includes(height)) heights.push(height);
    await store.put(refArchiveIndexKey(networkId), JSON.stringify(heights.sort((a, b) => b - a)));
  } catch {
    // Archiving broadens which birthdays can seed; it is never load-bearing for
    // the reference being archived, so a failure must not fail the caller.
  }
}

/** Volatile store — used as the default outside Node when none is provided. */
export class InMemorySyncStateStore implements SyncStateStore {
  private readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

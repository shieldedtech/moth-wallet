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

export function emptyRefMnemonicKey(networkId: string): string {
  return `empty-ref/${networkId}/mnemonic.txt`;
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

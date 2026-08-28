import type * as ledger from '@midnight-ntwrk/ledger-v8';

export interface DerivedKeys {
  readonly nightExternal: Uint8Array;
  readonly nightInternal: Uint8Array;
  readonly dust: Uint8Array;
  readonly zswap: Uint8Array;
  readonly metadata: Uint8Array;
}

/**
 * Typed key bundle ready for SDK consumption. Built once at wallet
 * unlock via deriveWalletKeys(seedHex). Daemon write paths read this
 * and never the raw BIP-39 seed — see
 * docs/spec/wallet-service/05-key-management.md D-KM-3.
 *
 * Lives in types/wallet.ts (not sync/operations.ts) so the
 * UnlockedWallet interface can reference it without a cross-module
 * import.
 */
export interface WalletKeys {
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
  readonly nightExternalKey: Uint8Array;
}

export interface AddressEncoding {
  /** @deprecated Always empty string. Private key material was removed for security (CWE-200). */
  readonly hex: '';
  /** Bech32m-encoded public addresses per network */
  readonly bech32m: Record<string, string>;
}

export interface WalletAddresses {
  readonly nightExternal: AddressEncoding;
  readonly nightInternal: AddressEncoding;
  readonly dust: AddressEncoding;
  readonly zswap: AddressEncoding;
  readonly metadata: AddressEncoding;
}

export interface WalletInfo {
  readonly name: string;
  /**
   * The wallet's unshielded receive address, encoded for {@link addressNetwork}.
   *
   * By default this is the address recorded at create/import time. Pass a network
   * to `WalletManager.list()` to get it encoded for that network instead — the
   * payload is key material and the prefix is metadata, so this needs no keys.
   */
  readonly address: string;
  /**
   * Which network `address` is encoded for.
   *
   * Present because the two can differ: a wallet created on devnet and since used
   * on preprod has one set of keys and two valid encodings, and a caller that
   * assumed `address` matched the network it was working with sent a
   * wrong-network address to the indexer (#107).
   */
  readonly addressNetwork?: string;
  readonly addresses: WalletAddresses;
  /** The network recorded when this wallet was created or imported — where it
   *  started, not a restriction on where it can be used. */
  readonly network: string;
  readonly active: boolean;
  /** Chain tip block height at wallet creation time. Used to skip scanning older blocks on first sync. */
  readonly birthday?: number;
  /** User-chosen display label; `name` remains the immutable storage key. */
  readonly label?: string;
}

export interface UnlockedWallet {
  readonly name: string;
  /** User-chosen display label; `name` remains the immutable storage key. */
  readonly label?: string;
  /** Network this wallet lives on (from its stored metadata). */
  readonly network: string;
  readonly address: string;
  readonly addresses: WalletAddresses;
  readonly keys: DerivedKeys;
  /**
   * Typed key bundle derived at unlock. Every Midnight write path
   * accepts this directly. This is the only key surface
   * UnlockedWallet exposes — the raw BIP-39 seed is dropped after
   * derivation inside the manager and never visible to consumers.
   *
   * See docs/spec/wallet-service/05-key-management.md D-KM-3.
   */
  readonly walletKeys: WalletKeys;
  /**
   * Mark the wallet as unusable and let the WASM-typed keys clean
   * up any internal state. Callers should invoke this on logout /
   * process shutdown.
   */
  lock(): void;
}

export interface SyncState {
  readonly highestEndIndex: number;
  readonly highestCheckedEndIndex: number;
  readonly highestRelevantEndIndex: number;
  readonly lastBlockHeight: number;
  readonly lastBlockHash: string;
  readonly sessionId: string | null;
  readonly updatedAt: string;
}

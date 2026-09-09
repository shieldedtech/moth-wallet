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
  readonly address: string;
  readonly addresses: WalletAddresses;
  readonly network: string;
  readonly active: boolean;
  /** Chain tip block height at wallet creation time. Used to skip scanning older blocks on first sync. */
  readonly birthday?: number;
  /** User-chosen display label; `name` remains the immutable storage key. */
  readonly label?: string;
  /**
   * Which backup artifact this account actually has, so a UI can say so before
   * asking for a password.
   *
   * `'mnemonic'` accounts can reveal either their 24 words or the seed those
   * words expand to. `'seed'` accounts have no phrase and never will — BIP-39's
   * phrase-to-seed step is one-way — so offering to reveal one is offering
   * something that cannot be produced.
   *
   * `undefined` means the account predates this field. Unknown, not 'mnemonic':
   * guessing would tell a seed-imported account it has a phrase.
   */
  readonly backupKind?: BackupKind;
}

/** What an account can be restored from. */
export type BackupKind = 'mnemonic' | 'seed';

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

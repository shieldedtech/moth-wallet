// Which ledger reads which bytes, by protocol version.
//
// wallet-sdk 2.0 runs ledger-v8 below the chain's fork version and ledger-v9
// from it, and every transaction it hands out or takes in is a WalletTransaction
// handle stamped with the protocol version that authored its bytes. Bytes that
// reach moth from outside the SDK — a dApp's transaction, a hex payload on the
// daemon socket — carry no stamp, so this module picks the ledger by the
// version the wallets are acting at and seals the result. It also derives the
// public keys the pre-seed path writes into a snapshot, with the ledger that
// wrote the reference. Importing either ledger loads its WASM, so the modules
// the extension UI bundles must not import this one.

import * as Rx from 'rxjs';
import * as ledgerV8 from '@midnightntwrk/wallet-sdk/ledger/v8';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import {ProtocolVersion, WalletTransaction, type AnyTx, type FinalizedTx} from '@midnightntwrk/wallet-sdk';
import {DefaultForkSchedule, type WalletFacade, type WalletKind} from '@midnightntwrk/wallet-sdk/facade';
import {createKeystore as createV1Keystore, PublicKey as V1PublicKey} from '@midnightntwrk/wallet-sdk/unshielded/v1';
import {createKeystore, PublicKey} from '@midnightntwrk/wallet-sdk/unshielded';

export type {AnyTx, FinalizedTx};
export type TransactionStage = WalletTransaction.Stage;

/** Where this chain hands over to ledger-v9. Moth uses the facade's preset, so the
 *  routing here and the wallets' own hand-over read the same number. */
export const forks = DefaultForkSchedule;

/** True from the v9 fork on: the version's bytes follow ledger-v9's rules. */
export function isLedgerV9(version: ProtocolVersion.ProtocolVersion): boolean {
  return version >= forks.v9;
}

/** The protocol version the facade's wallets are acting at right now. */
export async function activeProtocolVersion(facade: WalletFacade): Promise<ProtocolVersion.ProtocolVersion> {
  const state = await Rx.firstValueFrom(facade.state());
  return state.activeProtocolVersion;
}

/** Which ledger version reads a chain at `version`. */
export type LedgerVersion = 'v8' | 'v9';

/**
 * Where the wallets stand on the protocol version line, as the SDK reports it.
 *
 * `version` is what the facade builds transactions for: the lowest of the three
 * wallets' versions, because nothing the facade builds can span the boundary.
 * Around a fork the wallets disagree for a while, and `phase` says so: `crossing`
 * names the version they are leaving, the one they are heading to, and which
 * wallets have not arrived yet. It resolves on its own as synchronization proceeds.
 */
export interface ProtocolStatus {
  readonly version: ProtocolVersion.ProtocolVersion;
  readonly ledger: LedgerVersion;
  readonly phase:
    | {readonly kind: 'settled'}
    | {
        readonly kind: 'crossing';
        readonly from: ProtocolVersion.ProtocolVersion;
        readonly to: ProtocolVersion.ProtocolVersion;
        readonly behind: readonly WalletKind[];
      };
  readonly wallets: Readonly<Record<WalletKind, ProtocolVersion.ProtocolVersion>>;
}

/** The wallets' protocol status, read off the facade's current state. */
export async function protocolStatus(facade: WalletFacade): Promise<ProtocolStatus> {
  const state = await Rx.firstValueFrom(facade.state());
  const protocol = state.protocol;
  return {
    version: state.activeProtocolVersion,
    ledger: isLedgerV9(state.activeProtocolVersion) ? 'v9' : 'v8',
    phase:
      protocol._tag === 'Settled'
        ? {kind: 'settled'}
        : {kind: 'crossing', from: protocol.from, to: protocol.to, behind: protocol.behind},
    wallets: state.protocolVersion,
  };
}

const MARKERS = {
  Unproven: ['signature', 'pre-proof', 'pre-binding'],
  Unbound: ['signature', 'proof', 'pre-binding'],
  Finalized: ['signature', 'proof', 'binding'],
} as const;

/**
 * Read raw transaction bytes with the ledger that owns `version` and seal them
 * into a handle at that version, so the facade accepts them as its own.
 */
export function transactionFromBytes<TStage extends TransactionStage>(
  bytes: Uint8Array,
  stage: TStage,
  version: ProtocolVersion.ProtocolVersion,
): WalletTransaction<TStage> {
  const [s, p, b] = MARKERS[stage];
  const transaction = isLedgerV9(version)
    ? ledgerV9.Transaction.deserialize(s as never, p as never, b as never, bytes)
    : ledgerV8.Transaction.deserialize(s as never, p as never, b as never, bytes);
  return WalletTransaction.adopt(stage, transaction, version);
}

/** A submit-ready transaction from its bytes, at the version the wallets are acting at. */
export async function finalizedTransactionFromBytes(facade: WalletFacade, bytes: Uint8Array): Promise<FinalizedTx> {
  return transactionFromBytes(bytes, 'Finalized', await activeProtocolVersion(facade));
}

/**
 * The ledger object a handle carries. The handle erases the ledger type on
 * purpose; callers that need a member of it say which shape they expect.
 */
export function unwrapTransaction<T>(handle: AnyTx): T {
  const version = handle.protocolVersion;
  const carried = WalletTransaction.unwrapWithin<T>(
    handle,
    ProtocolVersion.makeRange(version, ProtocolVersion.ProtocolVersion(version + 1n)),
  );
  if (carried._tag === 'Left') throw carried.left;
  return carried.right;
}

/**
 * The transaction hash of a finalized handle. The facade's submitTransaction
 * resolves to an intent identifier, but indexer queries, tx-history entries and
 * explorers are all keyed by the transaction hash, so moth reports that.
 */
export function transactionHashOf(handle: AnyTx): string {
  return unwrapTransaction<{transactionHash(): string}>(handle).transactionHash();
}

/** The ledger's initial DUST parameters at `version`; the ratio prices DUST capacity in NIGHT. */
export function initialDustParameters(version: ProtocolVersion.ProtocolVersion): {nightDustRatio: bigint} {
  const parameters = isLedgerV9(version)
    ? ledgerV9.LedgerParameters.initialParameters().dust
    : ledgerV8.LedgerParameters.initialParameters().dust;
  return {nightDustRatio: parameters.nightDustRatio as bigint};
}

/** Shielded public keys as the ledger at `version` encodes them, as hex. */
export function shieldedPublicKeysAt(
  version: ProtocolVersion.ProtocolVersion,
  seed: Uint8Array,
): {coinPublicKey: string; encryptionPublicKey: string} {
  const keys = isLedgerV9(version) ? ledgerV9.ZswapSecretKeys.fromSeed(seed) : ledgerV8.ZswapSecretKeys.fromSeed(seed);
  try {
    return {coinPublicKey: String(keys.coinPublicKey), encryptionPublicKey: String(keys.encryptionPublicKey)};
  } finally {
    keys.clear();
  }
}

/** The DUST public key as the ledger at `version` encodes it, as a decimal string (snapshots store the bigint that way). */
export function dustPublicKeyAt(version: ProtocolVersion.ProtocolVersion, seed: Uint8Array): string {
  const key = isLedgerV9(version) ? ledgerV9.DustSecretKey.fromSeed(seed) : ledgerV8.DustSecretKey.fromSeed(seed);
  try {
    return key.publicKey.toString();
  } finally {
    key.clear();
  }
}

/**
 * The unshielded public-key bundle a snapshot at `version` stores. Below the fork
 * the key is a plain hex string; from it, a `{tag, value}` object. The two wallet
 * variants read only their own shape, so a pre-seeded snapshot must match the
 * reference it was copied from.
 */
export function unshieldedPublicKeyAt(
  version: ProtocolVersion.ProtocolVersion,
  secret: Uint8Array,
  networkId: string,
): {publicKey: unknown; addressHex: string; address: string} {
  return isLedgerV9(version)
    ? PublicKey.fromKeyStore(createKeystore({kind: 'schnorr', secret}, networkId))
    : V1PublicKey.fromKeyStore(createV1Keystore(secret, networkId));
}

// Contract maintenance updates: insert verifier keys, remove verifier keys,
// replace maintenance authority. Mirrors call.ts: syncs wallet, balances
// transaction, signs intents, submits.

import {readFileSync} from 'node:fs';
import {resolve as resolvePath} from 'node:path';
import * as ledgerV8 from '@midnightntwrk/wallet-sdk/ledger/v8';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import type {TransactionResult} from '../types/transaction.js';
import {resolveProverConfig, type NetworkConfig} from '../types/network.js';
import type {DerivedKeys} from '../types/wallet.js';
import {ensureProverReady} from '../proof/provider.js';
import {WalletError} from '../types/errors.js';
import * as Rx from 'rxjs';
import {createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import type {SyncedWallet} from '../sync/wallet-sync.js';
import type {WalletKeys} from '../sync/operations.js';
import {unshieldedSecretOf} from './wallet-provider.js';
import {loadMidnightJs, openContract, publicDataProviderFor} from './midnight-js.js';
import {BUNDLED_CONTRACT_PROJECT_DIR} from './bundled.js';
import type {ContractStateRead} from '@midnight-ntwrk/midnight-js/types';

export interface InsertVerifierKeyOptions {
  /** Address of the already-deployed contract */
  contractAddress: string;
  /** Name of the circuit whose verifier key is being inserted */
  circuitId: string;
  /** Path to a .verifier file (raw bytes from `compact compile`) */
  verifierKeyPath: string;
  keys: DerivedKeys;
  /** Pre-derived typed key bundle. Preferred over `seedHex` when
   *  available — daemon path passes this. See
   *  docs/spec/wallet-service/05-key-management.md D-KM-3. */
  walletKeys?: WalletKeys;
  /** BIP-39 hex seed. Required only when `walletKeys` is not supplied. */
  seedHex?: string;
  network: NetworkConfig;
  /**
   * Path to the FULL compiled contract artifact — the one whose source declares
   * the circuit being added. The currently-deployed contract may have been
   * deployed from a stub with fewer circuits.
   */
  artifactPath: string;
  /** A synced wallet facade — required for balancing transactions */
  syncedWallet?: SyncedWallet;
  /** Project directory for resolving SDK dependencies (typically the contract project) */
  projectDir?: string;
  timeoutMs?: number;
}

export async function insertVerifierKey(options: InsertVerifierKeyOptions): Promise<TransactionResult> {
  const {contractAddress, circuitId, network, artifactPath, verifierKeyPath} = options;

  if (!artifactPath) {
    throw new WalletError(
      'INVALID_INPUT',
      'Maintenance updates require a compiled contract artifact (--artifact). ' +
        'Pass the FULL contract compile — the one that declares this circuit.'
    );
  }
  if (!verifierKeyPath) {
    throw new WalletError('INVALID_INPUT', 'Verifier key file path is required (--vk-file)');
  }
  if (!circuitId) {
    throw new WalletError('INVALID_INPUT', 'Circuit ID is required (--circuit-id)');
  }
  if (!options.syncedWallet?.facade) {
    throw new WalletError(
      'WALLET_ERROR',
      'Wallet must be synced before maintenance updates. Unlock and wait for sync.'
    );
  }

  await ensureProverReady(resolveProverConfig(network));

  return insertViaSDK(options);
}

async function insertViaSDK(options: InsertVerifierKeyOptions): Promise<TransactionResult> {
  const {contractAddress, circuitId, verifierKeyPath, walletKeys, seedHex, network, artifactPath, syncedWallet, projectDir} =
    options;
  // The unshielded signing secret: the pre-derived walletKeys (daemon path), else
  // derived from seedHex (in-process CLI path). D-KM-3.
  const keystore = createKeystore({kind: 'schnorr', secret: unshieldedSecretOf(walletKeys, seedHex, 'insertVerifierKey')}, network.id);

  // Wait for wallet sync before building the transaction.
  const facade = syncedWallet!.facade;
  const state: any = await Rx.firstValueFrom(
    (facade.state() as Rx.Observable<any>).pipe(
      // A stale dust tree root is rejected as InvalidDustSpendProof (error 170), so
      // wait for strict completion. Waiting further for two equal DUST balances, as
      // this once did, stalled every call on a resident daemon for a full cycle.
      Rx.filter((s: any) => {
        try {
          const unDone = s.unshielded?.progress?.isStrictlyComplete?.() === true;
          const dustDone = s.dust?.progress?.isStrictlyComplete?.() === true;
          if (unDone && dustDone) return true;
        } catch {}
        return s.isSynced === true;
      })
    )
  );

  const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
  const encPublicKey = (state as any).shielded.encryptionPublicKey.toHexString() as string;

  // The FULL compile, whose binding declares the circuit being added; an update runs no circuit,
  // so it needs no witnesses. The signing key lives in the store named after the artifact's
  // basename, which must therefore match the one the contract was deployed from.
  const {midnightJs, compiledContract, providers} = await openContract({
    artifactPath,
    projectDir,
    network,
    facade,
    keystore,
    coinPublicKey,
    encryptionPublicKey: encPublicKey,
  });

  // Load the verifier key bytes from disk and wrap into the SDK type.
  const vkBytes = readFileSync(resolvePath(verifierKeyPath));
  const verifierKey = midnightJs.types.createVerifierKey(new Uint8Array(vkBytes));

  const result = await (midnightJs.contracts.submitInsertVerifierKeyTx as any)(
    providers,
    compiledContract,
    contractAddress,
    circuitId,
    verifierKey
  );

  return {
    hash: result?.public?.txId ?? result?.txId ?? '',
    status: 'SUCCESS',
    blockHash: result?.public?.blockHash ?? result?.blockHash ?? null,
    blockHeight: result?.public?.blockHeight ?? result?.blockHeight ?? null,
    contractAddress,
    fees: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Batched insert (Level 1: one tx per VK, shared wallet sync + providers).
// Loops internally so the wallet sync, key derivation, and provider setup
// only happen once for the whole batch — much faster wall-clock than calling
// insertVerifierKey() N times.
// ─────────────────────────────────────────────────────────────────────────

export interface InsertVerifierKeysOptions {
  contractAddress: string;
  /** Ordered list of circuits to insert. */
  entries: Array<{circuitId: string; verifierKeyPath: string}>;
  keys: DerivedKeys;
  /** Pre-derived typed key bundle. Preferred over `seedHex`. D-KM-3. */
  walletKeys?: WalletKeys;
  /** BIP-39 hex seed. Required only when `walletKeys` is not supplied. */
  seedHex?: string;
  network: NetworkConfig;
  artifactPath: string;
  syncedWallet?: SyncedWallet;
  projectDir?: string;
  /** Query the contract before each insert and skip circuits already defined. */
  skipExisting?: boolean;
  /** Per-entry progress callback (after each tx attempt). */
  onProgress?: (e: BatchEntryResult) => void;
  timeoutMs?: number;
}

export interface BatchEntryResult {
  circuitId: string;
  status: 'inserted' | 'skipped-existing' | 'failed';
  txHash?: string;
  blockHeight?: number | null;
  error?: string;
}

export interface BatchInsertResult {
  contractAddress: string;
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
  entries: BatchEntryResult[];
}

export async function insertVerifierKeys(options: InsertVerifierKeysOptions): Promise<BatchInsertResult> {
  const {contractAddress, entries, network, artifactPath, syncedWallet} = options;

  if (!artifactPath) {
    throw new WalletError('INVALID_INPUT', 'Maintenance updates require an artifact (--artifact).');
  }
  if (!entries || entries.length === 0) {
    throw new WalletError('INVALID_INPUT', 'No circuits to insert.');
  }
  if (!syncedWallet?.facade) {
    throw new WalletError('WALLET_ERROR', 'Wallet must be synced before maintenance updates.');
  }

  await ensureProverReady(resolveProverConfig(network));

  return insertBatchViaSDK(options);
}

async function insertBatchViaSDK(options: InsertVerifierKeysOptions): Promise<BatchInsertResult> {
  const {contractAddress, entries, walletKeys, seedHex, network, artifactPath, syncedWallet, projectDir, skipExisting, onProgress} =
    options;
  // The unshielded signing secret: the pre-derived walletKeys (daemon path), else
  // derived from seedHex (in-process CLI path). D-KM-3.
  const keystore = createKeystore({kind: 'schnorr', secret: unshieldedSecretOf(walletKeys, seedHex, 'insertVerifierKeys')}, network.id);

  const facade = syncedWallet!.facade;
  const state: any = await Rx.firstValueFrom(
    (facade.state() as Rx.Observable<any>).pipe(
      // A stale dust tree root is rejected as InvalidDustSpendProof (error 170), so
      // wait for strict completion. Waiting further for two equal DUST balances, as
      // this once did, stalled every call on a resident daemon for a full cycle.
      Rx.filter((s: any) => {
        try {
          const unDone = s.unshielded?.progress?.isStrictlyComplete?.() === true;
          const dustDone = s.dust?.progress?.isStrictlyComplete?.() === true;
          if (unDone && dustDone) return true;
        } catch {}
        return s.isSynced === true;
      })
    )
  );

  const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
  const encPublicKey = (state as any).shielded.encryptionPublicKey.toHexString() as string;

  const {midnightJs, compiledContract, providers} = await openContract({
    artifactPath,
    projectDir,
    network,
    facade,
    keystore,
    coinPublicKey,
    encryptionPublicKey: encPublicKey,
  });

  // ── Per-entry loop ─────────────────────────────────────────────────────
  // The maintenance authority counter is monotonic per contract, so submits
  // must be sequential. submitInsertVerifierKeyTx awaits finalisation.
  const results: BatchEntryResult[] = [];
  let inserted = 0,
    skipped = 0,
    failed = 0;

  // Pre-query existing operations once if skip-existing is requested.
  let existingOps = new Set<string>();
  if (skipExisting) {
    try {
      // The state comes back as bytes tagged with the ledger era that wrote
      // them; either ledger's ContractState lists the circuits it defines.
      const read = await providers.publicDataProvider.queryContractState(contractAddress);
      if (read) {
        const state = read.contractState.deserialize({v8: ledgerV8.ContractState, v9: ledgerV9.ContractState});
        for (const op of state.operations()) existingOps.add(typeof op === 'string' ? op : new TextDecoder().decode(op));
      }
    } catch (e) {
      // Non-fatal — log and continue without skip filtering.
      process.stderr.write(
        `[maintenance] could not query existing operations, skip-existing disabled: ${(e as Error).message}\n`
      );
    }
  }

  for (const entry of entries) {
    const {circuitId, verifierKeyPath} = entry;

    if (skipExisting && existingOps.has(circuitId)) {
      const r: BatchEntryResult = {circuitId, status: 'skipped-existing'};
      results.push(r);
      skipped++;
      onProgress?.(r);
      continue;
    }

    try {
      const vkBytes = readFileSync(resolvePath(verifierKeyPath));
      const verifierKey = midnightJs.types.createVerifierKey(new Uint8Array(vkBytes));

      const result = await (midnightJs.contracts.submitInsertVerifierKeyTx as any)(
        providers,
        compiledContract,
        contractAddress,
        circuitId,
        verifierKey
      );

      const r: BatchEntryResult = {
        circuitId,
        status: 'inserted',
        txHash: result?.public?.txId ?? result?.txId ?? '',
        blockHeight: result?.public?.blockHeight ?? result?.blockHeight ?? null,
      };
      results.push(r);
      inserted++;
      onProgress?.(r);
    } catch (err: any) {
      // Walk the error chain to surface the actual cause (SDK buries it).
      let msg = err?.message ?? String(err);
      let cur = err?.cause;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur.message) msg = cur.message;
        if (cur.defect?.message) msg = cur.defect.message;
        cur = cur.cause;
      }
      const isAlreadyDefined = /already defined/i.test(msg);
      const r: BatchEntryResult = {
        circuitId,
        status: isAlreadyDefined ? 'skipped-existing' : 'failed',
        error: msg,
      };
      results.push(r);
      if (isAlreadyDefined) {
        skipped++;
      } else {
        failed++;
      }
      onProgress?.(r);
      if (!isAlreadyDefined) {
        // Stop on first hard failure — the authority counter is monotonic
        // and a failed submit may leave the wallet in a state where subsequent
        // submits would race against the next counter. Caller can resume.
        break;
      }
    }
  }

  return {
    contractAddress,
    total: entries.length,
    inserted,
    skipped,
    failed,
    entries: results,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Replace the contract maintenance authority.
//
// Not `submitReplaceAuthorityTx`: midnight-js swaps one signing key for one other
// (its TODO says so), which cannot express a committee. A deploy leaves the contract
// under a single key midnight-js sampled into the local private-state DB, so every
// fresh contract has an unnamed 1-of-1 superuser; losing that DB freezes the circuit
// set, and copying it hands the contract over silently.
//
// So the update is built from ledger-9 types: a `ContractMaintenanceAuthority` with
// the committee and threshold asked for, wrapped in `ReplaceAuthority`, signed by a
// threshold of the CURRENT authority, and submitted as an intent carrying nothing
// else. `LedgerTransaction.seal` re-reads it from bytes, so any ledger-9 copy builds it.
// ─────────────────────────────────────────────────────────────────────────

/**
 * A signing or verifying key: `schnorr:<hex>`, `ecdsa:<hex>`, bare hex (schnorr, the
 * kind midnight-js samples and the only one ledger 8 had), or the ledger's own object.
 */
export type AuthorityKey = string | {tag: string; value: string};

type TaggedKey = {tag: 'schnorr' | 'ecdsa'; value: string};

/** The key as ledger 9 takes it. Ledger 9 keys are objects, so they compare only in this form. */
function taggedKey(key: AuthorityKey, what: string): TaggedKey {
  const [tag, value] =
    typeof key === 'string'
      ? key.includes(':') ? [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)] : ['schnorr', key]
      : [key?.tag, key?.value];
  if ((tag !== 'schnorr' && tag !== 'ecdsa') || typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new WalletError('INVALID_INPUT',
      `${what} is not a key: expected schnorr:<hex>, ecdsa:<hex>, or hex, got ${JSON.stringify(key)}.`);
  }
  return {tag, value: value.toLowerCase()};
}

/** One text form per key, `kind:hex`, used for every comparison and every display. */
export function authorityKeyText(key: AuthorityKey): string {
  const {tag, value} = taggedKey(key, 'The key');
  return `${tag}:${value}`;
}

/** A member of the current authority, holding one signing key. */
export interface AuthoritySigner {
  /** Position in the CURRENT on-chain committee. Signatures are indexed by it. */
  index: number;
  signingKey: AuthorityKey;
}

export interface ReplaceAuthorityOptions {
  contractAddress: string;
  /** Verifying keys of the incoming committee. Empty when renouncing. */
  committee: AuthorityKey[];
  /** How many of them must sign future updates. */
  threshold: number;
  /**
   * Install an authority nothing can satisfy -- threshold above committee size --
   * making the circuit set permanently immutable. Irreversible by construction:
   * no later update can be signed either.
   */
  renounce?: boolean;
  /**
   * Signing keys of the CURRENT authority. Omit for a contract still under the
   * key sampled at deploy time, which is read from the private state provider.
   */
  currentSigners?: readonly AuthoritySigner[];
  keys: DerivedKeys;
  walletKeys?: WalletKeys;
  seedHex?: string;
  network: NetworkConfig;
  artifactPath: string;
  syncedWallet?: SyncedWallet;
  projectDir?: string;
  timeoutMs?: number;
}

export interface AuthorityDescription {
  /** Verifying keys as `kind:hex`. */
  committee: string[];
  threshold: number;
  counter: bigint;
  /** True when the threshold cannot be met, so no update can ever be signed. */
  renounced: boolean;
}

export interface ReplaceAuthorityResult extends TransactionResult {
  previous: AuthorityDescription;
  next: AuthorityDescription;
  /** Whether the local signing key was kept because it can still act alone. */
  localKeyRetained: boolean;
}

const describeAuthority = (cma: {
  committee: ArrayLike<unknown> | Iterable<unknown>;
  threshold: number;
  counter: bigint;
}): AuthorityDescription => {
  const committee = [...(cma.committee as Iterable<AuthorityKey>)].map(authorityKeyText);
  return {
    committee,
    threshold: Number(cma.threshold),
    counter: BigInt(cma.counter),
    renounced: Number(cma.threshold) > committee.length,
  };
};

/** The authority in a state read, whichever ledger era wrote the state. */
function authorityOf(read: ContractStateRead): AuthorityDescription {
  const state = read.contractState.deserialize({v8: ledgerV8.ContractState, v9: ledgerV9.ContractState});
  return describeAuthority(state.maintenanceAuthority);
}

export async function replaceAuthority(options: ReplaceAuthorityOptions): Promise<ReplaceAuthorityResult> {
  const {contractAddress, committee, threshold, renounce, network, artifactPath} = options;

  if (!artifactPath) {
    throw new WalletError('INVALID_INPUT', 'Maintenance updates require a compiled contract artifact (--artifact).');
  }
  if (!contractAddress) {
    throw new WalletError('INVALID_INPUT', 'Contract address is required (--address)');
  }
  if (!options.syncedWallet?.facade) {
    throw new WalletError('WALLET_ERROR', 'Wallet must be synced before maintenance updates. Unlock and wait for sync.');
  }
  if (renounce) {
    if (committee.length > 0) {
      throw new WalletError('INVALID_INPUT',
        'Renouncing installs an authority nobody holds; do not also pass a committee.');
    }
  } else {
    if (committee.length === 0) {
      throw new WalletError('INVALID_INPUT',
        'No committee given. Pass the verifying keys of the incoming authority, or use renounce ' +
        'to make the contract permanently immutable.');
    }
    if (threshold < 1) {
      throw new WalletError('INVALID_INPUT', 'Threshold must be at least 1.');
    }
    if (threshold > committee.length) {
      throw new WalletError('INVALID_INPUT',
        `Threshold ${threshold} exceeds committee size ${committee.length}. Nothing could ever sign an ` +
        'update, which is the renounce configuration -- pass renounce explicitly if that is the intent.');
    }
    const unique = new Set(committee.map((key, i) => authorityKeyText(taggedKey(key, `Committee key ${i + 1}`))));
    if (unique.size !== committee.length) {
      throw new WalletError('INVALID_INPUT',
        'The committee contains a duplicate verifying key, which inflates the threshold without ' +
        'adding a custodian.');
    }
  }

  await ensureProverReady(resolveProverConfig(network));

  return replaceAuthorityViaSDK(options);
}

async function replaceAuthorityViaSDK(options: ReplaceAuthorityOptions): Promise<ReplaceAuthorityResult> {
  const {contractAddress, committee, threshold, renounce, currentSigners, walletKeys, seedHex, network, artifactPath, syncedWallet, projectDir} =
    options;
  const keystore = createKeystore({kind: 'schnorr', secret: unshieldedSecretOf(walletKeys, seedHex, 'replaceAuthority')}, network.id);

  // Same strict-completion wait as the insert paths: balancing against a stale
  // dust tree root is rejected on chain.
  const facade = syncedWallet!.facade;
  const state: any = await Rx.firstValueFrom(
    (facade.state() as Rx.Observable<any>).pipe(
      Rx.filter((s: any) => {
        try {
          const unDone = s.unshielded?.progress?.isStrictlyComplete?.() === true;
          const dustDone = s.dust?.progress?.isStrictlyComplete?.() === true;
          if (unDone && dustDone) return true;
        } catch {}
        return s.isSynced === true;
      })
    )
  );

  // The artifact names the private-state store that holds the deploy-time key.
  // An authority update runs no circuit, so the contract needs no witnesses.
  const {midnightJs, providers} = await openContract({
    artifactPath,
    projectDir,
    network,
    facade,
    keystore,
    coinPublicKey: state.shielded.coinPublicKey.toHexString() as string,
    encryptionPublicKey: state.shielded.encryptionPublicKey.toHexString() as string,
  });

  const read = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!read) {
    throw new WalletError('INVALID_INPUT', `No contract state on chain for address '${contractAddress}'`);
  }
  const previous = authorityOf(read);
  if (previous.renounced) {
    throw new WalletError('INVALID_INPUT',
      `This contract's authority is already renounced (threshold ${previous.threshold} of ` +
      `${previous.committee.length}). No update can be signed, including this one. Nothing to do.`);
  }

  // Who signs. Without an explicit list this is the key midnight-js sampled at
  // deploy time, which sits at index 0 of a one-member committee.
  let signers: AuthoritySigner[];
  if (currentSigners && currentSigners.length > 0) {
    signers = [...currentSigners];
  } else {
    const local = await providers.privateStateProvider.getSigningKey(contractAddress);
    if (!local) {
      throw new WalletError('WALLET_ERROR',
        `No signing key stored locally for '${contractAddress}', and no signers were given. ` +
        'This contract is held by an authority this wallet cannot act for: collect signatures ' +
        'from a threshold of its committee and pass them explicitly.');
    }
    signers = [{index: 0, signingKey: local as AuthorityKey}];
  }

  // Pre-flight, because a wrong index or a stale key costs fees and fails on
  // chain with nothing useful to read. Each signature must come from the key
  // sitting at that position in the CURRENT committee.
  for (const signer of signers) {
    const expected = previous.committee[signer.index];
    if (expected === undefined) {
      throw new WalletError('INVALID_INPUT',
        `Signer index ${signer.index} is outside the current committee of ${previous.committee.length}.`);
    }
    const actual = authorityKeyText(ledgerV9.signatureVerifyingKey(taggedKey(signer.signingKey, `The key for index ${signer.index}`)));
    if (actual !== expected) {
      throw new WalletError('INVALID_INPUT',
        `The key given for index ${signer.index} is not the one on chain at that position. ` +
        'Either the index is wrong or the committee has already changed.');
    }
  }
  if (signers.length < previous.threshold) {
    throw new WalletError('INVALID_INPUT',
      `The current authority needs ${previous.threshold} signatures and ${signers.length} ` +
      `${signers.length === 1 ? 'was' : 'were'} given. Collect the rest before submitting.`);
  }

  // The new authority's counter is exactly one past the current one; the update
  // itself is valid against the current one (the ledger's replay protection).
  const nextThreshold = renounce ? 1 : threshold;
  const nextCommittee = renounce ? [] : committee.map((key) => taggedKey(key, 'A committee key'));
  const newAuthority = new ledgerV9.ContractMaintenanceAuthority(nextCommittee, nextThreshold, previous.counter + 1n);

  let update = new ledgerV9.MaintenanceUpdate(
    contractAddress, [new ledgerV9.ReplaceAuthority(newAuthority)], previous.counter);
  // Every signature is over the same bytes, which lets custodians sign separately.
  const dataToSign: Uint8Array = update.dataToSign;
  for (const signer of signers) {
    update = update.addSignature(BigInt(signer.index), ledgerV9.signData(taggedKey(signer.signingKey, 'A signing key'), dataToSign));
  }

  const ttl = new Date(Date.now() + providers.config.ttlSeconds * 1000);
  const unprovenTx = midnightJs.types.LedgerTransaction.seal(
    'v9',
    'Unproven',
    ledgerV9.Transaction.fromParts(network.id, undefined, undefined, ledgerV9.Intent.new(ttl).addMaintenanceUpdate(update)),
  );

  const result: any = await (midnightJs.contracts.submitTx as any)(providers, {unprovenTx});
  if (result?.status !== midnightJs.types.SucceedEntirely) {
    throw new WalletError('NETWORK_ERROR',
      `Authority replacement did not succeed entirely (status ${String(result?.status)}). ` +
      'The on-chain authority may be unchanged; re-read it before retrying.');
  }

  // The locally stored key is now either not a member at all, or one of several
  // that cannot act alone. Keeping it would let `insert-vk` believe it can still
  // maintain this contract and fail at the chain instead of at the keyboard.
  const localStillSuffices = !renounce && nextThreshold === 1 && signers.length === 1 &&
    nextCommittee.map(authorityKeyText).includes(
      authorityKeyText(ledgerV9.signatureVerifyingKey(taggedKey(signers[0].signingKey, 'A signing key'))));
  if (!localStillSuffices) {
    await providers.privateStateProvider.removeSigningKey(contractAddress);
  }

  return {
    hash: result.txId ?? '',
    status: 'SUCCESS',
    blockHash: result.blockHash ?? null,
    blockHeight: result.blockHeight ?? null,
    contractAddress,
    fees: null,
    previous,
    next: {
      committee: nextCommittee.map(authorityKeyText),
      threshold: nextThreshold,
      counter: previous.counter + 1n,
      renounced: nextThreshold > nextCommittee.length,
    },
    localKeyRetained: localStillSuffices,
  };
}

/** Read the authority off chain without a wallet or any signing material. */
export async function readAuthority(
  contractAddress: string,
  network: Pick<NetworkConfig, 'indexerUrl'>,
): Promise<AuthorityDescription> {
  const midnightJs = await loadMidnightJs(BUNDLED_CONTRACT_PROJECT_DIR);
  const read = await publicDataProviderFor(midnightJs, network).queryContractState(contractAddress);
  if (!read) {
    throw new WalletError('INVALID_INPUT', `No contract state on chain for address '${contractAddress}'`);
  }
  return authorityOf(read);
}

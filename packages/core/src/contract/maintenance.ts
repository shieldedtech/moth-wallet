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
import {openContract} from './midnight-js.js';

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

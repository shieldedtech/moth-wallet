// Contract maintenance updates: insert verifier keys, remove verifier keys,
// replace maintenance authority. Mirrors call.ts: syncs wallet, balances
// transaction, signs intents, submits.

import {readFileSync} from 'node:fs';
import type {TransactionResult} from '../types/transaction.js';
import {resolveProverConfig, type NetworkConfig} from '../types/network.js';
import type {DerivedKeys} from '../types/wallet.js';
import {createProofProvider, ensureProverReady} from '../proof/provider.js';
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {createMidnightProvider} from '../providers/midnight-provider.js';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {WalletError} from '../types/errors.js';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
import {createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import type {SyncedWallet} from '../sync/wallet-sync.js';
import type {WalletKeys} from '../sync/operations.js';

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

  setNetworkId(network.id);

  await ensureProverReady(resolveProverConfig(network));

  return insertViaSDK(options);
}

async function insertViaSDK(options: InsertVerifierKeyOptions): Promise<TransactionResult> {
  const {contractAddress, circuitId, verifierKeyPath, walletKeys, seedHex, network, artifactPath, syncedWallet, projectDir} =
    options;
  const {resolve: resolvePath, join, basename} = await import('node:path');
  const {pathToFileURL} = await import('node:url');
  const {createRequire} = await import('node:module');
  const {existsSync} = await import('node:fs');
  const {homedir} = await import('node:os');
  const {levelPrivateStateProvider} = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');

  // Resolve typed key bundle: prefer pre-derived walletKeys (daemon
  // path), fall back to deriving from seedHex (in-process CLI). D-KM-3.
  let shieldedSecretKeys: ledger.ZswapSecretKeys;
  let dustSecretKey: ledger.DustSecretKey;
  let nightExternalKey: Uint8Array;
  if (walletKeys) {
    shieldedSecretKeys = walletKeys.shieldedSecretKeys;
    dustSecretKey = walletKeys.dustSecretKey;
    nightExternalKey = walletKeys.nightExternalKey;
  } else {
    if (!seedHex) {
      throw new WalletError('WALLET_ERROR', 'insertVerifierKey requires either walletKeys or seedHex');
    }
    const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
    if (hdWallet.type !== 'seedOk') throw new WalletError('WALLET_ERROR', 'Invalid seed');
    const keyResult = hdWallet.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
      .deriveKeysAt(0);
    if (keyResult.type !== 'keysDerived') throw new WalletError('WALLET_ERROR', 'Key derivation failed');
    hdWallet.hdWallet.clear();
    shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keyResult.keys[Roles.Zswap]);
    dustSecretKey = ledger.DustSecretKey.fromSeed(keyResult.keys[Roles.Dust]);
    nightExternalKey = keyResult.keys[Roles.NightExternal];
  }
  const keystore = createKeystore(nightExternalKey, network.id);

  // Wait for wallet sync + dust stabilization (same as call.ts)
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
      }),
      Rx.bufferCount(2, 1),
      Rx.filter(([a, b]: any[]) => {
        try {
          const dustA = a.dust?.balance?.(new Date()) ?? 0n;
          const dustB = b.dust?.balance?.(new Date()) ?? 0n;
          return dustA === dustB;
        } catch {
          return true;
        }
      }),
      Rx.map(([, b]: any[]) => b)
    )
  );

  const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
  const encPublicKey = (state as any).shielded.encryptionPublicKey.toHexString() as string;
  const unshieldedAddr = (keystore.getBech32Address() as any).toString() as string;

  // Resolve SDK packages from the project's node_modules — keeps onchain-runtime instance unique.
  const projRoot = projectDir?.trim() || resolvePath(artifactPath, '..', '..');
  const projRequire = createRequire(resolvePath(projRoot, 'node_modules', '_virtual.js'));

  let CompiledContract: any;
  let submitInsertVerifierKeyTx: any;
  let createVerifierKey: any;
  try {
    CompiledContract = projRequire('@midnight-ntwrk/compact-js').CompiledContract;
    submitInsertVerifierKeyTx = projRequire('@midnight-ntwrk/midnight-js/contracts').submitInsertVerifierKeyTx;
    createVerifierKey = projRequire('@midnight-ntwrk/midnight-js/types').createVerifierKey;
  } catch {
    const cjs: any = await import('@midnight-ntwrk/compact-js');
    const contracts: any = await import('@midnight-ntwrk/midnight-js/contracts');
    const types: any = await import('@midnight-ntwrk/midnight-js/types');
    CompiledContract = cjs.CompiledContract;
    submitInsertVerifierKeyTx = contracts.submitInsertVerifierKeyTx;
    createVerifierKey = types.createVerifierKey;
  }

  // Load the FULL contract module — its TypeScript binding declares the circuit being added.
  const managedDir = artifactPath;
  const contractName = basename(managedDir);
  const contractJs = join(managedDir, 'contract', 'index.js');
  if (!existsSync(contractJs)) {
    throw new WalletError('INVALID_INPUT', `No compiled contract at ${contractJs}`);
  }
  const contractModule: any = await import(pathToFileURL(contractJs).href);

  // Build CompiledContract (vacant witnesses are fine — maintenance updates don't run circuits)
  const compiledContract: any = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
    (CompiledContract as any).withVacantWitnesses,
    (CompiledContract as any).withCompiledFileAssets(managedDir)
  );

  // Load the verifier key bytes from disk and wrap into the SDK type.
  const vkBytes = readFileSync(resolvePath(verifierKeyPath));
  const verifierKey = createVerifierKey(new Uint8Array(vkBytes));

  // Providers — same pattern as call.ts
  const zkConfigProvider = new NodeZkConfigProvider(artifactPath);
  void createMidnightProvider(network); // currently unused but kept for parity
  const indexerHttpUrl = network.indexerUrl;
  const indexerWsUrl = indexerHttpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
  const publicDataProvider = indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl);

  const proofProvider = createProofProvider(
    resolveProverConfig(network),
    zkConfigProvider.asKeyMaterialProvider(),
  );

  const walletProvider: any = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await (facade as any).balanceUnboundTransaction(
        tx,
        {shieldedSecretKeys, dustSecretKey},
        {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)}
      );
      const signFn = (payload: Uint8Array) => keystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }
      return (facade as any).finalizeRecipe(recipe);
    },
    submitTx: async (tx: any) => {
      return (facade as any).submitTransaction(tx);
    },
  };

  const levelDbDir = join(homedir(), '.moth', 'level-db', network.id, encPublicKey.slice(0, 16));

  // privateStateStoreName matches what the deploy used. The signing key was stored
  // under the contract NAME the stub was deployed with — which is the deployed
  // contract's name, NOT necessarily contractName. To be safe, default to deployed
  // contract's basename derived from artifactPath. Callers can override by ensuring
  // artifactPath basename matches what moth used at deploy.
  const providers = {
    zkConfigProvider: zkConfigProvider as any,
    proofProvider: proofProvider as any,
    walletProvider: walletProvider as any,
    midnightProvider: walletProvider as any,
    publicDataProvider: publicDataProvider as any,
    privateStateProvider: (levelPrivateStateProvider as any)({
      midnightDbName: levelDbDir,
      privateStateStoreName: contractName + '-state',
      privateStoragePasswordProvider: () => unshieldedAddr,
      accountId: unshieldedAddr,
    }),
  };

  const result = await (submitInsertVerifierKeyTx as any)(
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

  setNetworkId(network.id);
  await ensureProverReady(resolveProverConfig(network));

  return insertBatchViaSDK(options);
}

async function insertBatchViaSDK(options: InsertVerifierKeysOptions): Promise<BatchInsertResult> {
  const {contractAddress, entries, walletKeys, seedHex, network, artifactPath, syncedWallet, projectDir, skipExisting, onProgress} =
    options;
  const {resolve: resolvePath, join, basename} = await import('node:path');
  const {pathToFileURL} = await import('node:url');
  const {createRequire} = await import('node:module');
  const {existsSync} = await import('node:fs');
  const {homedir} = await import('node:os');
  const {levelPrivateStateProvider} = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');

  // One-time key resolution: prefer pre-derived walletKeys (daemon
  // path), fall back to deriving from seedHex (in-process CLI). D-KM-3.
  let shieldedSecretKeys: ledger.ZswapSecretKeys;
  let dustSecretKey: ledger.DustSecretKey;
  let nightExternalKey: Uint8Array;
  if (walletKeys) {
    shieldedSecretKeys = walletKeys.shieldedSecretKeys;
    dustSecretKey = walletKeys.dustSecretKey;
    nightExternalKey = walletKeys.nightExternalKey;
  } else {
    if (!seedHex) {
      throw new WalletError('WALLET_ERROR', 'insertVerifierKeys requires either walletKeys or seedHex');
    }
    const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
    if (hdWallet.type !== 'seedOk') throw new WalletError('WALLET_ERROR', 'Invalid seed');
    const keyResult = hdWallet.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
      .deriveKeysAt(0);
    if (keyResult.type !== 'keysDerived') throw new WalletError('WALLET_ERROR', 'Key derivation failed');
    hdWallet.hdWallet.clear();
    shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keyResult.keys[Roles.Zswap]);
    dustSecretKey = ledger.DustSecretKey.fromSeed(keyResult.keys[Roles.Dust]);
    nightExternalKey = keyResult.keys[Roles.NightExternal];
  }
  const keystore = createKeystore(nightExternalKey, network.id);

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
      }),
      Rx.bufferCount(2, 1),
      Rx.filter(([a, b]: any[]) => {
        try {
          const dustA = a.dust?.balance?.(new Date()) ?? 0n;
          const dustB = b.dust?.balance?.(new Date()) ?? 0n;
          return dustA === dustB;
        } catch {
          return true;
        }
      }),
      Rx.map(([, b]: any[]) => b)
    )
  );

  const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
  const encPublicKey = (state as any).shielded.encryptionPublicKey.toHexString() as string;
  const unshieldedAddr = (keystore.getBech32Address() as any).toString() as string;

  const projRoot = projectDir?.trim() || resolvePath(artifactPath, '..', '..');
  const projRequire = createRequire(resolvePath(projRoot, 'node_modules', '_virtual.js'));

  let CompiledContract: any;
  let submitInsertVerifierKeyTx: any;
  let createVerifierKey: any;
  try {
    CompiledContract = projRequire('@midnight-ntwrk/compact-js').CompiledContract;
    submitInsertVerifierKeyTx = projRequire('@midnight-ntwrk/midnight-js/contracts').submitInsertVerifierKeyTx;
    createVerifierKey = projRequire('@midnight-ntwrk/midnight-js/types').createVerifierKey;
  } catch {
    const cjs: any = await import('@midnight-ntwrk/compact-js');
    const contracts: any = await import('@midnight-ntwrk/midnight-js/contracts');
    const types: any = await import('@midnight-ntwrk/midnight-js/types');
    CompiledContract = cjs.CompiledContract;
    submitInsertVerifierKeyTx = contracts.submitInsertVerifierKeyTx;
    createVerifierKey = types.createVerifierKey;
  }

  const managedDir = artifactPath;
  const contractName = basename(managedDir);
  const contractJs = join(managedDir, 'contract', 'index.js');
  if (!existsSync(contractJs)) {
    throw new WalletError('INVALID_INPUT', `No compiled contract at ${contractJs}`);
  }
  const contractModule: any = await import(pathToFileURL(contractJs).href);

  const compiledContract: any = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
    (CompiledContract as any).withVacantWitnesses,
    (CompiledContract as any).withCompiledFileAssets(managedDir)
  );

  const zkConfigProvider = new NodeZkConfigProvider(artifactPath);
  void createMidnightProvider(network);
  const indexerHttpUrl = network.indexerUrl;
  const indexerWsUrl = indexerHttpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
  const publicDataProvider = indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl);

  const proofProvider = createProofProvider(
    resolveProverConfig(network),
    zkConfigProvider.asKeyMaterialProvider(),
  );

  const walletProvider: any = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await (facade as any).balanceUnboundTransaction(
        tx,
        {shieldedSecretKeys, dustSecretKey},
        {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)}
      );
      const signFn = (payload: Uint8Array) => keystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }
      return (facade as any).finalizeRecipe(recipe);
    },
    submitTx: async (tx: any) => {
      return (facade as any).submitTransaction(tx);
    },
  };

  const levelDbDir = join(homedir(), '.moth', 'level-db', network.id, encPublicKey.slice(0, 16));
  const providers = {
    zkConfigProvider: zkConfigProvider as any,
    proofProvider: proofProvider as any,
    walletProvider: walletProvider as any,
    midnightProvider: walletProvider as any,
    publicDataProvider: publicDataProvider as any,
    privateStateProvider: (levelPrivateStateProvider as any)({
      midnightDbName: levelDbDir,
      privateStateStoreName: contractName + '-state',
      privateStoragePasswordProvider: () => unshieldedAddr,
      accountId: unshieldedAddr,
    }),
  };

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
      const state = await publicDataProvider.queryContractState(contractAddress);
      // ContractState exposes operations as a Map keyed by circuitId — try
      // both common shapes to be resilient to SDK versions.
      const ops = (state as any)?.operations;
      if (ops && typeof ops.keys === 'function') {
        for (const k of ops.keys()) existingOps.add(String(k));
      } else if (ops && typeof ops === 'object') {
        for (const k of Object.keys(ops)) existingOps.add(k);
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
      const verifierKey = createVerifierKey(new Uint8Array(vkBytes));

      const result = await (submitInsertVerifierKeyTx as any)(
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

/** Sign unshielded transaction intents (copied from call.ts / deploy.ts) */
function signTransactionIntents(tx: any, signFn: (p: Uint8Array) => any, proofMarker: 'proof' | 'pre-proof'): void {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    const cloned = (ledger as any).Intent.deserialize('signature', proofMarker, 'pre-binding', intent.serialize());
    const signature = signFn(cloned.signatureData(segment));
    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.fallibleUnshieldedOffer.signatures.at(i) ?? signature
      );
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.guaranteedUnshieldedOffer.signatures.at(i) ?? signature
      );
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }
    tx.intents.set(segment, cloned);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Replace the contract maintenance authority.
//
// WHY THIS IS NOT `submitReplaceAuthorityTx`. The SDK's version swaps one
// signing key for one other signing key -- `replaceContractMaintenanceAuthority`
// takes an `Option<SigningKey>` and the TODO in midnight-js says as much. That
// cannot express a committee, and a committee is the point: a deploy leaves the
// contract under a single key that midnight-js sampled and stored in the local
// private-state DB, so every fresh contract has an unnamed 1-of-1 superuser.
// Losing that DB freezes the circuit set forever; copying it hands over the
// contract silently.
//
// So the update is built from ledger types directly: a
// `ContractMaintenanceAuthority` with the committee and threshold the caller
// asked for, wrapped in `ReplaceAuthority`, signed by a threshold of the
// CURRENT authority, and submitted as an intent carrying nothing else.
//
// The ledger types come from `@midnight-ntwrk/midnight-js-protocol/ledger` and
// not from this package's own `@midnight-ntwrk/ledger-v8` import: they must be
// the same WASM instance the SDK's `submitTx` will handle, or the boundary
// rejects them with `expected instance of ...`. Same trap as
// `expected instance of ChargedState` on the call path.
// ─────────────────────────────────────────────────────────────────────────

/** A member of the current authority, holding one signing key. */
export interface AuthoritySigner {
  /** Position in the CURRENT on-chain committee. Signatures are indexed by it. */
  index: number;
  signingKey: string;
}

export interface ReplaceAuthorityOptions {
  contractAddress: string;
  /** Verifying keys of the incoming committee. Empty when renouncing. */
  committee: string[];
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
  committee: string[];
  threshold: number;
  counter: bigint;
  /** True when the threshold cannot be met, so no update can ever be signed. */
  renounced: boolean;
}

export interface ReplaceAuthorityResult extends TransactionResult {
  previous: AuthorityDescription;
  next: AuthorityDescription;
  /** Whether the local signing key was dropped because it can no longer act alone. */
  localKeyRetained: boolean;
}

const describeAuthority = (cma: {
  committee: ArrayLike<unknown> | Iterable<unknown>;
  threshold: number;
  counter: bigint;
}): AuthorityDescription => {
  const committee = [...(cma.committee as Iterable<unknown>)].map(String);
  return {
    committee,
    threshold: Number(cma.threshold),
    counter: BigInt(cma.counter),
    renounced: Number(cma.threshold) > committee.length,
  };
};

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
    const unique = new Set(committee.map(String));
    if (unique.size !== committee.length) {
      throw new WalletError('INVALID_INPUT',
        'The committee contains a duplicate verifying key, which inflates the threshold without ' +
        'adding a custodian.');
    }
  }

  setNetworkId(network.id);
  await ensureProverReady(resolveProverConfig(network));

  return replaceAuthorityViaSDK(options);
}

async function replaceAuthorityViaSDK(options: ReplaceAuthorityOptions): Promise<ReplaceAuthorityResult> {
  const {contractAddress, committee, threshold, renounce, currentSigners} = options;
  const {providers, projRequire, compiledContract} = await buildMaintenanceContext(options);

  // require() first so the module comes from the project's tree and shares one
  // WASM instance with the contract artifact; import() second because several of
  // these packages are ESM-only and cannot be required at all
  // (`@midnight-ntwrk/compact-js/dist/cjs/effect/index.js` does not exist). The
  // insert paths above take the same two-step approach. Found by a live preprod
  // run: without the fallback this dies on module resolution before reaching the
  // chain.
  const load = async (spec: string): Promise<any> => {
    try {
      return projRequire(spec);
    } catch {
      return await import(spec);
    }
  };
  const protoLedger: any = await load('@midnight-ntwrk/midnight-js-protocol/ledger');
  const {Transaction, SucceedEntirely}: any = await load('@midnight-ntwrk/midnight-js/types');
  // The network id is module-global, and `load` may hand back a different module
  // instance from the one this file imported at the top (project tree via
  // require, moth's own via import). Setting it again on the instance actually
  // being read is not belt-and-braces: without it the SDK refuses with "Network
  // ID has not been configured" even though setNetworkId ran a moment earlier.
  const netMod: any = await load('@midnight-ntwrk/midnight-js/network-id');
  netMod.setNetworkId(options.network.id);
  const getNetworkId = netMod.getNetworkId;
  // Inlined rather than pulled from midnight-js-utils, whose CJS entry cannot be
  // resolved here at all: one hour is the SDK's own default intent TTL.
  const ttlOneHour = () => new Date(Date.now() + 60 * 60_000);

  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    throw new WalletError('INVALID_INPUT', `No contract state on chain for address '${contractAddress}'`);
  }
  const previous = describeAuthority((contractState as any).maintenanceAuthority);
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
    signers = [{index: 0, signingKey: local as string}];
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
    const actual = String(protoLedger.signatureVerifyingKey(signer.signingKey));
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
  // itself is valid against the current one. Both come from the ledger's own
  // replay-protection rule, not from a guess.
  const nextThreshold = renounce ? 1 : threshold;
  const nextCommittee = renounce ? [] : committee.map(String);
  const newAuthority = new protoLedger.ContractMaintenanceAuthority(
    nextCommittee, nextThreshold, previous.counter + 1n);

  let update = new protoLedger.MaintenanceUpdate(
    contractAddress, [new protoLedger.ReplaceAuthority(newAuthority)], previous.counter);
  // Captured once: every signature is over the same bytes, which is what lets
  // custodians sign separately rather than in one process.
  const dataToSign: Uint8Array = update.dataToSign;
  for (const signer of signers) {
    update = update.addSignature(BigInt(signer.index), protoLedger.signData(signer.signingKey, dataToSign));
  }

  const unprovenTx = Transaction.fromParts(
    getNetworkId(), undefined, undefined,
    protoLedger.Intent.new(ttlOneHour()).addMaintenanceUpdate(update));

  const {submitTx}: any = await load('@midnight-ntwrk/midnight-js/contracts');
  const result = await submitTx(providers as any, {unprovenTx});
  if (result?.status !== SucceedEntirely) {
    throw new WalletError('NETWORK_ERROR',
      `Authority replacement did not succeed entirely (status ${String(result?.status)}). ` +
      'The on-chain authority may be unchanged; re-read it before retrying.');
  }

  // The locally stored key is now either not a member at all, or one of several
  // that cannot act alone. Keeping it would let `insert-vk` believe it can still
  // maintain this contract and fail at the chain instead of at the keyboard.
  const localStillSuffices = !renounce && nextThreshold === 1 && signers.length === 1 &&
    nextCommittee.includes(String(protoLedger.signatureVerifyingKey(signers[0].signingKey)));
  if (!localStillSuffices) {
    await providers.privateStateProvider.removeSigningKey(contractAddress);
  }

  return {
    hash: (result as any)?.txId ?? (result as any)?.public?.txId ?? '',
    status: 'SUCCESS',
    blockHash: (result as any)?.blockHash ?? null,
    blockHeight: (result as any)?.blockHeight ?? null,
    contractAddress,
    fees: null,
    previous,
    next: {
      committee: nextCommittee,
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
  network: NetworkConfig,
): Promise<AuthorityDescription> {
  setNetworkId(network.id);
  const indexerHttpUrl = network.indexerUrl;
  const indexerWsUrl = indexerHttpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
  const publicDataProvider = indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl);
  const state = await publicDataProvider.queryContractState(contractAddress);
  if (!state) {
    throw new WalletError('INVALID_INPUT', `No contract state on chain for address '${contractAddress}'`);
  }
  return describeAuthority((state as any).maintenanceAuthority);
}

// ─────────────────────────────────────────────────────────────────────────
// Shared SDK context for maintenance updates.
//
// The two insert paths above each carry their own copy of this setup. This
// helper exists so the authority path does not become a third copy; they are
// left as they are because the only way to re-verify an insert is to submit a
// real one, and that is not a change worth risking for tidiness alone.
// ─────────────────────────────────────────────────────────────────────────

interface MaintenanceContext {
  providers: any;
  projRequire: NodeRequire;
  compiledContract: any;
  facade: any;
}

async function buildMaintenanceContext(options: {
  walletKeys?: WalletKeys;
  seedHex?: string;
  network: NetworkConfig;
  artifactPath: string;
  syncedWallet?: SyncedWallet;
  projectDir?: string;
}): Promise<MaintenanceContext> {
  const {walletKeys, seedHex, network, artifactPath, syncedWallet, projectDir} = options;
  const {resolve: resolvePath, join, basename} = await import('node:path');
  const {pathToFileURL} = await import('node:url');
  const {createRequire} = await import('node:module');
  const {existsSync} = await import('node:fs');
  const {homedir} = await import('node:os');
  const {levelPrivateStateProvider} = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');

  let shieldedSecretKeys: ledger.ZswapSecretKeys;
  let dustSecretKey: ledger.DustSecretKey;
  let nightExternalKey: Uint8Array;
  if (walletKeys) {
    shieldedSecretKeys = walletKeys.shieldedSecretKeys;
    dustSecretKey = walletKeys.dustSecretKey;
    nightExternalKey = walletKeys.nightExternalKey;
  } else {
    if (!seedHex) {
      throw new WalletError('WALLET_ERROR', 'maintenance updates require either walletKeys or seedHex');
    }
    const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
    if (hdWallet.type !== 'seedOk') throw new WalletError('WALLET_ERROR', 'Invalid seed');
    const keyResult = hdWallet.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
      .deriveKeysAt(0);
    if (keyResult.type !== 'keysDerived') throw new WalletError('WALLET_ERROR', 'Key derivation failed');
    hdWallet.hdWallet.clear();
    shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keyResult.keys[Roles.Zswap]);
    dustSecretKey = ledger.DustSecretKey.fromSeed(keyResult.keys[Roles.Dust]);
    nightExternalKey = keyResult.keys[Roles.NightExternal];
  }
  const keystore = createKeystore(nightExternalKey, network.id);

  // Wait for unshielded + dust sync to settle, and for the dust balance to stop
  // moving between two consecutive states -- balancing against a moving balance
  // fails at submission. Same wait as call.ts.
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
      }),
      Rx.bufferCount(2, 1),
      Rx.filter(([a, b]: any[]) => {
        try {
          return (a.dust?.balance?.(new Date()) ?? 0n) === (b.dust?.balance?.(new Date()) ?? 0n);
        } catch {
          return true;
        }
      }),
      Rx.map(([, b]: any[]) => b)
    )
  );

  const coinPublicKey = state.shielded.coinPublicKey.toHexString() as string;
  const encPublicKey = state.shielded.encryptionPublicKey.toHexString() as string;
  const unshieldedAddr = (keystore.getBech32Address() as any).toString() as string;

  // Resolve the SDK from the project's tree, so contract artifact and SDK share
  // one onchain-runtime instance.
  const projRoot = projectDir?.trim() || resolvePath(artifactPath, '..', '..');
  const projRequire = createRequire(resolvePath(projRoot, 'node_modules', '_virtual.js'));

  let CompiledContract: any;
  try {
    CompiledContract = projRequire('@midnight-ntwrk/compact-js').CompiledContract;
  } catch {
    CompiledContract = (await import('@midnight-ntwrk/compact-js')).CompiledContract;
  }

  const managedDir = artifactPath;
  const contractName = basename(managedDir);
  const contractJs = join(managedDir, 'contract', 'index.js');
  if (!existsSync(contractJs)) {
    throw new WalletError('INVALID_INPUT', `No compiled contract at ${contractJs}`);
  }
  const contractModule: any = await import(pathToFileURL(contractJs).href);

  // Vacant witnesses are fine: a maintenance update runs no circuit.
  const compiledContract: any = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
    (CompiledContract as any).withVacantWitnesses,
    (CompiledContract as any).withCompiledFileAssets(managedDir)
  );

  const zkConfigProvider = new NodeZkConfigProvider(artifactPath);
  const indexerHttpUrl = network.indexerUrl;
  const indexerWsUrl = indexerHttpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
  const publicDataProvider = indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl);
  const proofProvider = createProofProvider(
    resolveProverConfig(network),
    zkConfigProvider.asKeyMaterialProvider(),
  );

  const walletProvider: any = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await (facade as any).balanceUnboundTransaction(
        tx,
        {shieldedSecretKeys, dustSecretKey},
        {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)}
      );
      const signFn = (payload: Uint8Array) => keystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }
      return (facade as any).finalizeRecipe(recipe);
    },
    submitTx: async (tx: any) => (facade as any).submitTransaction(tx),
  };

  const levelDbDir = join(homedir(), '.moth', 'level-db', network.id, encPublicKey.slice(0, 16));
  const providers = {
    zkConfigProvider: zkConfigProvider as any,
    proofProvider: proofProvider as any,
    walletProvider,
    midnightProvider: walletProvider,
    publicDataProvider: publicDataProvider as any,
    privateStateProvider: (levelPrivateStateProvider as any)({
      midnightDbName: levelDbDir,
      privateStateStoreName: contractName + '-state',
      privateStoragePasswordProvider: () => unshieldedAddr,
      accountId: unshieldedAddr,
    }),
  };

  return {providers, projRequire, compiledContract, facade};
}

// Contract maintenance updates: insert verifier keys, remove verifier keys,
// replace maintenance authority. Mirrors call.ts: syncs wallet, balances
// transaction, signs intents, submits.

import {readFileSync} from 'node:fs';
import type {TransactionResult} from '../types/transaction.js';
import {resolveProverConfig, type NetworkConfig, resolveLedgerVersion} from '../types/network.js';
import type {DerivedKeys} from '../types/wallet.js';
import {createProofProvider, ensureProverReady} from '../proof/provider.js';
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {createMidnightProvider} from '../providers/midnight-provider.js';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {WalletError} from '../types/errors.js';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import * as Rx from 'rxjs';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {ledger as activeLedger, activeLedgerVersion} from '../ledger/index.js';
import {verifyNetworkLedger} from '../ledger/protocol-version.js';
import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
import {createKeystoreFor} from '../sdk/index.js';
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
    shieldedSecretKeys = activeLedger().ZswapSecretKeys.fromSeed(keyResult.keys[Roles.Zswap]);
    dustSecretKey = activeLedger().DustSecretKey.fromSeed(keyResult.keys[Roles.Dust]);
    nightExternalKey = keyResult.keys[Roles.NightExternal];
  }
  const keystore = createKeystoreFor(nightExternalKey, network.id);

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
      // Refuse before submitting if the wallet's ledger does not match the
      // network's. The two ledgers reject each other's transactions with a bare
      // header-tag error, and Merkle sync succeeds across the fork, so without
      // this the mismatch first shows up as an unreadable failure here.
      await verifyNetworkLedger(network, {using: activeLedgerVersion() ?? resolveLedgerVersion(network)});
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
    shieldedSecretKeys = activeLedger().ZswapSecretKeys.fromSeed(keyResult.keys[Roles.Zswap]);
    dustSecretKey = activeLedger().DustSecretKey.fromSeed(keyResult.keys[Roles.Dust]);
    nightExternalKey = keyResult.keys[Roles.NightExternal];
  }
  const keystore = createKeystoreFor(nightExternalKey, network.id);

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
      // Refuse before submitting if the wallet's ledger does not match the
      // network's. The two ledgers reject each other's transactions with a bare
      // header-tag error, and Merkle sync succeeds across the fork, so without
      // this the mismatch first shows up as an unreadable failure here.
      await verifyNetworkLedger(network, {using: activeLedgerVersion() ?? resolveLedgerVersion(network)});
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
    const cloned = (activeLedger() as any).Intent.deserialize('signature', proofMarker, 'pre-binding', intent.serialize());
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

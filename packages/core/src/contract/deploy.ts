// Contract deployment using the official Midnight SDK provider chain.
// Follows mn-tui's deployManagedContract pattern. See NOTICE for attribution.

import {existsSync} from 'node:fs';
import {join, basename, resolve as resolvePath} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import * as Rx from 'rxjs';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {ledger as activeLedger, activeLedgerVersion} from '../ledger/index.js';
import {verifyNetworkLedger} from '../ledger/protocol-version.js';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {levelPrivateStateProvider} from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
import {createKeystoreFor, sdk} from '../sdk/index.js';
import {MidnightBech32m, UnshieldedAddress} from '@midnightntwrk/wallet-sdk/address-format';
import {homedir} from 'node:os';

import type {TransactionResult} from '../types/transaction.js';
import {resolveProverConfig, type NetworkConfig, resolveLedgerVersion} from '../types/network.js';
import {createProofProvider, ensureProverReady} from '../proof/provider.js';
import type {ContractArtifact} from './artifact-loader.js';
import {WalletError, TimeoutError} from '../types/errors.js';
import type {SyncedWallet} from '../sync/wallet-sync.js';
import type {WalletKeys} from '../sync/operations.js';

export interface DeployOptions {
  artifact: ContractArtifact;
  /** Pre-derived typed key bundle. Preferred over `seedHex` when
   *  available — the daemon path passes this so the raw seed never
   *  has to enter the contract module. See
   *  docs/spec/wallet-service/05-key-management.md D-KM-3. */
  walletKeys?: WalletKeys;
  /** BIP-39 hex seed. Required only when `walletKeys` is not supplied. */
  seedHex?: string;
  network: NetworkConfig;
  /** A synced wallet facade — required for balancing transactions */
  syncedWallet?: SyncedWallet;
  witnessPath?: string;
  /** Project directory containing node_modules with matching SDK versions */
  projectDir?: string;
  timeoutMs?: number;
  onProgress?: (stage: string) => void;
  /**
   * Positional constructor arguments, in the order defined by the compiled contract's
   * generated `initialState(ctx, ...ctorArgs)`. Omit (or pass an empty array) for
   * contracts with a no-argument constructor.
   */
  args?: unknown[];
  /**
   * The initial private state to run the contract constructor against. Defaults to `{}`
   * to preserve prior behavior for contracts with no meaningful private state.
   */
  initialPrivateState?: unknown;
}

function toWsUrl(url: string): string {
  return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/** Walk an error's cause chain and Effect TaggedError fields to find the real reason */
function extractErrorDetails(err: unknown, depth = 0): string {
  if (!err || depth > 5) return '';
  const parts: string[] = [];

  // Effect TaggedError stores fields as own properties (cause, _tag, message, etc.)
  const obj = err as Record<string, unknown>;
  if (obj._tag && obj._tag !== 'SubmissionError') {
    parts.push(`[${obj._tag}]`);
  }

  // Standard Error.cause (ES2022)
  const cause = obj.cause;
  if (cause) {
    if (cause instanceof Error) {
      parts.push(cause.message);
      const nested = extractErrorDetails(cause, depth + 1);
      if (nested) parts.push(nested);
    } else if (typeof cause === 'object') {
      // Effect errors: check for message, _tag, or stringify
      const c = cause as Record<string, unknown>;
      if (c._tag) parts.push(`[${c._tag}]`);
      if (c.message && typeof c.message === 'string') parts.push(c.message);
      if (c.reason && typeof c.reason === 'string') parts.push(c.reason);
      const nested = extractErrorDetails(cause, depth + 1);
      if (nested) parts.push(nested);
      // If nothing extracted, try JSON
      if (parts.length === 0) {
        try {
          parts.push(JSON.stringify(cause).slice(0, 500));
        } catch {
          /* skip */
        }
      }
    } else {
      parts.push(String(cause));
    }
  }

  // Some SDK errors use 'error' or 'reason' fields
  if (obj.error && typeof obj.error === 'string') parts.push(obj.error);
  if (obj.reason && typeof obj.reason === 'string' && !parts.includes(obj.reason)) parts.push(obj.reason);

  // Node/RPC errors often carry a numeric `code` and a `data` payload with the
  // real rejection reason (e.g. a runtime/pool error). Capture them directly.
  if (typeof obj.code === 'string' || typeof obj.code === 'number') parts.push(`code=${obj.code}`);
  if (obj.data !== undefined) {
    const d = typeof obj.data === 'string' ? obj.data : safeJson(obj.data);
    if (d) parts.push(`data=${d}`);
  }

  // Last resort at the top level: dump own property names (captures
  // non-enumerable Error fields and opaque SDK/RPC payloads the structured
  // walk missed) so a generic "submission error" still yields a real reason.
  if (depth === 0 && parts.length === 0) {
    const raw = safeJson(
      Object.fromEntries(
        Object.getOwnPropertyNames(obj)
          .filter((k) => k !== 'stack')
          .map((k) => [k, obj[k]]),
      ),
    );
    if (raw && raw !== '{}') parts.push(`raw=${raw.slice(0, 600)}`);
  }

  return parts.filter(Boolean).join(' — ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
  } catch {
    return '';
  }
}

export async function deployContract(options: DeployOptions): Promise<TransactionResult> {
  const {
    artifact,
    walletKeys,
    seedHex,
    network,
    syncedWallet,
    witnessPath: rawWitnessPath,
    projectDir,
    timeoutMs = 120_000,
    onProgress,
    args: constructorArgs = [],
    initialPrivateState = {},
  } = options;
  const witnessPath = rawWitnessPath?.trim();
  const prover = resolveProverConfig(network);
  await ensureProverReady(prover);

  // Resolve SDK packages and handle WASM class identity mismatches (CWE-706).
  // compact-js creates WASM objects (ContractMaintenanceAuthority, etc.) from our
  // tree's onchain-runtime-v3, but the contract module validates them against the
  // project's copy. Since WASM classes hold pointers into separate linear memories,
  // we can't just bypass instanceof — we must serialize/deserialize across trees.
  const projRoot = projectDir?.trim() || resolvePath(artifact.path, '..', '..');
  const projRequire = createRequire(resolvePath(projRoot, 'node_modules', '_virtual.js'));

  // Patch WASM class setters to bridge cross-tree identity mismatches (CWE-706).
  // When compact-js (from our tree) creates WASM objects and assigns them to
  // ContractState (from the project's tree), _assertClass fails because the
  // classes come from different WASM instantiations with separate linear memories.
  // We intercept setters to serialize incoming objects and deserialize them through
  // the project's WASM module, converting pointers to the correct memory space.
  const patchedProperties: Array<{proto: any; prop: string; desc: PropertyDescriptor}> = [];
  try {
    const projRuntime = projRequire('@midnight-ntwrk/onchain-runtime-v3');

    // Map: [HostPrototype, propertyName, ExpectedWASMClass]
    // Only maintenanceAuthority crosses tree boundaries — setOperation receives
    // objects from the same tree since they come from contractState.operation().
    const settersToProxy: Array<[string, string, string]> = [
      ['ContractState', 'maintenanceAuthority', 'ContractMaintenanceAuthority'],
    ];

    for (const [hostClass, prop, expectedClass] of settersToProxy) {
      const proto = projRuntime[hostClass]?.prototype;
      const ExpectedKlass = projRuntime[expectedClass];
      if (!proto || !ExpectedKlass) continue;

      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc?.set || !desc.configurable) continue;

      const origSetter = desc.set;
      patchedProperties.push({proto, prop, desc});

      Object.defineProperty(proto, prop, {
        get: desc.get,
        set(value: any) {
          if (value instanceof ExpectedKlass) {
            return origSetter.call(this, value);
          }
          // Cross-tree: serialize → deserialize into project's WASM memory
          if (typeof value?.serialize === 'function' && typeof ExpectedKlass.deserialize === 'function') {
            const converted = ExpectedKlass.deserialize(value.serialize());
            return origSetter.call(this, converted);
          }
          return origSetter.call(this, value);
        },
        configurable: true,
        enumerable: desc.enumerable,
      });
    }
  } catch {
    // Project doesn't have onchain-runtime-v3 — no patching needed
  }

  let CompiledContract: any;
  let sdkDeployContract: any;
  try {
    CompiledContract = projRequire('@midnight-ntwrk/compact-js').CompiledContract;
    sdkDeployContract = projRequire('@midnight-ntwrk/midnight-js/contracts').deployContract;
  } catch {
    const cjs = await import('@midnight-ntwrk/compact-js');
    const contracts = await import('@midnight-ntwrk/midnight-js/contracts');
    CompiledContract = cjs.CompiledContract;
    sdkDeployContract = contracts.deployContract;
  }

  setNetworkId(network.id);

  // Resolve typed key bundle: prefer pre-derived walletKeys (daemon
  // path), fall back to deriving from seedHex (existing in-process
  // CLI path). See docs/spec/wallet-service/05-key-management.md D-KM-3.
  let shieldedSecretKeys: ledger.ZswapSecretKeys;
  let dustSecretKey: ledger.DustSecretKey;
  let nightExternalKey: Uint8Array;
  if (walletKeys) {
    shieldedSecretKeys = walletKeys.shieldedSecretKeys;
    dustSecretKey = walletKeys.dustSecretKey;
    nightExternalKey = walletKeys.nightExternalKey;
  } else {
    if (!seedHex) {
      throw new WalletError('WALLET_ERROR', 'deployContract requires either walletKeys or seedHex');
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

  // Build wallet provider from facade (same as mn-tui's buildWalletProvider)
  if (!syncedWallet?.facade) {
    throw new WalletError('WALLET_ERROR', 'Wallet must be synced before deploying. Unlock and wait for sync.');
  }

  const facade = syncedWallet.facade;
  // Wait for isSynced, then wait for dust balance to stabilize.
  // The facade can report isSynced before the dust wallet finishes reconciling
  // its UTXO set from cache, causing balanceUnboundTransaction to fail.
  const state: any = await Rx.firstValueFrom(
    (facade.state() as Rx.Observable<any>).pipe(
      Rx.tap(
        (() => {
          let lastPct = -1;
          return (s: any) => {
            try {
              const dp = s.dust?.progress;
              if (dp && !dp.isStrictlyComplete?.()) {
                const pct =
                  dp.highestRelevantWalletIndex > 0n
                    ? Math.round(Number((dp.appliedIndex * 100n) / dp.highestRelevantWalletIndex))
                    : 0;
                if (pct !== lastPct) {
                  lastPct = pct;
                  onProgress?.(`Dust sync: ${pct}%`);
                }
              }
            } catch {}
          };
        })()
      ),
      Rx.filter((s: any) => {
        // Dust must be fully synced — InvalidDustSpendProof (error 170) if tree root is stale.
        try {
          const unDone = s.unshielded?.progress?.isStrictlyComplete?.() === true;
          const dustDone = s.dust?.progress?.isStrictlyComplete?.() === true;
          if (unDone && dustDone) return true;
        } catch {}
        return s.isSynced === true;
      }),
      // After isSynced, wait for two consecutive emissions with the same dust balance
      Rx.bufferCount(2, 1),
      Rx.filter(([a, b]: any[]) => {
        try {
          const dustA = a.dust?.balance?.(new Date()) ?? 0n;
          const dustB = b.dust?.balance?.(new Date()) ?? 0n;
          return dustA === dustB;
        } catch {
          return true;
        } // If dust isn't available, don't block forever
      }),
      Rx.map(([, b]: any[]) => b)
    )
  );

  const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
  const encPublicKey = (state as any).shielded.encryptionPublicKey.toHexString() as string;
  const unshieldedAddr = (keystore.getBech32Address() as any).toString() as string;

  const walletProvider: any = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await (facade as any).balanceUnboundTransaction(
        tx,
        {shieldedSecretKeys, dustSecretKey},
        {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)}
      );
      // Sign unshielded transaction intents
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

  // Build contract providers (same as mn-tui's buildContractProviders)
  const managedDir = artifact.path;
  const contractName = basename(managedDir);
  const indexerHttpUrl = network.indexerUrl;
  const indexerWsUrl = toWsUrl(indexerHttpUrl) + '/ws';
  const zkCfgProvider = new NodeZkConfigProvider(managedDir);
  const levelDbDir = join(homedir(), '.moth', 'level-db', network.id, encPublicKey.slice(0, 16));

  const providers: any = {
    privateStateProvider: (levelPrivateStateProvider as any)({
      midnightDbName: levelDbDir,
      privateStateStoreName: contractName + '-state',
      privateStoragePasswordProvider: () => unshieldedAddr,
      accountId: unshieldedAddr,
    }),
    publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
    zkConfigProvider: zkCfgProvider,
    proofProvider: createProofProvider(prover, zkCfgProvider.asKeyMaterialProvider()),
    walletProvider,
    midnightProvider: walletProvider,
  };

  // Load contract module
  const contractJs = join(managedDir, 'contract', 'index.js');
  if (!existsSync(contractJs)) {
    throw new WalletError('INVALID_INPUT', `No compiled contract at ${contractJs}`);
  }
  const contractModule: any = await import(pathToFileURL(contractJs).href);

  // Build CompiledContract using the .pipe() pattern
  let compiledContract: any;
  if (witnessPath) {
    const witMod: any = await import(pathToFileURL(witnessPath).href);
    // Support multiple witness export patterns:
    //   1. export default (walletProvider) => ({ localSecretKey: ... })  — factory function
    //   2. export default { localSecretKey: ... }                       — plain object
    //   3. export const witnesses = { localSecretKey: ... }             — named export
    let witnessObj: any;
    if (typeof witMod.default === 'function') {
      witnessObj = witMod.default(walletProvider);
    } else if (witMod.default && typeof witMod.default === 'object') {
      witnessObj = witMod.default;
    } else if (witMod.witnesses && typeof witMod.witnesses === 'object') {
      witnessObj = witMod.witnesses;
    } else {
      throw new WalletError(
        'INVALID_INPUT',
        'Witness file must export default (function or object) or a named "witnesses" export'
      );
    }
    compiledContract = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
      (CompiledContract as any).withWitnesses(witnessObj),
      (CompiledContract as any).withCompiledFileAssets(managedDir)
    );
  } else {
    compiledContract = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
      (CompiledContract as any).withVacantWitnesses,
      (CompiledContract as any).withCompiledFileAssets(managedDir)
    );
  }

  onProgress?.('proving');

  try {
    const deployOptions: Record<string, unknown> = {
      compiledContract,
      privateStateId: contractName + 'State',
      initialPrivateState,
    };
    // Only include `args` when the constructor actually takes arguments — the SDK's
    // options type narrows to a variant without an `args` field for no-arg constructors.
    if (constructorArgs.length > 0) {
      deployOptions.args = constructorArgs;
    }
    const deployed: any = await (sdkDeployContract as any)(providers, deployOptions);

    const contractAddress: string = deployed.deployTxData.public.contractAddress;

    onProgress?.('deployed');

    return {
      hash: deployed.deployTxData?.public?.txId ?? '',
      status: 'SUCCESS',
      blockHash: deployed.deployTxData?.public?.blockHash ?? null,
      blockHeight: deployed.deployTxData?.public?.blockHeight ?? null,
      contractAddress,
      fees: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface the full error chain — SDK errors (Effect TaggedErrors, nested causes) bury details
    const details = extractErrorDetails(err);
    const detail = details ? `Deploy failed: ${msg} — ${details}` : `Deploy failed: ${msg}`;
    const walletErr = new WalletError('WALLET_ERROR', detail);
    if (err instanceof Error && err.stack) (walletErr as any).originalStack = err.stack;
    throw walletErr;
  } finally {
    // Restore original WASM setters
    for (const {proto, prop, desc} of patchedProperties) {
      try {
        Object.defineProperty(proto, prop, desc);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Sign unshielded transaction intents (same as mn-tui's signTransactionIntents) */
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

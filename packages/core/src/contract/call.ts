// Circuit call using the official Midnight SDK provider chain.
// Mirrors deploy.ts: syncs wallet, balances transaction, signs intents, submits.

import type {TransactionResult} from '../types/transaction.js';
import {resolveProverConfig, type NetworkConfig, resolveLedgerVersion} from '../types/network.js';
import type {DerivedKeys} from '../types/wallet.js';
import type {WalletKeys} from '../sync/operations.js';
import {createProofProvider, ensureProverReady} from '../proof/provider.js';
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {createMidnightProvider} from '../providers/midnight-provider.js';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {WalletError} from '../types/errors.js';
import {toPositionalArgs} from './args-parser.js';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import * as Rx from 'rxjs';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {ledger as activeLedger, activeLedgerVersion} from '../ledger/index.js';
import {verifyNetworkLedger} from '../ledger/protocol-version.js';
import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
import type {SignatureKind} from '../wallet/signature-encoding.js';
import {createKeystoreFor, sdk} from '../sdk/index.js';
import type {WitnessProvider} from './witness-loader.js';
import type {SyncedWallet} from '../sync/wallet-sync.js';
import {loadProjectStack, bridgeTx} from './project-stack.js';

export interface CallOptions {
  contractAddress: string;
  circuitName: string;
  args: unknown;
  keys: DerivedKeys;
  /** Pre-derived typed key bundle. Preferred over `seedHex` when
   *  available — the daemon path passes this so the raw seed never
   *  has to enter the contract module. See
   *  docs/spec/wallet-service/05-key-management.md D-KM-3. */
  walletKeys?: WalletKeys;
  /** BIP-39 hex seed. Required only when `walletKeys` is not supplied
   *  — kept for the in-process CLI path that still works in terms of
   *  the seed. */
  seedHex?: string;
  witnesses?: WitnessProvider;
  network: NetworkConfig;
  /** Path to compiled contract artifact — required for circuit execution and proof generation */
  artifactPath: string;
  /** A synced wallet facade — required for balancing transactions */
  syncedWallet?: SyncedWallet;
  /** Project directory for resolving SDK dependencies */
  projectDir?: string;
  timeoutMs?: number;
}

export async function callCircuit(options: CallOptions): Promise<TransactionResult> {
  const {contractAddress, circuitName, network, artifactPath} = options;

  if (!artifactPath) {
    throw new WalletError(
      'INVALID_INPUT',
      'Circuit calls require a compiled contract artifact (--artifact). ' +
        'The artifact provides ZK circuits and contract logic needed for proof generation.'
    );
  }

  if (!options.syncedWallet?.facade) {
    throw new WalletError('WALLET_ERROR', 'Wallet must be synced before calling circuits. Unlock and wait for sync.');
  }

  setNetworkId(network.id);

  await ensureProverReady(resolveProverConfig(network));

  return callViaSDK(options);
}

async function callViaSDK(options: CallOptions): Promise<TransactionResult> {
  const {contractAddress, circuitName, args, walletKeys, seedHex, witnesses, network, artifactPath, syncedWallet, projectDir} =
    options;
  const {resolve: resolvePath, join, basename} = await import('node:path');
  const {pathToFileURL} = await import('node:url');
  const {existsSync} = await import('node:fs');
  const {homedir} = await import('node:os');
  const {levelPrivateStateProvider} = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');

  // Resolve the typed key bundle: prefer the pre-derived walletKeys
  // (daemon path) and fall back to deriving from seedHex (existing
  // in-process CLI path). See
  // docs/spec/wallet-service/05-key-management.md D-KM-3.
  let shieldedSecretKeys: ledger.ZswapSecretKeys;
  let dustSecretKey: ledger.DustSecretKey;
  let nightExternalKey: Uint8Array;
  // A bundle knows its kind. A bare seed does not — it is the legacy path, and
  // a caller that needs ECDSA has to pass walletKeys.
  let signatureKind: SignatureKind = 'schnorr';
  if (walletKeys) {
    shieldedSecretKeys = walletKeys.shieldedSecretKeys;
    dustSecretKey = walletKeys.dustSecretKey;
    nightExternalKey = walletKeys.nightExternalKey;
    signatureKind = walletKeys.signatureKind;
  } else {
    if (!seedHex) {
      throw new WalletError('WALLET_ERROR', 'callCircuit requires either walletKeys or seedHex');
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
  const keystore = createKeystoreFor(nightExternalKey, network.id, signatureKind);

  // Wait for wallet sync + dust stabilization (same as deploy.ts)
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

  // Resolve SDK packages from the project's node_modules
  const projRoot = projectDir?.trim() || resolvePath(artifactPath, '..', '..');

  // The project's own stack, wherever it ships one — see project-stack.ts.
  const project = await loadProjectStack(projRoot);
  // The network id is a per-tree global in midnight-js. callCircuit already set
  // it in moth's tree; set it in whichever tree builds the transaction too.
  project.networkId?.setNetworkId(network.id);
  const CompiledContract: any =
    project.compactJs?.CompiledContract ?? (await import('@midnight-ntwrk/compact-js')).CompiledContract;
  // findDeployedContract instead of submitCallTx — fixes a bug where
  // calling a contract moth did not itself deploy throws "No private
  // state found at private state ID '<contractName>State'".
  // submitCallTx uses an older code path that doesn't honor
  // initialPrivateState. findDeployedContract DOES write
  // initialPrivateState before returning a callTx handle, so the
  // private state exists by the time the inner submitCallTx runs.
  const findDeployedContract: any =
    project.contracts?.findDeployedContract ??
    ((await import('@midnight-ntwrk/midnight-js/contracts')) as any).findDeployedContract;

  // Load the contract module
  const managedDir = artifactPath;
  const contractName = basename(managedDir);
  const contractJs = join(managedDir, 'contract', 'index.js');
  if (!existsSync(contractJs)) {
    throw new WalletError('INVALID_INPUT', `No compiled contract at ${contractJs}`);
  }
  const contractModule: any = await import(pathToFileURL(contractJs).href);

  // Build CompiledContract using the .pipe() pattern (same as deploy)
  let compiledContract: any;
  if (witnesses) {
    compiledContract = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
      (CompiledContract as any).withWitnesses(witnesses),
      (CompiledContract as any).withCompiledFileAssets(managedDir)
    );
  } else {
    compiledContract = (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
      (CompiledContract as any).withVacantWitnesses,
      (CompiledContract as any).withCompiledFileAssets(managedDir)
    );
  }

  // Providers — same pattern as deploy.ts
  const ZkConfigProvider = project.nodeZkConfigProvider ?? NodeZkConfigProvider;
  const zkConfigProvider: any = new ZkConfigProvider(artifactPath);
  const midnightProvider = createMidnightProvider(network);
  const indexerHttpUrl = network.indexerUrl;
  const indexerWsUrl = indexerHttpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
  const indexerProvider = project.indexerPublicDataProvider ?? indexerPublicDataProvider;
  const publicDataProvider = indexerProvider(indexerHttpUrl, indexerWsUrl);

  // Selectable prover (reconcile decision #1: keep EITHER WASM or server).
  // createProofProvider picks per resolveProverConfig(network). For server mode
  // it proves through the SDK's httpClientProvingProvider via ledger's
  // transaction.prove(), which runs the preimage through
  // createProvingPayload/createCheckPayload — i.e. it versions the payload and
  // attaches the circuit's wrapped-IR from zkConfigProvider. That is why it does
  // NOT hit the unversioned "expected proof-preimage-versioned" failure that a
  // hand-rolled bare-preimage POST would (the fix/tui-circuit-call-proof bug):
  // the versioning happens inside ledger.prove, not in the provider.
  // The proof provider hands the transaction to the ledger to prove, so it has
  // to come from the tree that built it. moth's own is the fallback for
  // projects that ship no SDK of their own.
  const prover = resolveProverConfig(network);
  const proofProvider =
    prover.type === 'server' && project.httpClientProofProvider
      ? project.httpClientProofProvider(prover.url, zkConfigProvider)
      : createProofProvider(prover, zkConfigProvider.asKeyMaterialProvider());

  // Wallet provider with real transaction balancing + signing (same as deploy.ts)
  const walletProvider: any = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await (facade as any).balanceUnboundTransaction(
        bridgeTx(tx, activeLedger(), 'pre-binding'),
        {shieldedSecretKeys, dustSecretKey},
        {ttl: ttl ?? new Date(Date.now() + 30 * 60_000)}
      );
      const signFn = (payload: Uint8Array) => keystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }
      return bridgeTx(await (facade as any).finalizeRecipe(recipe), project.ledger, 'binding');
    },
    submitTx: async (tx: any) => {
      // Refuse before submitting if the wallet's ledger does not match the
      // network's. The two ledgers reject each other's transactions with a bare
      // header-tag error, and Merkle sync succeeds across the fork, so without
      // this the mismatch first shows up as an unreadable failure here.
      await verifyNetworkLedger(network, {using: activeLedgerVersion() ?? resolveLedgerVersion(network)});
      return (facade as any).submitTransaction(bridgeTx(tx, activeLedger(), 'binding'));
    },
  };

  const levelDbDir = join(homedir(), '.moth', 'level-db', network.id, encPublicKey.slice(0, 16));

  const providers = {
    zkConfigProvider: zkConfigProvider as any,
    proofProvider: proofProvider as any,
    walletProvider: walletProvider as any,
    midnightProvider: walletProvider as any,
    publicDataProvider: publicDataProvider as any,
    privateStateProvider: ((project.levelPrivateStateProvider ?? levelPrivateStateProvider) as any)({
      midnightDbName: levelDbDir,
      privateStateStoreName: contractName + '-state',
      privateStoragePasswordProvider: () => unshieldedAddr,
      accountId: unshieldedAddr,
    }),
  };

  // Normalize user-supplied args into a positional argument array, matching the
  // convention used by `deploy` (see toPositionalArgs):
  //   - a JSON array is spread into positional circuit arguments
  //   - a single object/scalar becomes one argument
  //   - the "no args" sentinels that both the CLI and daemon pass when the user
  //     supplied nothing ({} / undefined) collapse to [], and an explicit empty
  //     array [] stays empty — so circuits like `issue_credential(context)` that
  //     take no user args aren't sent a spurious argument ("expected 1 argument,
  //     received 2").

  // findDeployedContract populates private state at `privateStateId` from
  // `initialPrivateState` BEFORE returning a callTx handle. The inner
  // submitCallTx (invoked when we call deployed.callTx[circuit]) then
  // finds the state and proceeds normally.
  const deployed = await (findDeployedContract as any)(providers, {
    contractAddress,
    compiledContract,
    privateStateId: contractName + 'State',
    initialPrivateState: {},
  });

  const callArgs = toPositionalArgs(args);
  let result;
  try {
    result = await deployed.callTx[circuitName](...callArgs);
  } catch (err: any) {
    // Effect-TS / midnight-js wraps the real cause inside several layers.
    // Walk and log them so wallet errors surface in moth's JSON output.
    let cur = err;
    let depth = 0;
    const chain: string[] = [];
    while (cur && depth < 8) {
      const tag = cur._tag ?? cur.name ?? cur.constructor?.name ?? 'Error';
      chain.push(`[${depth}] ${tag}: ${cur.message ?? String(cur)}`);
      cur = cur.cause ?? cur.failure;
      depth++;
    }
    process.stderr.write('Circuit error chain:\n' + chain.join('\n') + '\n');
    throw err;
  }

  return {
    hash: result?.public?.txId ?? '',
    status: 'SUCCESS',
    blockHash: result?.public?.blockHash ?? null,
    blockHeight: result?.public?.blockHeight ?? null,
    contractAddress,
    fees: null,
  };
}

/** Sign unshielded transaction intents (same as deploy.ts / mn-tui) */
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

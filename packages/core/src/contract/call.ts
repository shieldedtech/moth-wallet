// Circuit call using the official Midnight SDK provider chain.
// Mirrors deploy.ts: syncs wallet, balances transaction, signs intents, submits.

import type {TransactionResult} from '../types/transaction.js';
import {resolveProverConfig, type NetworkConfig} from '../types/network.js';
import type {DerivedKeys} from '../types/wallet.js';
import type {WalletKeys} from '../sync/operations.js';
import {ensureProverReady} from '../proof/provider.js';
import {WalletError} from '../types/errors.js';
import {toPositionalArgs} from './args-parser.js';
import * as Rx from 'rxjs';
import {createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import type {WitnessProvider} from './witness-loader.js';
import type {SyncedWallet} from '../sync/wallet-sync.js';
import {unshieldedSecretOf} from './wallet-provider.js';
import {openContract} from './midnight-js.js';

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

  await ensureProverReady(resolveProverConfig(network));

  return callViaSDK(options);
}

async function callViaSDK(options: CallOptions): Promise<TransactionResult> {
  const {contractAddress, circuitName, args, walletKeys, seedHex, witnesses, network, artifactPath, syncedWallet, projectDir} =
    options;

  // The unshielded signing secret: the pre-derived walletKeys (daemon path), else
  // derived from seedHex (in-process CLI path). D-KM-3.
  const keystore = createKeystore({kind: 'schnorr', secret: unshieldedSecretOf(walletKeys, seedHex, 'callCircuit')}, network.id);

  // Wait for wallet sync before building the transaction.
  const facade = syncedWallet!.facade;
  // A stale dust tree root is rejected as InvalidDustSpendProof (error 170), so wait
  // for strict completion. Waiting further for two equal DUST balances, as this once
  // did, stalled every call on a resident daemon for a full ~30s emission cycle.
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

  const coinPublicKey = (state as any).shielded.coinPublicKey.toHexString() as string;
  const encPublicKey = (state as any).shielded.encryptionPublicKey.toHexString() as string;

  const {midnightJs, contractName, compiledContract, providers} = await openContract({
    artifactPath,
    projectDir,
    network,
    facade,
    keystore,
    coinPublicKey,
    encryptionPublicKey: encPublicKey,
    witnesses,
  });

  // Normalize user-supplied args into a positional argument array, matching the
  // convention used by `deploy` (see toPositionalArgs):
  //   - a JSON array is spread into positional circuit arguments
  //   - a single object/scalar becomes one argument
  //   - the "no args" sentinels that both the CLI and daemon pass when the user
  //     supplied nothing ({} / undefined) collapse to [], and an explicit empty
  //     array [] stays empty — so circuits like `issue_credential(context)` that
  //     take no user args aren't sent a spurious argument ("expected 1 argument,
  //     received 2").

  // findDeployedContract stores initialPrivateState at privateStateId before returning callTx,
  // so a contract moth did not deploy itself still finds a private state when its circuit runs.
  const deployed = await (midnightJs.contracts.findDeployedContract as any)(providers, {
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

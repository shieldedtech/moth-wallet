// Contract deployment using the official Midnight SDK provider chain.
// Follows mn-tui's deployManagedContract pattern. See NOTICE for attribution.

import {resolve as resolvePath} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import * as Rx from 'rxjs';
import {createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {MidnightBech32m, UnshieldedAddress} from '@midnightntwrk/wallet-sdk/address-format';

import type {TransactionResult} from '../types/transaction.js';
import {resolveProverConfig, type NetworkConfig} from '../types/network.js';
import {ensureProverReady} from '../proof/provider.js';
import type {ContractArtifact} from './artifact-loader.js';
import {WalletError, TimeoutError} from '../types/errors.js';
import type {SyncedWallet} from '../sync/wallet-sync.js';
import type {WalletKeys} from '../sync/operations.js';
import {unshieldedSecretOf} from './wallet-provider.js';
import {openContract} from './midnight-js.js';

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

  // The unshielded signing secret: the pre-derived walletKeys (daemon path), else
  // derived from seedHex (in-process CLI path). D-KM-3.
  const keystore = createKeystore({kind: 'schnorr', secret: unshieldedSecretOf(walletKeys, seedHex, 'deployContract')}, network.id);

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

  // Witnesses, from the witness file when one is given. It may export them as:
  //   1. export default (walletProvider) => ({ localSecretKey: ... })  — factory function
  //   2. export default { localSecretKey: ... }                       — plain object
  //   3. export const witnesses = { localSecretKey: ... }             — named export
  let witnesses: object | ((walletProvider: unknown) => object) | undefined;
  if (witnessPath) {
    const witMod: any = await import(pathToFileURL(witnessPath).href);
    if (witMod.default && (typeof witMod.default === 'function' || typeof witMod.default === 'object')) {
      witnesses = witMod.default;
    } else if (witMod.witnesses && typeof witMod.witnesses === 'object') {
      witnesses = witMod.witnesses;
    } else {
      throw new WalletError(
        'INVALID_INPUT',
        'Witness file must export default (function or object) or a named "witnesses" export'
      );
    }
  }

  const {midnightJs, contractName, compiledContract, providers} = await openContract({
    artifactPath: artifact.path,
    projectDir,
    network,
    facade,
    keystore,
    coinPublicKey,
    encryptionPublicKey: encPublicKey,
    witnesses,
  });

  // A project with onchain-runtime-v3 but no midnight-js deploys through moth's copy, whose
  // WASM objects its contract module refuses (CWE-706); the setter re-reads them through the
  // project's runtime and passes objects from the same tree through unchanged.
  const projRoot = projectDir?.trim() || resolvePath(artifact.path, '..', '..');
  const projRequire = createRequire(resolvePath(projRoot, 'node_modules', '_virtual.js'));
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
    const deployed: any = await (midnightJs.contracts.deployContract as any)(providers, deployOptions);

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

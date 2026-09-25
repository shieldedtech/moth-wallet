import * as ledger from '@midnight-ntwrk/ledger-v8';
import {httpClientProvingProvider, httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {ZKConfigProvider, type KeyMaterialProvider} from '@midnight-ntwrk/midnight-js/types';
import {
  provingProvider as wasmProvingProvider,
  type KeyMaterialProvider as WasmKeyMaterialProvider,
} from '@midnight-ntwrk/zkir-v2';
import {ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import {
  fromV8ProvingProvider,
  fromV9ProvingProvider,
  makeDefaultVersionedProvingService,
  makeVersionedProvingServiceEffect,
  wrapVersionedEffectService,
  type AnyVersionUnboundTransaction,
  type AnyVersionUnprovenTransaction,
  type ProvingServiceEffect,
  type VersionedProvingService,
} from '@midnightntwrk/wallet-sdk/capabilities/proving';
import {WasmProver} from '@midnightntwrk/wallet-sdk/prover-client/effect';
import {ProofClient} from './client.js';
import type {ProverConfig} from '../types/network.js';

/** The facade's proving service: routes each transaction to the backend for the ledger version that authored it. */
export type WalletProvingService = VersionedProvingService<AnyVersionUnboundTransaction, AnyVersionUnprovenTransaction>;

/** Adapter from the connector/Midnight.js key interface to ZKConfigProvider. */
class KeyMaterialZkConfigProvider extends ZKConfigProvider<string> {
  constructor(private readonly source: KeyMaterialProvider) {
    super();
  }

  getZKIR(circuitId: string) {
    return this.source.getZKIR(circuitId) as ReturnType<ZKConfigProvider<string>['getZKIR']>;
  }

  getProverKey(circuitId: string) {
    return this.source.getProverKey(circuitId) as ReturnType<ZKConfigProvider<string>['getProverKey']>;
  }

  getVerifierKey(circuitId: string) {
    return this.source.getVerifierKey(circuitId) as ReturnType<ZKConfigProvider<string>['getVerifierKey']>;
  }
}

let defaultWasmKeys: WasmKeyMaterialProvider | undefined;

function defaultWasmKeyMaterialProvider(): WasmKeyMaterialProvider {
  return (defaultWasmKeys ??= WasmProver.makeDefaultKeyMaterialProvider());
}

function wasmKeyMaterialProvider(source: KeyMaterialProvider): WasmKeyMaterialProvider {
  const defaults = defaultWasmKeyMaterialProvider();
  return {
    async lookupKey(keyLocation) {
      // Native wallet circuits come from the SDK-maintained key source. Contract
      // circuits fall through to the dApp/artifact provider supplied by callers.
      const builtIn = await defaults.lookupKey(keyLocation);
      if (builtIn) return builtIn;
      const [ir, proverKey, verifierKey] = await Promise.all([
        source.getZKIR(keyLocation),
        source.getProverKey(keyLocation),
        source.getVerifierKey(keyLocation),
      ]);
      return {ir, proverKey, verifierKey};
    },
    getParams: (k) => defaults.getParams(k),
  };
}

/** Build the low-level provider used by contracts and the dApp connector. */
export function createProvingProvider(
  config: ProverConfig,
  keyMaterialProvider: KeyMaterialProvider,
): ledger.ProvingProvider {
  if (config.type === 'server') {
    return httpClientProvingProvider(config.url, new KeyMaterialZkConfigProvider(keyMaterialProvider));
  }
  return wasmProvingProvider(wasmKeyMaterialProvider(keyMaterialProvider));
}

/** Build the transaction-level Midnight.js proof provider. */
export function createProofProvider(
  config: ProverConfig,
  keyMaterialProvider: KeyMaterialProvider,
) {
  if (config.type === 'server') {
    // Delegate to the SDK's proof provider rather than re-implementing
    // proveTx. This keeps payload versioning (ledger-v8 8.1.0 rejects
    // unversioned circuit-call proofs) and any future proveTx behavior —
    // e.g. partialProveTxConfig — tracking the SDK instead of drifting from
    // a hand-rolled copy of the same call.
    return httpClientProofProvider(config.url, new KeyMaterialZkConfigProvider(keyMaterialProvider));
  }
  // WASM path: no SDK proof-provider equivalent, so drive prove() directly
  // over the local zkir provider.
  const provingProvider = createProvingProvider(config, keyMaterialProvider);
  return {
    proveTx: (transaction: ledger.UnprovenTransaction) =>
      transaction.prove(provingProvider, ledger.CostModel.initialCostModel()),
  };
}

type EitherLike<R> = {readonly _tag: 'Left'; readonly left: unknown} | {readonly _tag: 'Right'; readonly right: R};

/** The SDK reports a configuration it cannot honour as an Either; here that is a thrown error. */
function orThrow<R>(either: EitherLike<R>): R {
  if (either._tag === 'Left') {
    throw either.left instanceof Error ? either.left : new Error(String((either.left as {message?: string})?.message ?? either.left));
  }
  return either.right;
}

/**
 * Build the wallet facade's proving service, with a backend per ledger version.
 * A transaction is proved by the backend for the ledger version that authored
 * its bytes, and the boundary between the two is the chain's fork schedule.
 */
export function createWalletProvingService(config: ProverConfig, forks: ProtocolVersion.ForkSchedule): WalletProvingService {
  if (config.type === 'server') {
    // One proof server under every key: the SDK drives it with each ledger
    // version on its own side of the fork.
    return orThrow(makeDefaultVersionedProvingService({provingServerUrl: new URL(config.url)}, forks));
  }

  // The SDK's in-process prover works on bytes and serves both ledger versions
  // with the same published circuits. It spawns the package's proof-worker.js,
  // which Node resolves from node_modules.
  if (typeof process !== 'undefined' && process.versions?.node) {
    return orThrow(makeDefaultVersionedProvingService({provers: {v8: {kind: 'wasm'}, v9: {kind: 'wasm'}}}, forks));
  }

  // Browser bundles do not emit the SDK's dependency-internal proof-worker.js.
  // Moth already runs the wallet host in its own dedicated Worker, so the same
  // ZKIR WASM provider executes there directly, framed by each ledger version
  // on its own side of the fork.
  const keyMaterial = defaultWasmKeyMaterialProvider();
  const provider = wasmProvingProvider(keyMaterial);
  type AnyVersionProvingService = ProvingServiceEffect<AnyVersionUnboundTransaction, AnyVersionUnprovenTransaction>;
  const services = orThrow(
    ProtocolVersion.makeRegistryFromActivations<AnyVersionProvingService>([
      {sinceVersion: ProtocolVersion.MinSupportedVersion, value: fromV8ProvingProvider(provider)},
      {
        sinceVersion: forks.v9,
        value: fromV9ProvingProvider({...provider, lookupKey: (keyLocation) => keyMaterial.lookupKey(keyLocation)}),
      },
    ]),
  );
  return wrapVersionedEffectService(makeVersionedProvingServiceEffect(services));
}

/** Proof servers need a preflight; local WASM proving has no remote health check. */
export async function ensureProverReady(config: ProverConfig): Promise<void> {
  if (config.type === 'server') await new ProofClient(config.url).ensureReady();
}

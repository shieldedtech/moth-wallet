import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {ledger as activeLedger} from '../ledger/index.js';
import {httpClientProvingProvider, httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {ZKConfigProvider, type KeyMaterialProvider} from '@midnight-ntwrk/midnight-js/types';
import {
  provingProvider as wasmProvingProvider,
  type KeyMaterialProvider as WasmKeyMaterialProvider,
} from '@midnight-ntwrk/zkir-v2';
import {sdk} from '../sdk/index.js';
import {ProofClient} from './client.js';
import type {ProverConfig} from '../types/network.js';

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
  return (defaultWasmKeys ??= sdk().proverClient.WasmProver.makeDefaultKeyMaterialProvider());
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
      transaction.prove(provingProvider, activeLedger().CostModel.initialCostModel()),
  };
}

/** Build the wallet facade service. WASM follows the SDK's documented setup. */
export function createWalletProvingService(config: ProverConfig) {
  if (config.type === 'server') {
    return sdk().proving.makeServerProvingService({provingServerUrl: new URL(config.url)});
  }

  // This is the SDK-documented path and works in Node, where the package's
  // proof-worker.js is addressable from node_modules.
  if (typeof process !== 'undefined' && process.versions?.node) {
    return sdk().proving.makeWasmProvingService();
  }

  // Browser bundles do not emit the SDK's dependency-internal proof-worker.js.
  // Moth already runs the wallet host in its own dedicated Worker, so execute
  // the same ZKIR WASM provider there directly instead of nesting a missing
  // worker asset.
  const provider = wasmProvingProvider(defaultWasmKeyMaterialProvider());
  return {
    prove: (transaction: ledger.UnprovenTransaction) =>
      transaction.prove(provider, activeLedger().CostModel.initialCostModel()),
  };
}

/** Proof servers need a preflight; local WASM proving has no remote health check. */
export async function ensureProverReady(config: ProverConfig): Promise<void> {
  if (config.type === 'server') await new ProofClient(config.url).ensureReady();
}

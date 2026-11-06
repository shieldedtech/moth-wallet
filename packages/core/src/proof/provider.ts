import * as ledger from '@midnightntwrk/ledger-v8';
import {httpClientProvingProvider, httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {
  createProofProviderFromProvingProviders,
  ZKConfigProvider,
  type KeyMaterialProvider,
  type ProofProvider,
} from '@midnight-ntwrk/midnight-js/types';
import {
  provingProvider as wasmProvingProvider,
  type KeyMaterialProvider as WasmKeyMaterialProvider,
} from '@midnightntwrk/zkir-v2';
import {ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import {
  fromV8ProvingProvider,
  fromV9ProvingProvider,
  makeDefaultVersionedProvingService,
  makeVersionedProvingServiceEffect,
  ProvingEpochMismatchError,
  wrapVersionedEffectService,
  type AnyVersionUnboundTransaction,
  type AnyVersionUnprovenTransaction,
  type ProvingServiceEffect,
  type V8UnprovenTransaction,
  type V9UnprovenTransaction,
  type VersionedProvingService,
  type VersionProvingServiceEffect,
} from '@midnightntwrk/wallet-sdk/capabilities/proving';
import {Effect} from 'effect';
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

export type {WasmKeyMaterialProvider};

/**
 * Builds the local (WASM) prover over a key-material source. Injectable because the
 * ledger requests a transaction's proofs concurrently while zkir's in-thread prover
 * serialises them; a host with spare threads (the extension) installs a parallel one.
 */
export type WasmProvingProviderFactory = (keyMaterial: WasmKeyMaterialProvider) => ledger.ProvingProvider;

let wasmProvingFactory: WasmProvingProviderFactory = wasmProvingProvider;

/** Replace the local prover for this process; `null` restores zkir's default. */
export function setWasmProvingProviderFactory(factory: WasmProvingProviderFactory | null): void {
  wasmProvingFactory = factory ?? wasmProvingProvider;
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
  return wasmProvingFactory(wasmKeyMaterialProvider(keyMaterialProvider));
}

/**
 * The midnight-js pieces a contract proof provider is built from. midnight-js
 * takes a transaction handle only from its own installed copy, so a contract
 * that runs on its project's midnight-js is proved with that copy's.
 */
export interface ProofProviderKit {
  readonly httpClientProofProvider: typeof httpClientProofProvider;
  readonly createProofProviderFromProvingProviders: typeof createProofProviderFromProvingProviders;
}

const ownProofProviderKit: ProofProviderKit = {httpClientProofProvider, createProofProviderFromProvingProviders};

/**
 * Build the Midnight.js proof provider for contracts of both ledger eras. The in-process
 * prover is zkir-v2's, which reads the ZKIR v2 circuits of compactc 0.31 contracts only.
 */
export function createProofProvider(
  config: ProverConfig,
  zkConfigProvider: ZKConfigProvider<string>,
  kit: ProofProviderKit = ownProofProviderKit,
): ProofProvider {
  if (config.type === 'server') {
    return kit.httpClientProofProvider({url: config.url, zkConfigProvider});
  }
  const keyMaterial = wasmKeyMaterialProvider(zkConfigProvider.asKeyMaterialProvider());
  const provider = wasmProvingFactory(keyMaterial);
  return kit.createProofProviderFromProvingProviders({
    v8: provider,
    // Delegated, not spread: zkir's default provider is a wasm-bindgen class
    // whose check/prove live on its prototype.
    v9: {
      check: (preimage, keyLocation) => provider.check(preimage, keyLocation),
      prove: (preimage, keyLocation, overwriteBindingInput) => provider.prove(preimage, keyLocation, overwriteBindingInput),
      lookupKey: (keyLocation) => keyMaterial.lookupKey(keyLocation),
    },
  });
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

  // Browser bundles do not emit the SDK's proof-worker.js, so prove through the
  // installed factory instead (the extension plugs its proof-worker pool in there),
  // framed by each ledger version on its own side of the fork.
  const keyMaterial = defaultWasmKeyMaterialProvider();
  const provider = wasmProvingFactory(keyMaterial);
  const v8Epoch = ProtocolVersion.epochOf(ProtocolVersion.MinSupportedVersion, forks.v9);
  const v9Epoch = ProtocolVersion.epochOf(forks.v9, forks.v9);
  const services = orThrow(
    ProtocolVersion.makeRegistry<VersionProvingServiceEffect>([
      // A chain born on ledger-v9 has no ledger-v8 epoch to register.
      ...(forks.v9 > ProtocolVersion.MinSupportedVersion
        ? [{range: v8Epoch, value: onlyFrom(fromV8ProvingProvider(provider), isV8Transaction, v8Epoch)}]
        : []),
      {
        range: v9Epoch,
        value: onlyFrom(
          // Delegated, not spread: zkir's default provider is a wasm-bindgen class
          // whose check/prove live on its prototype.
          fromV9ProvingProvider({
            check: (preimage, keyLocation) => provider.check(preimage, keyLocation),
            prove: (preimage, keyLocation, overwriteBindingInput) =>
              provider.prove(preimage, keyLocation, overwriteBindingInput),
            lookupKey: (keyLocation) => keyMaterial.lookupKey(keyLocation),
          }),
          isV9Transaction,
          v9Epoch,
        ),
      },
    ]),
  );
  return wrapVersionedEffectService(makeVersionedProvingServiceEffect(services));
}

const isV8Transaction = (transaction: AnyVersionUnprovenTransaction): transaction is V8UnprovenTransaction =>
  transaction instanceof ledger.Transaction;

const isV9Transaction = (transaction: AnyVersionUnprovenTransaction): transaction is V9UnprovenTransaction =>
  transaction instanceof ledgerV9.Transaction;

/**
 * Admits only its own ledger version's transactions, as the SDK's registry entries
 * do: one whose stamp and bytes disagree is refused, never handed to a ledger that
 * cannot read it.
 */
function onlyFrom<TProven extends AnyVersionUnboundTransaction, TUnproven extends AnyVersionUnprovenTransaction>(
  service: ProvingServiceEffect<TProven, TUnproven>,
  isOwn: (transaction: AnyVersionUnprovenTransaction) => transaction is TUnproven,
  epoch: ProtocolVersion.ProtocolVersion.Range,
): VersionProvingServiceEffect {
  return {
    prove: (transaction) =>
      isOwn(transaction)
        ? service.prove(transaction)
        : Effect.fail(
            new ProvingEpochMismatchError({
              message: `The proving backend registered for protocol versions [${epoch[0]}, ${epoch[1]}) was handed a transaction built by the other ledger version.`,
              epoch,
            }),
          ),
  };
}

/** Proof servers need a preflight; local WASM proving has no remote health check. */
export async function ensureProverReady(config: ProverConfig): Promise<void> {
  if (config.type === 'server') await new ProofClient(config.url).ensureReady();
}

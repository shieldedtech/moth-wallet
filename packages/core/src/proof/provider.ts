import * as ledger from '@midnightntwrk/ledger-v8';
import {httpClientProvingProvider, httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {
  createProofProviderFromProvingProviders,
  parseContractKeyLocation,
  ZKConfigProvider,
  ZKConfigRegistry,
  type KeyMaterialProvider,
  type ProofProvider,
} from '@midnight-ntwrk/midnight-js/types';
import {
  provingProvider as zkirV2ProvingProvider,
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
 * The ZKIR version a circuit is written in, which picks the zkir package that proves it:
 * compactc 0.31 and the SDK's own circuits emit ZKIR v2, compactc 0.36 emits ZKIR v3.
 */
export type ZkirVersion = 'v2' | 'v3';

// The serialization header zkir-v3 requires of a circuit's IR. zkir-v2 accepts only
// `ir-source[v2]` and `ir-source[v2-generic]`, so the header alone names the reader.
const ZKIR_V3_HEADER = new TextEncoder().encode('midnight:ir-source[v3-generic]:');

/** The ZKIR version of a circuit's binary IR (`.bzkir`), read from its header. */
export function zkirVersionOf(ir: Uint8Array): ZkirVersion {
  return ir.length >= ZKIR_V3_HEADER.length && ZKIR_V3_HEADER.every((byte, i) => ir[i] === byte) ? 'v3' : 'v2';
}

/**
 * Builds the local (WASM) prover for one ZKIR version over a key-material source. Injectable
 * because the ledger requests a transaction's proofs concurrently while zkir's in-thread
 * prover serialises them; a host with spare threads (the extension) installs a parallel one.
 */
export type WasmProvingProviderFactory = (keyMaterial: WasmKeyMaterialProvider, zkir: ZkirVersion) => ledger.ProvingProvider;

// zkir-v3 instantiates its WASM on import, so a process that never proves a ZKIR v3
// circuit never loads it.
let zkirV3: Promise<typeof import('@midnightntwrk/zkir-v3')> | undefined;

const zkirProvingProvider: WasmProvingProviderFactory = (keyMaterial, zkir) => {
  if (zkir === 'v2') return zkirV2ProvingProvider(keyMaterial);
  const provider = (zkirV3 ??= import('@midnightntwrk/zkir-v3')).then((module) => module.provingProvider(keyMaterial));
  return {
    check: async (preimage, keyLocation) => (await provider).check(preimage, keyLocation),
    prove: async (preimage, keyLocation, overwriteBindingInput) =>
      (await provider).prove(preimage, keyLocation, overwriteBindingInput),
  };
};

let wasmProvingFactory: WasmProvingProviderFactory = zkirProvingProvider;

/** Replace the local prover for this process; `null` restores zkir's default. */
export function setWasmProvingProviderFactory(factory: WasmProvingProviderFactory | null): void {
  wasmProvingFactory = factory ?? zkirProvingProvider;
}

let defaultWasmKeys: WasmKeyMaterialProvider | undefined;

function defaultWasmKeyMaterialProvider(): WasmKeyMaterialProvider {
  return (defaultWasmKeys ??= WasmProver.makeDefaultKeyMaterialProvider());
}

type ProvingKeyMaterial = NonNullable<Awaited<ReturnType<WasmKeyMaterialProvider['lookupKey']>>>;

/** Where a local prover reads a contract circuit's keys, by the key location the ledger names it with. */
interface ContractKeys {
  lookup(keyLocation: string): Promise<ProvingKeyMaterial>;
  /** The circuit's IR alone: a contract's prover key runs to tens of MB, and zkir reads it once itself. */
  ir(keyLocation: string): Promise<Uint8Array>;
}

function keysFrom(source: KeyMaterialProvider): ContractKeys {
  return {
    async lookup(keyLocation) {
      const [ir, proverKey, verifierKey] = await Promise.all([
        source.getZKIR(keyLocation),
        source.getProverKey(keyLocation),
        source.getVerifierKey(keyLocation),
      ]);
      return {ir, proverKey, verifierKey};
    },
    ir: (keyLocation) => source.getZKIR(keyLocation),
  };
}

/** A key source for zkir that can also name the ZKIR version of a circuit without reading its keys. */
interface CircuitKeySource extends WasmKeyMaterialProvider {
  zkirVersion(keyLocation: string): Promise<ZkirVersion>;
}

function wasmKeyMaterialProvider(contract: ContractKeys): CircuitKeySource {
  const defaults = defaultWasmKeyMaterialProvider();
  return {
    // Native wallet circuits come from the SDK-maintained key source. Contract
    // circuits fall through to the dApp/artifact keys supplied by callers.
    lookupKey: async (keyLocation) => (await defaults.lookupKey(keyLocation)) ?? contract.lookup(keyLocation),
    getParams: (k) => defaults.getParams(k),
    async zkirVersion(keyLocation) {
      const builtIn = await defaults.lookupKey(keyLocation);
      return zkirVersionOf(builtIn ? builtIn.ir : await contract.ir(keyLocation));
    },
  };
}

/**
 * A local prover that hands each circuit to the zkir for its IR's version. The circuit, not the
 * transaction, decides: a ledger-8 contract called after the fork puts ZKIR v2 circuits in a
 * ledger-9 transaction.
 */
function zkirDispatchingProvider(keys: CircuitKeySource): ledger.ProvingProvider & Pick<CircuitKeySource, 'lookupKey'> {
  const provers = new Map<ZkirVersion, ledger.ProvingProvider>();
  const proverFor = async (keyLocation: string) => {
    const zkir = await keys.zkirVersion(keyLocation);
    let prover = provers.get(zkir);
    if (!prover) provers.set(zkir, (prover = wasmProvingFactory(keys, zkir)));
    return prover;
  };
  return {
    check: async (preimage, keyLocation) => (await proverFor(keyLocation)).check(preimage, keyLocation),
    prove: async (preimage, keyLocation, overwriteBindingInput) =>
      (await proverFor(keyLocation)).prove(preimage, keyLocation, overwriteBindingInput),
    lookupKey: (keyLocation) => keys.lookupKey(keyLocation),
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
  return zkirDispatchingProvider(wasmKeyMaterialProvider(keysFrom(keyMaterialProvider)));
}

/**
 * The midnight-js pieces a contract proof provider is built from. midnight-js
 * takes a transaction handle only from its own installed copy, so a contract
 * that runs on its project's midnight-js is proved with that copy's.
 */
export interface ProofProviderKit {
  readonly httpClientProofProvider: typeof httpClientProofProvider;
  readonly createProofProviderFromProvingProviders: typeof createProofProviderFromProvingProviders;
  readonly ZKConfigRegistry: typeof ZKConfigRegistry;
  readonly parseContractKeyLocation: typeof parseContractKeyLocation;
}

const ownProofProviderKit: ProofProviderKit = {
  httpClientProofProvider,
  createProofProviderFromProvingProviders,
  ZKConfigRegistry,
  parseContractKeyLocation,
};

/**
 * A contract's keys under the locations the ledger names them with. midnight-js 5 names a call's
 * circuit `contract:<address>/<circuit>?vk=<hash>` in both eras, which resolves through its
 * verifier-key join as its proof-server client does; a bare circuit name is read as it stands.
 */
function keysFromZkConfig(zkConfigProvider: ZKConfigProvider<string>, kit: ProofProviderKit): ContractKeys {
  const registry = new kit.ZKConfigRegistry([zkConfigProvider]);
  const bare = keysFrom(zkConfigProvider.asKeyMaterialProvider());
  return {
    async lookup(keyLocation) {
      const config = await registry.resolveKeyLocation(keyLocation);
      return config ? {ir: config.zkir, proverKey: config.proverKey, verifierKey: config.verifierKey} : bare.lookup(keyLocation);
    },
    ir: (keyLocation) => bare.ir(kit.parseContractKeyLocation(keyLocation)?.circuitId ?? keyLocation),
  };
}

/**
 * Build the Midnight.js proof provider for contracts of both ledger eras. In process, each
 * circuit is proved by the zkir for its IR: zkir-v2 for compactc 0.31, zkir-v3 for compactc 0.36.
 */
export function createProofProvider(
  config: ProverConfig,
  zkConfigProvider: ZKConfigProvider<string>,
  kit: ProofProviderKit = ownProofProviderKit,
): ProofProvider {
  if (config.type === 'server') {
    return kit.httpClientProofProvider({url: config.url, zkConfigProvider});
  }
  const provider = zkirDispatchingProvider(wasmKeyMaterialProvider(keysFromZkConfig(zkConfigProvider, kit)));
  return kit.createProofProviderFromProvingProviders({v8: provider, v9: provider});
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
  // framed by each ledger version on its own side of the fork. The SDK publishes
  // its circuits as ZKIR v2 for both ledger versions.
  const keyMaterial = defaultWasmKeyMaterialProvider();
  const provider = wasmProvingFactory(keyMaterial, 'v2');
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

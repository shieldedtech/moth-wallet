// The midnight-js copy, contract and providers one contract operation runs with.
//
// midnight-js 5 accepts a transaction handle only from the copy that made it, and a
// compiled contract checks runtime objects against the compact-runtime its module
// imports, so an operation takes everything from one tree: the contract project's when
// it has midnight-js, else moth's. The artifact's runtime version picks the era: 0.16
// (compactc 0.31) is a ledger-8 instance, 0.21 (compactc 0.36.0) a ledger-9
// CompiledContract.

import {createRequire} from 'node:module';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {basename, join, resolve as resolvePath} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import type {UnshieldedKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {mothHome} from '../storage/home.js';
import {WalletError} from '../types/errors.js';
import {resolveProverConfig, type NetworkConfig} from '../types/network.js';
import {createProofProvider} from '../proof/provider.js';
import {makeContractWalletProviders} from './wallet-provider.js';

type Contracts = typeof import('@midnight-ntwrk/midnight-js/contracts');
type Types = typeof import('@midnight-ntwrk/midnight-js/types');
type ProtocolV9 = typeof import('@midnight-ntwrk/midnight-js/protocol/v9');
type NodeZkConfig = typeof import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
type IndexerProvider = typeof import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
type LevelProvider = typeof import('@midnight-ntwrk/midnight-js-level-private-state-provider');
type HttpProofProvider = typeof import('@midnight-ntwrk/midnight-js-http-client-proof-provider');

/** midnight-js, as one installed copy. */
export interface MidnightJs {
  /** Where the copy was found: the contract project, or `undefined` for moth's own. */
  readonly projectRoot: string | undefined;
  readonly version: string;
  readonly contracts: Contracts;
  readonly types: Types;
  readonly CompiledContract: ProtocolV9['CompiledContract'];
  readonly NodeZkConfigProvider: NodeZkConfig['NodeZkConfigProvider'];
  readonly indexerPublicDataProvider: IndexerProvider['indexerPublicDataProvider'];
  readonly levelPrivateStateProvider: LevelProvider['levelPrivateStateProvider'];
  readonly httpClientProofProvider: HttpProofProvider['httpClientProofProvider'];
}

/** The provider packages a contract operation needs besides the barrel, all from one copy. */
const PROVIDER_PACKAGES = [
  '@midnight-ntwrk/midnight-js-node-zk-config-provider',
  '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
  '@midnight-ntwrk/midnight-js-level-private-state-provider',
  '@midnight-ntwrk/midnight-js-http-client-proof-provider',
] as const;

const BARREL_MANIFEST = '@midnight-ntwrk/midnight-js/package.json';

function assemble(
  projectRoot: string | undefined,
  version: string,
  [contracts, types, protocol, zkConfig, indexer, level, proof]: [
    Contracts,
    Types,
    ProtocolV9,
    NodeZkConfig,
    IndexerProvider,
    LevelProvider,
    HttpProofProvider,
  ],
): MidnightJs {
  return {
    projectRoot,
    version,
    contracts,
    types,
    CompiledContract: protocol.CompiledContract,
    NodeZkConfigProvider: zkConfig.NodeZkConfigProvider,
    indexerPublicDataProvider: indexer.indexerPublicDataProvider,
    levelPrivateStateProvider: level.levelPrivateStateProvider,
    httpClientProofProvider: proof.httpClientProofProvider,
  };
}

const ownRequire = createRequire(import.meta.url);

async function ownMidnightJs(): Promise<MidnightJs> {
  const {version} = JSON.parse(readFileSync(ownRequire.resolve(BARREL_MANIFEST), 'utf8')) as {version: string};
  return assemble(
    undefined,
    version,
    await Promise.all([
      import('@midnight-ntwrk/midnight-js/contracts'),
      import('@midnight-ntwrk/midnight-js/types'),
      import('@midnight-ntwrk/midnight-js/protocol/v9'),
      import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
      import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
      import('@midnight-ntwrk/midnight-js-level-private-state-provider'),
      import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
    ]),
  );
}

/**
 * The midnight-js a contract under `projectRoot` runs on: the project's own copy
 * when it has one, else moth's. A project copy must be 5.x and carry the
 * provider packages too, since a provider from another copy makes handles the
 * project's copy refuses.
 */
export async function loadMidnightJs(projectRoot: string): Promise<MidnightJs> {
  const projectRequire = createRequire(join(projectRoot, 'node_modules', '_virtual.js'));
  let manifest: string;
  try {
    manifest = realpathSync(projectRequire.resolve(BARREL_MANIFEST));
  } catch {
    return ownMidnightJs();
  }
  if (manifest === realpathSync(ownRequire.resolve(BARREL_MANIFEST))) return ownMidnightJs();

  const {version} = JSON.parse(readFileSync(manifest, 'utf8')) as {version: string};
  if (!version.startsWith('5.')) {
    throw new WalletError(
      'INVALID_INPUT',
      `The contract project at ${projectRoot} has @midnight-ntwrk/midnight-js ${version}, and moth runs ` +
        `contracts with midnight-js 5. Upgrade the project to midnight-js 5.0.0.`,
    );
  }
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const spec of PROVIDER_PACKAGES) {
    try {
      resolved.set(spec, projectRequire.resolve(spec));
    } catch {
      missing.push(spec);
    }
  }
  if (missing.length > 0) {
    throw new WalletError(
      'INVALID_INPUT',
      `The contract project at ${projectRoot} has midnight-js ${version} but not ${missing.join(', ')}. ` +
        `Contract operations take every midnight-js provider from the project's copy; add them at ${version}.`,
    );
  }
  const load = (path: string) => import(pathToFileURL(path).href);
  return assemble(
    projectRoot,
    version,
    (await Promise.all([
      load(projectRequire.resolve('@midnight-ntwrk/midnight-js/contracts')),
      load(projectRequire.resolve('@midnight-ntwrk/midnight-js/types')),
      load(projectRequire.resolve('@midnight-ntwrk/midnight-js/protocol/v9')),
      ...PROVIDER_PACKAGES.map((spec) => load(resolved.get(spec)!)),
    ])) as Parameters<typeof assemble>[2],
  );
}

/** The ledger era a contract runs on. */
export type ContractEra = 'v8' | 'v9';

/** The era midnight-js places a contract on, by the compact-runtime version its artifacts declare. */
export function contractEraOf(runtimeVersion: string): ContractEra {
  if (runtimeVersion.startsWith('0.16.')) return 'v8';
  if (runtimeVersion.startsWith('0.21.')) return 'v9';
  throw new WalletError(
    'INVALID_INPUT',
    `The contract was compiled for compact-runtime ${runtimeVersion}. midnight-js 5 runs contracts compiled ` +
      `for runtime 0.16 (compactc 0.31, ledger 8) or 0.21 (compactc 0.36.0, ledger 9); recompile it with one of those.`,
  );
}

export interface OpenContractOptions {
  /** The `managed/<contract>` directory compactc wrote. */
  artifactPath: string;
  /** The contract's project, whose node_modules may hold its own midnight-js. Defaults to two levels above the artifact. */
  projectDir?: string;
  network: NetworkConfig;
  facade: WalletFacade;
  keystore: UnshieldedKeystore;
  coinPublicKey: string;
  encryptionPublicKey: string;
  /** The contract's witnesses, or a factory of them that takes the wallet provider. Omitted: it has none. */
  witnesses?: object | ((walletProvider: unknown) => object);
}

export interface ContractSession {
  readonly midnightJs: MidnightJs;
  readonly era: ContractEra;
  readonly contractName: string;
  /** What midnight-js takes as `compiledContract` for this era. */
  readonly compiledContract: any;
  /** The provider set, including `config`, every provider from `midnightJs`. */
  readonly providers: any;
}

/** Load a compiled contract and build the providers one operation on it runs with. */
export async function openContract(options: OpenContractOptions): Promise<ContractSession> {
  const {artifactPath: managedDir, network, facade, keystore, coinPublicKey, encryptionPublicKey} = options;
  const midnightJs = await loadMidnightJs(options.projectDir?.trim() || resolvePath(managedDir, '..', '..'));

  // compactc 0.31 writes no integrity manifest, so a bundle without one is
  // accepted; a manifest that is there must still cover every artifact.
  const zkConfigProvider = new midnightJs.NodeZkConfigProvider(managedDir, {verify: 'require-if-present'});
  const era = contractEraOf(await zkConfigProvider.getArtifactRuntimeVersion());
  const prover = resolveProverConfig(network);
  if (era === 'v9' && prover.type === 'wasm') {
    throw new WalletError(
      'INVALID_INPUT',
      'This contract is compiled for ledger 9 (compactc 0.36), whose circuits are ZKIR v3, and the in-process ' +
        'prover reads ZKIR v2 only. Prove it with a proof server (9.0.0 or later).',
    );
  }

  const contractName = basename(managedDir);
  const contractJs = join(managedDir, 'contract', 'index.js');
  if (!existsSync(contractJs)) {
    throw new WalletError('INVALID_INPUT', `No compiled contract at ${contractJs}`);
  }
  const contractModule: any = await import(pathToFileURL(contractJs).href);

  const {walletProvider, midnightProvider} = makeContractWalletProviders({
    facade,
    keystore,
    coinPublicKey,
    encryptionPublicKey,
    factories: midnightJs.types,
  });
  const unshieldedAddress = String(keystore.getBech32Address());
  const providers = {
    privateStateProvider: midnightJs.levelPrivateStateProvider({
      midnightDbName: join(mothHome(), 'level-db', network.id, encryptionPublicKey.slice(0, 16)),
      privateStateStoreName: contractName + '-state',
      privateStoragePasswordProvider: () => unshieldedAddress,
      accountId: unshieldedAddress,
    }),
    publicDataProvider: midnightJs.indexerPublicDataProvider({
      queryURL: network.indexerUrl,
      subscriptionURL: network.indexerUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws',
    }),
    zkConfigProvider,
    proofProvider: createProofProvider(prover, zkConfigProvider, {
      httpClientProofProvider: midnightJs.httpClientProofProvider,
      createProofProviderFromProvingProviders: midnightJs.types.createProofProviderFromProvingProviders,
    }),
    walletProvider,
    midnightProvider,
    // One hour, as midnight-js's own testkit configures it.
    config: {networkId: network.id, ttlSeconds: 3600},
  };

  const witnesses = typeof options.witnesses === 'function' ? options.witnesses(walletProvider) : options.witnesses;
  const {CompiledContract} = midnightJs;
  const compiledContract =
    era === 'v8'
      ? new contractModule.Contract(witnesses ?? {})
      : (CompiledContract.make(contractName, contractModule.Contract) as any).pipe(
          witnesses ? (CompiledContract as any).withWitnesses(witnesses) : (CompiledContract as any).withVacantWitnesses,
          (CompiledContract as any).withCompiledFileAssets(managedDir),
        );

  return {midnightJs, era, contractName, compiledContract, providers};
}

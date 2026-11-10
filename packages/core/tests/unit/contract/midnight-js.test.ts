// These pin moth's side of midnight-js 5: which installed copy an operation runs on, the
// era an artifact is placed on, and providers that carry either era's transactions.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createKeystore, type UnshieldedKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {ZswapSecretKeys} from '@midnightntwrk/ledger-v8';
import * as ledgerV8 from '@midnightntwrk/wallet-sdk/ledger/v8';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import {
  assertProvidersSupportEra,
  createMidnightProviderFromHandlers,
  createWalletProviderFromHandlers,
  LedgerTransaction,
  SerializedLedgerParameters,
  SerializedZswapChainState,
  type ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js/types';
import {contractEraOf, loadMidnightJs, openContract} from '../../../src/contract/midnight-js.js';
import {makeContractWalletProviders} from '../../../src/contract/wallet-provider.js';
import {bundledContractBuild} from '../../../src/contract/bundled.js';
import {createProofProvider, setWasmProvingProviderFactory} from '../../../src/proof/provider.js';
import type {NetworkConfig} from '../../../src/types/network.js';
import {WalletError} from '../../../src/types/errors.js';
import {finalizedTransaction, unboundTransaction, unprovenTransaction} from '../../helpers/ledger-transactions.js';

const CORE_PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ERAS = ['v8', 'v9'] as const;
const MOTH_FT_LEDGER8 = bundledContractBuild('moth-ft', 'v8').artifactPath;
const MOTH_FT_LEDGER9 = bundledContractBuild('moth-ft', 'v9').artifactPath;

const network = (prover: NetworkConfig['prover']): NetworkConfig => ({
  id: 'undeployed',
  nodeUrl: 'http://127.0.0.1:9',
  indexerUrl: 'http://127.0.0.1:9/api/v4/graphql',
  proofServerUrl: 'http://127.0.0.1:9',
  prover,
});

/** A facade that records what the providers hand it, and answers with fixed bytes. */
function recordingFacade(finalizedBytes: Uint8Array = new Uint8Array()) {
  const adopted: Array<{bytes: Uint8Array; stage: string}> = [];
  const ttls: Array<Date | undefined> = [];
  const submitted: Uint8Array[] = [];
  const facade = {
    adoptTransaction: (bytes: Uint8Array, stage: string) => {
      adopted.push({bytes, stage});
      return {bytes, stage};
    },
    balanceUnboundTransaction: async (handle: unknown, options: {ttl?: Date}) => {
      ttls.push(options.ttl);
      return handle;
    },
    signRecipe: async (recipe: unknown) => recipe,
    finalizeRecipe: async () => ({serialize: () => finalizedBytes}),
    submitTransaction: async (handle: {bytes: Uint8Array}) => {
      submitted.push(handle.bytes);
      return 'tx-id';
    },
  } as unknown as WalletFacade;
  return {facade, adopted, ttls, submitted};
}

const stubKeystore = {signDataAsync: async () => new Uint8Array()} as unknown as UnshieldedKeystore;

describe('contractEraOf', () => {
  it('places runtime 0.16 artifacts on ledger 8 and runtime 0.21 artifacts on ledger 9', () => {
    expect(contractEraOf('0.16.0')).toBe('v8');
    expect(contractEraOf('0.21.0')).toBe('v9');
  });

  it('refuses a runtime midnight-js 5 does not run, naming the compilers that do', () => {
    expect(() => contractEraOf('0.20.0')).toThrow(/runtime 0\.16 \(compactc 0\.31, ledger 8\) or 0\.21 \(compactc 0\.36\.0, ledger 9\)/);
  });
});

describe('loadMidnightJs', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'moth-midnight-js-'));
  });

  afterAll(async () => {
    await rm(scratch, {recursive: true, force: true});
  });

  async function projectWithBarrel(name: string, version: string): Promise<string> {
    const root = join(scratch, name);
    const barrel = join(root, 'node_modules', '@midnight-ntwrk', 'midnight-js');
    await mkdir(barrel, {recursive: true});
    await writeFile(
      join(barrel, 'package.json'),
      JSON.stringify({name: '@midnight-ntwrk/midnight-js', version, exports: {'./package.json': './package.json'}}),
    );
    return root;
  }

  it("runs on moth's own copy for a project without midnight-js", async () => {
    const root = join(scratch, 'bare');
    await mkdir(root, {recursive: true});
    const midnightJs = await loadMidnightJs(root);
    expect(midnightJs.projectRoot).toBeUndefined();
    expect(midnightJs.version).toMatch(/^5\./);
  });

  it("runs the bundled contracts on moth's own copy", async () => {
    expect((await loadMidnightJs(CORE_PACKAGE_DIR)).projectRoot).toBeUndefined();
  });

  it('refuses a project still on midnight-js 4, whose API moth no longer speaks', async () => {
    const root = await projectWithBarrel('on-4', '4.1.1');
    await expect(loadMidnightJs(root)).rejects.toThrow(WalletError);
    await expect(loadMidnightJs(root)).rejects.toThrow(/midnight-js 4\.1\.1, and moth runs contracts with midnight-js 5/);
  });

  it("refuses a midnight-js 5 project without the provider packages, rather than mixing in moth's", async () => {
    const root = await projectWithBarrel('on-5', '5.0.0');
    await expect(loadMidnightJs(root)).rejects.toThrow(
      /not @midnight-ntwrk\/midnight-js-node-zk-config-provider, .*@midnight-ntwrk\/midnight-js-http-client-proof-provider/,
    );
  });
});

describe('makeContractWalletProviders', () => {
  const factories = {createWalletProviderFromHandlers, createMidnightProviderFromHandlers};

  it('serves both ledger eras', () => {
    const {walletProvider, midnightProvider} = makeContractWalletProviders({
      facade: recordingFacade().facade,
      keystore: stubKeystore,
      coinPublicKey: 'coin',
      encryptionPublicKey: 'enc',
      factories,
    });
    expect(walletProvider.supportedEras).toEqual(['v8', 'v9']);
    expect(midnightProvider.supportedEras).toEqual(['v8', 'v9']);
    expect(walletProvider.getCoinPublicKey()).toBe('coin');
    expect(walletProvider.getEncryptionPublicKey()).toBe('enc');
  });

  for (const era of ERAS) {
    it(`balances a ${era} transaction through the facade as bytes and answers in the same era`, async () => {
      const unbound = await unboundTransaction(era);
      const finalized = await finalizedTransaction(era);
      const {facade, adopted, ttls} = recordingFacade(finalized.serialize());
      const {walletProvider} = makeContractWalletProviders({
        facade,
        keystore: stubKeystore,
        coinPublicKey: 'coin',
        encryptionPublicKey: 'enc',
        factories,
      });
      const ttl = new Date(Date.now() + 60_000);

      const balanced = await walletProvider.balanceTx(LedgerTransaction.seal(era, 'Unbound', unbound), ttl);

      expect(adopted).toEqual([{bytes: unbound.serialize(), stage: 'Unbound'}]);
      expect(ttls).toEqual([ttl]);
      expect(balanced.era).toBe(era);
      expect(balanced.stage).toBe('Finalized');
      expect(balanced.serialize()).toEqual(finalized.serialize());
    });

    it(`submits a ${era} transaction through the facade as bytes`, async () => {
      const finalized = await finalizedTransaction(era);
      const {facade, adopted, submitted} = recordingFacade();
      const {midnightProvider} = makeContractWalletProviders({
        facade,
        keystore: stubKeystore,
        coinPublicKey: 'coin',
        encryptionPublicKey: 'enc',
        factories,
      });

      await expect(midnightProvider.submitTx(LedgerTransaction.seal(era, 'Finalized', finalized))).resolves.toBe('tx-id');
      expect(adopted).toEqual([{bytes: finalized.serialize(), stage: 'Finalized'}]);
      expect(submitted).toEqual([finalized.serialize()]);
    });
  }
});

describe('createProofProvider', () => {
  const keyMaterial = {
    getZKIR: async () => new Uint8Array([1]),
    getProverKey: async () => new Uint8Array([2]),
    getVerifierKey: async () => new Uint8Array([3]),
  };
  const zkConfigProvider = {asKeyMaterialProvider: () => keyMaterial} as unknown as ZKConfigProvider<string>;

  afterAll(() => setWasmProvingProviderFactory(null));

  it('proves both ledger eras with the proof server', () => {
    const proofProvider = createProofProvider({type: 'server', url: 'http://127.0.0.1:9'}, zkConfigProvider);
    expect(proofProvider.supportedEras).toEqual(['v8', 'v9']);
  });

  for (const era of ERAS) {
    it(`proves a ${era} transaction in process and answers in the same era`, async () => {
      setWasmProvingProviderFactory(() => ({
        check: async () => [],
        prove: async () => {
          throw new Error('a transaction without contract calls has nothing to prove');
        },
      }));
      const proofProvider = createProofProvider({type: 'wasm'}, zkConfigProvider);
      expect(proofProvider.supportedEras).toEqual(['v8', 'v9']);

      const proven = await proofProvider.proveTx(
        LedgerTransaction.seal(era, 'Unproven', era === 'v8' ? unprovenTransaction('v8') : unprovenTransaction('v9')),
      );

      expect(proven.era).toBe(era);
      expect(proven.stage).toBe('Unbound');
    });
  }
});

describe('openContract', () => {
  let home: string;
  const previousHome = process.env.MOTH_HOME;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'moth-open-contract-'));
    process.env.MOTH_HOME = home;
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.MOTH_HOME;
    else process.env.MOTH_HOME = previousHome;
    await rm(home, {recursive: true, force: true});
  });

  const keystore = createKeystore({kind: 'schnorr', secret: randomBytes(32)}, 'undeployed');
  const zswapKeys = ZswapSecretKeys.fromSeed(randomBytes(32));
  const common = {
    facade: recordingFacade().facade,
    keystore,
    coinPublicKey: zswapKeys.coinPublicKey,
    encryptionPublicKey: zswapKeys.encryptionPublicKey,
  };

  for (const prover of [{type: 'wasm'}, {type: 'server', url: 'http://127.0.0.1:9'}] as const) {
    it(`hands midnight-js the bundled moth-ft as a ledger-8 instance, with providers for both eras (${prover.type} prover)`, async () => {
      const session = await openContract({
        ...common,
        artifactPath: MOTH_FT_LEDGER8,
        projectDir: CORE_PACKAGE_DIR,
        network: network(prover),
      });

      expect(session.era).toBe('v8');
      expect(session.midnightJs.projectRoot).toBeUndefined();
      expect(typeof session.compiledContract.initialState).toBe('function');
      expect(session.providers.config).toEqual({networkId: 'undeployed', ttlSeconds: 3600});
      for (const era of ERAS) {
        expect(() => assertProvidersSupportEra(era, session.providers)).not.toThrow();
      }
    });
  }

  it('hands midnight-js the ledger-9 build of moth-ft as a CompiledContract, with providers for both eras', async () => {
    const session = await openContract({
      ...common,
      artifactPath: MOTH_FT_LEDGER9,
      projectDir: CORE_PACKAGE_DIR,
      network: network({type: 'server', url: 'http://127.0.0.1:9'}),
    });

    expect(session.era).toBe('v9');
    expect(session.midnightJs.projectRoot).toBeUndefined();
    expect((session.midnightJs.CompiledContract as any).getCompiledAssetsPath(session.compiledContract)).toBe(MOTH_FT_LEDGER9);
    for (const era of ERAS) {
      expect(() => assertProvidersSupportEra(era, session.providers)).not.toThrow();
    }
  });

  // The ledger-9 build's compact-runtime 0.21 and midnight-js must share the one pinned
  // onchain-runtime-v4. The deploy has no circuit to prove, so the proof server is never asked.
  it('builds and proves a ledger-9 deploy of the bundled moth-ft', async () => {
    const session = await openContract({
      ...common,
      artifactPath: MOTH_FT_LEDGER9,
      projectDir: CORE_PACKAGE_DIR,
      network: network({type: 'server', url: 'http://127.0.0.1:9'}),
    });
    const {providers} = session;
    const unsubmitted = await session.midnightJs.contracts.createUnprovenDeployTxFromVerifierKeys(
      providers.zkConfigProvider,
      common.coinPublicKey,
      {compiledContract: session.compiledContract},
      common.encryptionPublicKey,
      providers.config,
    );
    expect(unsubmitted.private.unprovenTx.era).toBe('v9');
    expect(unsubmitted.public.initialContractState.era).toBe('v9');

    const proven = await providers.proofProvider.proveTx(unsubmitted.private.unprovenTx);
    expect(proven.era).toBe('v9');
    expect(proven.stage).toBe('Unbound');
  });

  // Running a circuit is where the contract module and midnight-js trade the most runtime
  // objects. Proving the call needs the circuit's keys, so this stops at the unproven call.
  for (const era of ERAS) {
    it(`runs mintUnshielded of the ${era} build of moth-ft against the state its deploy wrote`, async () => {
      const session = await openContract({
        ...common,
        artifactPath: era === 'v8' ? MOTH_FT_LEDGER8 : MOTH_FT_LEDGER9,
        projectDir: CORE_PACKAGE_DIR,
        network: network({type: 'server', url: 'http://127.0.0.1:9'}),
      });
      const {contracts} = session.midnightJs;
      const {providers} = session;
      const deploy = await (era === 'v8' ? contracts.createLedger8UnprovenDeployTxFromVerifierKeys : contracts.createUnprovenDeployTxFromVerifierKeys)(
        providers.zkConfigProvider,
        common.coinPublicKey,
        {compiledContract: session.compiledContract},
        common.encryptionPublicKey,
        providers.config,
      );
      const ledger = era === 'v8' ? ledgerV8 : ledgerV9;
      const call = {
        compiledContract: session.compiledContract,
        contractAddress: deploy.public.contractAddress,
        circuitId: 'mintUnshielded',
        args: [{bytes: new Uint8Array(32).fill(7)}, 1_000n],
        coinPublicKey: common.coinPublicKey,
        initialContractState: deploy.public.initialContractState,
        ledgerParameters: SerializedLedgerParameters.fromBytes(era, ledger.LedgerParameters.initialParameters().serialize()),
        config: providers.config,
      };
      const unsubmitted: any =
        era === 'v8'
          ? await contracts.createLedger8UnprovenCallTxFromInitialStates(
              providers.zkConfigProvider,
              {...call, head: 'v8'} as never,
              common.encryptionPublicKey,
            )
          : await contracts.createUnprovenCallTxFromInitialStates(
              providers.zkConfigProvider,
              {...call, initialZswapChainState: SerializedZswapChainState.fromBytes('v9', new ledgerV9.ZswapChainState().serialize())} as never,
              common.encryptionPublicKey,
            );

      expect(unsubmitted.private.unprovenTx.era).toBe(era);
      expect(unsubmitted.private.result).toBeInstanceOf(Uint8Array);
      expect(unsubmitted.private.result).toHaveLength(32);
    });
  }

  // The contract's compact-runtime 0.16 and midnight-js's own ledger-8 copy must share the one
  // pinned onchain-runtime-v3, or the contract refuses the framework's objects. A deploy needs
  // no circuit proof, so this runs offline as far as an unbound transaction.
  it('builds and proves a ledger-8 deploy of the bundled moth-ft', async () => {
    setWasmProvingProviderFactory(() => ({
      check: async () => [],
      prove: async () => {
        throw new Error('a deploy carries no circuit proof');
      },
    }));
    try {
      const session = await openContract({
        ...common,
        artifactPath: MOTH_FT_LEDGER8,
        projectDir: CORE_PACKAGE_DIR,
        network: network({type: 'wasm'}),
      });
      const {providers} = session;
      const unsubmitted = await session.midnightJs.contracts.createLedger8UnprovenDeployTxFromVerifierKeys(
        providers.zkConfigProvider,
        common.coinPublicKey,
        {compiledContract: session.compiledContract},
        common.encryptionPublicKey,
        providers.config,
      );
      expect(unsubmitted.private.unprovenTx.era).toBe('v8');

      const proven = await providers.proofProvider.proveTx(unsubmitted.private.unprovenTx);
      expect(proven.era).toBe('v8');
      expect(proven.stage).toBe('Unbound');
    } finally {
      setWasmProvingProviderFactory(null);
    }
  });

  // The in-process prover reads ZKIR v3 as well (see tests/unit/proof/zkir-dispatch.test.ts).
  it('opens a ledger-9 contract with the in-process prover, with providers for both eras', async () => {
    const managed = join(home, 'project', 'managed', 'ledger9');
    await mkdir(join(managed, 'compiler'), {recursive: true});
    await mkdir(join(managed, 'contract'), {recursive: true});
    await writeFile(join(managed, 'compiler', 'contract-info.json'), JSON.stringify({'runtime-version': '0.21.0'}));
    await writeFile(join(managed, 'contract', 'index.js'), 'export class Contract {}\n');

    const session = await openContract({
      ...common,
      artifactPath: managed,
      projectDir: join(home, 'project'),
      network: network({type: 'wasm'}),
    });

    expect(session.era).toBe('v9');
    for (const era of ERAS) {
      expect(() => assertProvidersSupportEra(era, session.providers)).not.toThrow();
    }
  });
});

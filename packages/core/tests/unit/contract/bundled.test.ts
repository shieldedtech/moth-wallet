// The bundled contracts ship one build per ledger era. These pin that each build loads the
// compact-runtime it was compiled for, and that moth picks the build midnight-js will accept:
// by the network's era for a deploy, and by the verifier keys on chain for a call.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {ZswapSecretKeys} from '@midnightntwrk/ledger-v8';
import {ContractOperation, ContractState} from '@midnight-ntwrk/compact-runtime';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import {SerializedContractState} from '@midnight-ntwrk/midnight-js/types';
import {
  BUNDLED_CONTRACT_PROJECT_DIR,
  bundledContractBuild,
  bundledContractForAddress,
  bundledContractForDeploy,
  bundledContractForState,
  verifierKeysOf,
  type BundledContractName,
} from '../../../src/contract/bundled.js';
import {contractEraOf, loadMidnightJs, openContract, type ContractEra} from '../../../src/contract/midnight-js.js';
import {setWasmProvingProviderFactory} from '../../../src/proof/provider.js';
import {WalletError} from '../../../src/types/errors.js';
import type {NetworkConfig} from '../../../src/types/network.js';

const CONTRACTS: readonly BundledContractName[] = ['moth-ft', 'receive-unshielded'];
const ERAS: readonly ContractEra[] = ['v8', 'v9'];
const RUNTIME = {v8: {specifier: 'compact-runtime-ledger8', version: '0.16.0'}, v9: {specifier: '@midnight-ntwrk/compact-runtime', version: '0.21.0'}};
// midnight-js maps node 1.x protocol versions to ledger 8 and 2.x to ledger 9.
const PROTOCOL_VERSION = {v8: 1_000_000, v9: 2_000_000};

describe('the bundled builds', () => {
  for (const name of CONTRACTS) {
    for (const era of ERAS) {
      it(`${name} for ${era} imports compact-runtime ${RUNTIME[era].version} and declares it`, async () => {
        const {artifactPath} = bundledContractBuild(name, era);
        const moduleFile = join(artifactPath, 'contract', 'index.js');
        const source = await readFile(moduleFile, 'utf8');
        expect(source).toContain(`from '${RUNTIME[era].specifier}';`);
        expect(source).toContain(`checkRuntimeVersion('${RUNTIME[era].version}')`);

        const runtimeManifest = createRequire(moduleFile).resolve(`${RUNTIME[era].specifier}/package.json`);
        expect(JSON.parse(await readFile(runtimeManifest, 'utf8')).version).toBe(RUNTIME[era].version);

        const midnightJs = await loadMidnightJs(BUNDLED_CONTRACT_PROJECT_DIR);
        const zkConfigProvider = new midnightJs.NodeZkConfigProvider(artifactPath, {verify: 'require-if-present'});
        expect(contractEraOf(await zkConfigProvider.getArtifactRuntimeVersion())).toBe(era);
      });
    }
  }
});

/** An indexer that answers the two queries build selection makes, with a fixed head and contract state. */
async function fakeIndexer(head: ContractEra, state?: SerializedContractState) {
  const ledgerParameters = await initialLedgerParameters(head);
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const {query} = JSON.parse(body) as {query: string};
      const data = query.includes('contract(')
        ? {
            block: {protocolVersion: PROTOCOL_VERSION[head], ledgerParameters},
            contract: state ? {state: Buffer.from(state.serialize()).toString('hex')} : null,
          }
        : {block: {protocolVersion: PROTOCOL_VERSION[head]}};
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({data}));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const {port} = server.address() as AddressInfo;
  return {
    network: {indexerUrl: `http://127.0.0.1:${port}/api/v4/graphql`},
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function initialLedgerParameters(era: ContractEra): Promise<string> {
  const ledger = era === 'v8' ? await import('@midnightntwrk/wallet-sdk/ledger/v8') : await import('@midnightntwrk/wallet-sdk/ledger/v9');
  return Buffer.from(ledger.LedgerParameters.initialParameters().serialize()).toString('hex');
}

describe('bundledContractForDeploy', () => {
  for (const era of ERAS) {
    it(`deploys the ${era} build while the network is on ${era}`, async () => {
      const indexer = await fakeIndexer(era);
      try {
        await expect(bundledContractForDeploy('moth-ft', indexer.network)).resolves.toEqual(bundledContractBuild('moth-ft', era));
      } finally {
        await indexer.close();
      }
    });
  }
});

describe('choosing the build of a deployed contract', () => {
  let home: string;
  const previousHome = process.env.MOTH_HOME;
  const deployed: Partial<Record<ContractEra, SerializedContractState>> = {};

  const network = (prover: NetworkConfig['prover']): NetworkConfig => ({
    id: 'undeployed',
    nodeUrl: 'http://127.0.0.1:9',
    indexerUrl: 'http://127.0.0.1:9/api/v4/graphql',
    prover,
  });

  // The contract state a deploy of each build writes, built offline: a deploy proves no circuit.
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'moth-bundled-'));
    process.env.MOTH_HOME = home;
    const zswapKeys = ZswapSecretKeys.fromSeed(randomBytes(32));
    const common = {
      facade: {} as WalletFacade,
      keystore: createKeystore({kind: 'schnorr', secret: randomBytes(32)}, 'undeployed'),
      coinPublicKey: zswapKeys.coinPublicKey,
      encryptionPublicKey: zswapKeys.encryptionPublicKey,
      projectDir: BUNDLED_CONTRACT_PROJECT_DIR,
    };
    setWasmProvingProviderFactory(() => ({check: async () => [], prove: async () => new Uint8Array()}));
    try {
      for (const era of ERAS) {
        const session = await openContract({
          ...common,
          artifactPath: bundledContractBuild('moth-ft', era).artifactPath,
          network: network(era === 'v8' ? {type: 'wasm'} : {type: 'server', url: 'http://127.0.0.1:9'}),
        });
        const {contracts} = session.midnightJs;
        const build = era === 'v8' ? contracts.createLedger8UnprovenDeployTxFromVerifierKeys : contracts.createUnprovenDeployTxFromVerifierKeys;
        const unsubmitted = await (build as any)(
          session.providers.zkConfigProvider,
          common.coinPublicKey,
          {compiledContract: session.compiledContract},
          common.encryptionPublicKey,
          session.providers.config,
        );
        deployed[era] = unsubmitted.public.initialContractState;
      }
    } finally {
      setWasmProvingProviderFactory(null);
    }
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.MOTH_HOME;
    else process.env.MOTH_HOME = previousHome;
    await rm(home, {recursive: true, force: true});
  });

  const address = '00'.repeat(32);

  for (const era of ERAS) {
    it(`calls a contract deployed from the ${era} build through that build`, async () => {
      const midnightJs = await loadMidnightJs(BUNDLED_CONTRACT_PROJECT_DIR);
      expect(deployed[era]!.era).toBe(era);
      await expect(bundledContractForState(midnightJs, 'moth-ft', deployed[era], address)).resolves.toEqual(
        bundledContractBuild('moth-ft', era),
      );
    });
  }

  // At the fork the network rewrites every contract state for ledger 9 and keeps its verifier
  // keys, so a contract deployed before it still takes the ledger-8 build afterwards.
  it('calls a contract deployed before the fork through the ledger-8 build after it', async () => {
    const midnightJs = await loadMidnightJs(BUNDLED_CONTRACT_PROJECT_DIR);
    const state = ContractState.deserialize(deployed.v9!.serialize());
    for (const [circuitId, verifierKey] of await verifierKeysOf(bundledContractBuild('moth-ft', 'v8'))) {
      // A fresh operation: one that already holds a ZKIR v3 key reports that key whatever else it holds.
      const operation = new ContractOperation();
      operation.verifierKey = verifierKey;
      state.setOperation(circuitId, operation);
    }
    const translated = SerializedContractState.fromBytes('v9', state.serialize());

    await expect(bundledContractForState(midnightJs, 'moth-ft', translated, address)).resolves.toEqual(
      bundledContractBuild('moth-ft', 'v8'),
    );
  });

  it('refuses a contract that holds the keys of neither build', async () => {
    const midnightJs = await loadMidnightJs(BUNDLED_CONTRACT_PROJECT_DIR);
    const refused = bundledContractForState(midnightJs, 'receive-unshielded', deployed.v9, address);
    await expect(refused).rejects.toThrow(WalletError);
    await expect(refused).rejects.toThrow(/holds the verifier keys of neither build of receive-unshielded/);
  });

  for (const era of ERAS) {
    it(`reads a ${era} contract state from the indexer`, async () => {
      const indexer = await fakeIndexer(era, deployed[era]);
      try {
        await expect(bundledContractForAddress('moth-ft', address, indexer.network)).resolves.toEqual(
          bundledContractBuild('moth-ft', era),
        );
      } finally {
        await indexer.close();
      }
    });
  }

  it('says so when no contract is deployed at the address', async () => {
    const indexer = await fakeIndexer('v9');
    try {
      await expect(bundledContractForAddress('moth-ft', address, indexer.network)).rejects.toThrow(
        `No contract is deployed at ${address}.`,
      );
    } finally {
      await indexer.close();
    }
  });
});

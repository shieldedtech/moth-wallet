// The contracts this package ships, each compiled for both ledger eras, and which build an
// operation takes.
//
// midnight-js 5 deploys a compactc 0.31 build (ledger 8) only before the v9 fork and a compactc
// 0.36.0 build (ledger 9) only from it, and it attaches to a deployed contract only through the
// build whose verifier keys that contract holds. So a deploy takes the build for the network's
// era, and a call takes the build whose keys match the contract's on chain. Each ledger-8 module
// imports compact-runtime 0.16 as `compact-runtime-ledger8`, because a package can depend on only
// one version of the runtime under its own name.

import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {VerifierKey} from '@midnight-ntwrk/midnight-js/types';
import {WalletError} from '../types/errors.js';
import type {NetworkConfig} from '../types/network.js';
import {loadMidnightJs, publicDataProviderFor, type ContractEra, type MidnightJs} from './midnight-js.js';

/** The package root, two levels up from src/contract or dist/contract. The bundled contracts run on its midnight-js. */
export const BUNDLED_CONTRACT_PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type BundledContractName = 'moth-ft' | 'receive-unshielded';

/** One compiled build of a bundled contract. */
export interface BundledContractBuild {
  readonly name: BundledContractName;
  readonly era: ContractEra;
  /** The `managed` directory compactc wrote. */
  readonly artifactPath: string;
}

const ERAS: readonly ContractEra[] = ['v8', 'v9'];

/** The build of `name` for `era`. */
export function bundledContractBuild(name: BundledContractName, era: ContractEra): BundledContractBuild {
  const artifactPath = join(BUNDLED_CONTRACT_PROJECT_DIR, 'contracts', name, era === 'v8' ? 'ledger8' : 'ledger9', 'managed');
  return {name, era, artifactPath};
}

/**
 * The build of `name` to deploy now: the one for the era of the network's latest block. midnight-js
 * checks a deploy against that same reading, so the build chosen here is one it accepts.
 */
export async function bundledContractForDeploy(
  name: BundledContractName,
  network: Pick<NetworkConfig, 'indexerUrl'>,
): Promise<BundledContractBuild> {
  const midnightJs = await loadMidnightJs(BUNDLED_CONTRACT_PROJECT_DIR);
  const {latestNetworkLedgerVersion} = await import('@midnight-ntwrk/midnight-js');
  return bundledContractBuild(name, await latestNetworkLedgerVersion(publicDataProviderFor(midnightJs, network)));
}

/**
 * The build of `name` that the contract at `contractAddress` runs on: the one whose verifier keys it
 * holds now. That is the build it was deployed from, unless maintenance has since replaced the keys.
 */
export async function bundledContractForAddress(
  name: BundledContractName,
  contractAddress: string,
  network: Pick<NetworkConfig, 'indexerUrl'>,
): Promise<BundledContractBuild> {
  const midnightJs = await loadMidnightJs(BUNDLED_CONTRACT_PROJECT_DIR);
  const read = await publicDataProviderFor(midnightJs, network).queryContractState(contractAddress);
  if (read === null) {
    throw new WalletError('INVALID_INPUT', `No contract is deployed at ${contractAddress}.`);
  }
  return bundledContractForState(midnightJs, name, read.contractState, contractAddress);
}

/**
 * The build of `name` whose verifier keys `contractState` holds for every circuit, checked the way
 * midnight-js checks them before it attaches to a contract.
 */
export async function bundledContractForState(
  midnightJs: MidnightJs,
  name: BundledContractName,
  contractState: unknown,
  contractAddress: string,
): Promise<BundledContractBuild> {
  const {verifyContractState, ContractTypeError} = midnightJs.contracts;
  const {createVerifierKey} = midnightJs.types;
  const refusals: string[] = [];
  for (const era of ERAS) {
    const build = bundledContractBuild(name, era);
    const verifierKeys = (await verifierKeysOf(build)).map(
      ([circuitId, key]): [string, VerifierKey] => [circuitId, createVerifierKey(key)],
    );
    try {
      await verifyContractState(verifierKeys, contractState as never, contractAddress);
      return build;
    } catch (err) {
      if (!(err instanceof ContractTypeError)) throw err;
      refusals.push(`the ledger-${era.slice(1)} build: ${err.message}`);
    }
  }
  throw new WalletError(
    'INVALID_INPUT',
    `The contract at ${contractAddress} holds the verifier keys of neither build of ${name} that moth ships, ` +
      `so moth cannot call it. ${refusals.join('; ')}`,
  );
}

/** Every circuit's verifier key in `build`, as compactc wrote them to `keys/<circuit>.verifier`. */
export async function verifierKeysOf(build: BundledContractBuild): Promise<Array<[string, Uint8Array]>> {
  const keysDir = join(build.artifactPath, 'keys');
  const circuitIds = (await readdir(keysDir))
    .filter((file) => file.endsWith('.verifier'))
    .map((file) => file.slice(0, -'.verifier'.length));
  return Promise.all(
    circuitIds.map(async (circuitId): Promise<[string, Uint8Array]> => [
      circuitId,
      new Uint8Array(await readFile(join(keysDir, `${circuitId}.verifier`))),
    ]),
  );
}

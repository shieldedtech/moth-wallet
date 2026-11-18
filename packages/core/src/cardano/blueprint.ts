import type { Script } from '@lucid-evolution/lucid';
import * as mainnetData from './blueprint-data-mainnet.js';
import * as testnetData from './blueprint-data-testnet.js';
import type { CardanoNetwork, CardanoNetworkConfig } from './network.js';

/** One compiled `cnight_generates_dust` and the hash that names it on chain. */
export interface CnightGeneratesDustDeployment {
  readonly script: Script;
  /** Script hash: the validator address, the reward account and the NFT policy id. */
  readonly hash: string;
}

/** The shape every generated blueprint-data-<deployment>.ts exports. */
interface BlueprintData {
  readonly CNIGHT_GENERATES_DUST_CBOR: string;
  readonly CNIGHT_GENERATES_DUST_HASH: string;
}

function deployment(data: BlueprintData): CnightGeneratesDustDeployment {
  return {
    script: { type: 'PlutusV3', script: data.CNIGHT_GENERATES_DUST_CBOR },
    hash: data.CNIGHT_GENERATES_DUST_HASH,
  };
}

/**
 * The deployment the Midnight bridge watches on each Cardano network.
 *
 * The validator compiles the cNIGHT policy in, so mainnet has its own bytes.
 * Preview and Preprod share the dummy cNIGHT token and therefore one script.
 */
export const CNIGHT_GENERATES_DUST: Readonly<Record<CardanoNetwork, CnightGeneratesDustDeployment>> = {
  Mainnet: deployment(mainnetData),
  Preprod: deployment(testnetData),
  Preview: deployment(testnetData),
};

export function cnightGeneratesDust(config: CardanoNetworkConfig): CnightGeneratesDustDeployment {
  return CNIGHT_GENERATES_DUST[config.network];
}

/**
 * The validator, in the shape Lucid attaches.
 *
 * The same script is attached three different ways across the flow — as the
 * minting policy for the registration NFT, as the spending validator that
 * releases the registration UTXO, and as the withdrawal validator that
 * authorises an in-place datum update — so the call sites pick the role.
 */
export function cnightGeneratesDustScript(config: CardanoNetworkConfig): Script {
  return cnightGeneratesDust(config).script;
}

/** Minting policy id for the registration NFT: the script hash unchanged. */
export function dustAuthPolicyId(config: CardanoNetworkConfig): string {
  return cnightGeneratesDust(config).hash;
}

/**
 * The registration NFT's unit. Its asset name is empty, so the unit is just the
 * policy id — this is not an oversight, it is what the contract mints.
 */
export function dustAuthUnit(config: CardanoNetworkConfig): string {
  return cnightGeneratesDust(config).hash;
}

/**
 * Lovelace locked in the registration UTXO. Taken from the dApp's
 * LOVELACE_FOR_REGISTRATION: it is the min-UTXO for an output carrying the NFT
 * plus the inline datum, computed once against live protocol parameters rather
 * than recomputed per build.
 */
export const LOVELACE_FOR_REGISTRATION = 1_586_080n;

/**
 * Lovelace a wallet should hold before attempting registration: the locked
 * amount above, plus fee and change headroom. Advisory — the node, not moth,
 * has the final say.
 */
export const MIN_LOVELACE_FOR_REGISTRATION = 2_500_000n;

/**
 * Address of the mapping validator that holds registration UTXOs.
 *
 * Derived from the network's script rather than configured: a configured
 * address could drift from the script actually attached, and would fail deep
 * inside the node instead of here.
 */
export async function dustValidatorAddress(config: CardanoNetworkConfig): Promise<string> {
  const { validatorToAddress } = await import('@lucid-evolution/lucid');
  return validatorToAddress(config.network, cnightGeneratesDustScript(config));
}

/**
 * The validator's own reward address. The update path withdraws zero from it
 * purely to force the withdrawal validator to run, which is how an in-place
 * datum change gets authorised without minting or burning.
 */
export async function dustValidatorRewardAddress(config: CardanoNetworkConfig): Promise<string> {
  const { validatorToRewardAddress } = await import('@lucid-evolution/lucid');
  return validatorToRewardAddress(config.network, cnightGeneratesDustScript(config));
}

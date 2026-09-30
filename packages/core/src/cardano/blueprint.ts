import type { Script } from '@lucid-evolution/lucid';
import {
  CNIGHT_GENERATES_DUST_CBOR,
  CNIGHT_GENERATES_DUST_HASH,
} from './blueprint-data.js';
import type { CardanoNetworkConfig } from './network.js';

/**
 * The `cnight_generates_dust` validator, in the shape Lucid attaches.
 *
 * The same script is attached three different ways across the flow — as the
 * minting policy for the registration NFT, as the spending validator that
 * releases the registration UTXO, and as the withdrawal validator that
 * authorises an in-place datum update — so it is exported once and the call
 * sites pick the role.
 */
export const cnightGeneratesDustScript: Script = {
  type: 'PlutusV3',
  script: CNIGHT_GENERATES_DUST_CBOR,
};

/**
 * Minting policy id for the registration NFT. The script takes no parameters,
 * so this is the blueprint hash unchanged.
 */
export const dustAuthPolicyId = CNIGHT_GENERATES_DUST_HASH;

/**
 * The registration NFT's unit. Its asset name is empty, so the unit is just the
 * policy id — this is not an oversight, it is what the contract mints.
 */
export const dustAuthUnit = CNIGHT_GENERATES_DUST_HASH;

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
 * Derived rather than configured. The script has no parameters, so its hash is
 * fixed and the only thing that varies is the network id baked into the bech32
 * prefix — a configured address could drift from the script actually attached,
 * and would fail deep inside the node instead of here.
 */
export async function dustValidatorAddress(config: CardanoNetworkConfig): Promise<string> {
  const { validatorToAddress } = await import('@lucid-evolution/lucid');
  return validatorToAddress(config.network, cnightGeneratesDustScript);
}

/**
 * The validator's own reward address. The update path withdraws zero from it
 * purely to force the withdrawal validator to run, which is how an in-place
 * datum change gets authorised without minting or burning.
 */
export async function dustValidatorRewardAddress(config: CardanoNetworkConfig): Promise<string> {
  const { validatorToRewardAddress } = await import('@lucid-evolution/lucid');
  return validatorToRewardAddress(config.network, cnightGeneratesDustScript);
}

export { CNIGHT_GENERATES_DUST_HASH };

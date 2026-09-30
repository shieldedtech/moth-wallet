// Guards on the parts of the cNIGHT integration that are not ours to choose:
// the compiled validator, and the exact bytes the mapping datum serializes to.
//
// These are pinned against the cNIGHT-to-DUST dApp, which is the production
// implementation of the same flow. If moth and the dApp disagree about any of
// it, moth's transactions are rejected by the validator — so the values are
// asserted literally rather than recomputed, and a diff here means someone
// changed a wire format, not a test.

import { describe, expect, it } from 'vitest';
import { validatorToAddress, validatorToRewardAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import {
  CNIGHT_GENERATES_DUST_HASH,
  cnightGeneratesDustScript,
  dustAuthPolicyId,
  dustAuthUnit,
  dustValidatorAddress,
  dustValidatorRewardAddress,
  LOVELACE_FOR_REGISTRATION,
} from '../../../src/cardano/blueprint.js';
import {
  buildDustMappingDatum,
  datumStakeKeyHash,
  decodeDustMappingDatum,
  encodeDustMappingDatum,
  encodeMintRedeemer,
  unitRedeemer,
} from '../../../src/cardano/datum.js';
import { resolveCardanoNetwork } from '../../../src/cardano/network.js';
import { assertCoinPublicKey } from '../../../src/cardano/registration.js';

const STAKE_KEY_HASH = 'abfff883edcf7a2e38628015cebb72952e361b2c8a2262f7daf9c16e';
const COIN_PUBLIC_KEY = '11'.repeat(32);

describe('compiled validator', () => {
  it('hashes to the value the blueprint declares', () => {
    // Catches a truncated or corrupted paste of the 3402-character CBOR far
    // more cheaply than a rejected transaction does.
    expect(validatorToScriptHash(cnightGeneratesDustScript)).toBe(CNIGHT_GENERATES_DUST_HASH);
  });

  it('is PlutusV3, as the blueprint preamble says', () => {
    expect(cnightGeneratesDustScript.type).toBe('PlutusV3');
  });

  it('uses its own hash as the auth token policy, with an empty asset name', () => {
    // Not an oversight in the contract: the minted NFT has no asset name, so
    // its unit is the bare policy id.
    expect(dustAuthPolicyId).toBe(CNIGHT_GENERATES_DUST_HASH);
    expect(dustAuthUnit).toBe(CNIGHT_GENERATES_DUST_HASH);
  });

  it('derives the mapping validator address from the network, not from config', async () => {
    const preview = resolveCardanoNetwork('preview');
    const mainnet = resolveCardanoNetwork('mainnet');
    await expect(dustValidatorAddress(preview)).resolves.toBe(
      validatorToAddress('Preview', cnightGeneratesDustScript),
    );
    await expect(dustValidatorAddress(preview)).resolves.toMatch(/^addr_test1/);
    await expect(dustValidatorAddress(mainnet)).resolves.toMatch(/^addr1/);
  });

  it('derives the validator reward address the update path withdraws from', async () => {
    const preview = resolveCardanoNetwork('preview');
    await expect(dustValidatorRewardAddress(preview)).resolves.toBe(
      validatorToRewardAddress('Preview', cnightGeneratesDustScript),
    );
    await expect(dustValidatorRewardAddress(preview)).resolves.toMatch(/^stake_test1/);
  });

  it('locks the dApp min-UTXO amount in the registration output', () => {
    expect(LOVELACE_FOR_REGISTRATION).toBe(1_586_080n);
  });
});

describe('DustMappingDatum', () => {
  it('serializes to the exact bytes the dApp produces', () => {
    // Cross-checked against @blaze-cardano/data serializing the dApp's own
    // generated blueprint type for the same inputs. constr 0 [constr 0
    // [bytes28], bytes32] — the stake key hash, then the coin public key.
    const cbor = encodeDustMappingDatum(buildDustMappingDatum(STAKE_KEY_HASH, COIN_PUBLIC_KEY));
    expect(cbor).toBe(
      'd8799fd8799f581cabfff883edcf7a2e38628015cebb72952e361b2c8a2262f7daf9c16e' +
        'ff58201111111111111111111111111111111111111111111111111111111111111111ff',
    );
  });

  it('round-trips', () => {
    const datum = buildDustMappingDatum(STAKE_KEY_HASH, COIN_PUBLIC_KEY);
    expect(decodeDustMappingDatum(encodeDustMappingDatum(datum))).toEqual(datum);
  });

  it('reads back the stake key hash that decides whose registration it is', () => {
    const datum = decodeDustMappingDatum(
      encodeDustMappingDatum(buildDustMappingDatum(STAKE_KEY_HASH, COIN_PUBLIC_KEY)),
    );
    expect(datumStakeKeyHash(datum)).toBe(STAKE_KEY_HASH);
  });

  it('rejects a stake key hash that is not 28 bytes', () => {
    expect(() => encodeDustMappingDatum(buildDustMappingDatum('abcd', COIN_PUBLIC_KEY))).toThrow();
  });

  it('rejects a coin public key that is not 32 bytes', () => {
    expect(() => encodeDustMappingDatum(buildDustMappingDatum(STAKE_KEY_HASH, 'ab'))).toThrow();
  });
});

describe('redeemers', () => {
  it('matches the dApp byte for byte', () => {
    expect(encodeMintRedeemer('Create')).toBe('d87980');
    expect(encodeMintRedeemer('Burn')).toBe('d87a80');
    expect(unitRedeemer()).toBe('d87980');
  });
});

describe('assertCoinPublicKey', () => {
  it('normalizes a 0x prefix and case', () => {
    expect(assertCoinPublicKey(`0x${'AB'.repeat(32)}`)).toBe('ab'.repeat(32));
  });

  it('rejects anything that is not 32 bytes of hex', () => {
    // A bech32m shielded address is the mistake this exists to catch: it is
    // what a user has to hand, and it would otherwise reach the datum.
    expect(() => assertCoinPublicKey('mn_shield-addr1ehmxwu6u7vz8wjs5ddm0e409hk7p7kud3gz5e6')).toThrow(
      /32 bytes of hex/,
    );
    expect(() => assertCoinPublicKey('ab'.repeat(31))).toThrow(/62 characters/);
  });
});

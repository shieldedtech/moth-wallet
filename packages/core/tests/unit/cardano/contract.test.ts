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
  CNIGHT_GENERATES_DUST,
  cnightGeneratesDustScript,
  dustAuthPolicyId,
  dustAuthUnit,
  dustValidatorAddress,
  dustValidatorRewardAddress,
  LOVELACE_FOR_REGISTRATION,
} from '../../../src/cardano/blueprint.js';
import * as mainnetData from '../../../src/cardano/blueprint-data-mainnet.js';
import * as testnetData from '../../../src/cardano/blueprint-data-testnet.js';
import {
  buildDustMappingDatum,
  datumStakeKeyHash,
  decodeDustMappingDatum,
  encodeDustMappingDatum,
  encodeMintRedeemer,
  unitRedeemer,
} from '../../../src/cardano/datum.js';
import { resolveCardanoNetwork } from '../../../src/cardano/network.js';
import { resolveDustReceiver } from '../../../src/cardano/registration.js';

const STAKE_KEY_HASH = '070c2f801567402df8e4e630ed3819e1c29219d1d918266758e3a063';
/**
 * A real serialized DUST address — the bech32m payload of
 * mn_dust_preprod1wwxhaf472uhxnltad72rmph52gdpef7a7ytq78vneqs2secjdyjzyh4t0ey.
 *
 * The 33 bytes serialize() returns: a 0x73 type tag then the payload. Every
 * live registration at the deployed contract carries this form. NOT the
 * 32-byte shielded coin public key, which is a different key that encodes just
 * as cleanly and is silently never matched by the bridge.
 */
const DUST_ADDRESS_BYTES =
  '738d7ea6be572e69fd7d6f943d86f4521a1ca7ddf1160f1d93c820a86712692422';

const TESTNET_HASH = '7e69087d98fac5869eac14e13dfb6f98228c41e638aa2a59d1f85e9c';
const MAINNET_HASH = '73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5';

describe('compiled validator', () => {
  const preprod = resolveCardanoNetwork('preprod');
  const preview = resolveCardanoNetwork('preview');
  const mainnet = resolveCardanoNetwork('mainnet');

  it('is the contract the Midnight bridge actually reads, on every network', () => {
    // Pinned as literals against deployments observed to be live: the Midnight
    // indexer reports registrations at these script addresses as valid, with
    // real generation rates. A hash recomputed from the same file cannot catch
    // bytes from the wrong deployment.
    expect(validatorToScriptHash(cnightGeneratesDustScript(preprod))).toBe(TESTNET_HASH);
    expect(validatorToScriptHash(cnightGeneratesDustScript(preview))).toBe(TESTNET_HASH);
    expect(validatorToScriptHash(cnightGeneratesDustScript(mainnet))).toBe(MAINNET_HASH);
  });

  it('registers on mainnet at the address the Midnight bridge watches', async () => {
    // The testnet bytes derive addr1w9lxjzr…, which the bridge ignores.
    await expect(dustValidatorAddress(mainnet)).resolves.toBe(
      'addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7',
    );
  });

  it('compiles in the cNIGHT policy of the network it is used on', () => {
    // The validator rejects any other policy, so this ties each script to its
    // network and catches a mainnet/testnet swap of the generated files.
    for (const config of [preprod, preview, mainnet]) {
      expect(cnightGeneratesDustScript(config).script).toContain(config.cnightPolicyId);
    }
    expect(cnightGeneratesDustScript(mainnet).script).not.toContain(preprod.cnightPolicyId);
  });

  it('hashes to the value each blueprint-data file declares', () => {
    // Self-consistent by construction: this proves only that a generated file
    // is not truncated or corrupted. The pins above prove it is the right one.
    expect(CNIGHT_GENERATES_DUST.Preprod.hash).toBe(testnetData.CNIGHT_GENERATES_DUST_HASH);
    expect(CNIGHT_GENERATES_DUST.Mainnet.hash).toBe(mainnetData.CNIGHT_GENERATES_DUST_HASH);
    for (const config of [preprod, preview, mainnet]) {
      expect(validatorToScriptHash(cnightGeneratesDustScript(config))).toBe(
        CNIGHT_GENERATES_DUST[config.network].hash,
      );
    }
  });

  it('is PlutusV3, as the blueprint preamble says', () => {
    for (const config of [preprod, preview, mainnet]) {
      expect(cnightGeneratesDustScript(config).type).toBe('PlutusV3');
    }
  });

  it('uses its own hash as the auth token policy, with an empty asset name', () => {
    // Not an oversight in the contract: the minted NFT has no asset name, so
    // its unit is the bare policy id.
    expect(dustAuthPolicyId(preview)).toBe(TESTNET_HASH);
    expect(dustAuthUnit(preview)).toBe(TESTNET_HASH);
    expect(dustAuthPolicyId(mainnet)).toBe(MAINNET_HASH);
    expect(dustAuthUnit(mainnet)).toBe(MAINNET_HASH);
  });

  it('derives the mapping validator address from the network, not from config', async () => {
    await expect(dustValidatorAddress(preview)).resolves.toBe(
      validatorToAddress('Preview', cnightGeneratesDustScript(preview)),
    );
    await expect(dustValidatorAddress(preview)).resolves.toMatch(/^addr_test1/);
    await expect(dustValidatorAddress(mainnet)).resolves.toMatch(/^addr1/);
  });

  it('derives the validator reward address the update path withdraws from', async () => {
    await expect(dustValidatorRewardAddress(preview)).resolves.toBe(
      validatorToRewardAddress('Preview', cnightGeneratesDustScript(preview)),
    );
    await expect(dustValidatorRewardAddress(preview)).resolves.toMatch(/^stake_test1/);
    await expect(dustValidatorRewardAddress(mainnet)).resolves.toBe(
      validatorToRewardAddress('Mainnet', cnightGeneratesDustScript(mainnet)),
    );
  });

  it('locks the dApp min-UTXO amount in the registration output', () => {
    expect(LOVELACE_FOR_REGISTRATION).toBe(1_586_080n);
  });
});

describe('DustMappingDatum', () => {
  it('encodes the 33-byte serialized DUST address', () => {
    // 5821 is a 33-byte bytestring header; 5820 would be 32 and is the shape
    // the coin-public-key bug produced — a registration no bridge ever matched.
    const cbor = encodeDustMappingDatum(buildDustMappingDatum(STAKE_KEY_HASH, DUST_ADDRESS_BYTES));
    expect(cbor).toBe(
      'd8799fd8799f581c070c2f801567402df8e4e630ed3819e1c29219d1d918266758e3a063'
        + 'ff5821738d7ea6be572e69fd7d6f943d86f4521a1ca7ddf1160f1d93c820a86712692422ff',
    );
    expect(cbor).toContain('5821');
    expect(cbor).not.toContain('5820');
  });

  it('round-trips', () => {
    const datum = buildDustMappingDatum(STAKE_KEY_HASH, DUST_ADDRESS_BYTES);
    expect(decodeDustMappingDatum(encodeDustMappingDatum(datum))).toEqual(datum);
  });

  it('reads back the stake key hash that decides whose registration it is', () => {
    const datum = decodeDustMappingDatum(
      encodeDustMappingDatum(buildDustMappingDatum(STAKE_KEY_HASH, DUST_ADDRESS_BYTES)),
    );
    expect(datumStakeKeyHash(datum)).toBe(STAKE_KEY_HASH);
  });

  it('rejects a stake key hash that is not 28 bytes', () => {
    expect(() => encodeDustMappingDatum(buildDustMappingDatum('abcd', DUST_ADDRESS_BYTES))).toThrow();
  });

  it('rejects a 32-byte receiver at the point moth writes one', () => {
    // The coin public key is 32 bytes and encodes fine; the guard is
    // resolveDustReceiver, not the datum schema — keeping it out of the schema
    // is deliberate, see below.
    expect(() => resolveDustReceiver('11'.repeat(32))).toThrow();
  });

  it('still decodes a legacy 32-byte registration already on chain', () => {
    // preprod 7052cbb8aa3236ce…#0, written before the encoding was fixed. The
    // validator allows anything up to 33 bytes, so this really is out there.
    // A schema pinned to exactly 33 does not reject such a datum, it *hides*
    // it: findRegistrations skips what it cannot decode, the UI reports "Not
    // registered", and the next register mints a second auth NFT against a
    // stake key that already has one — which the validator kills at Mint[0].
    const datum = decodeDustMappingDatum(
      'd8799fd8799f581c070c2f801567402df8e4e630ed3819e1c29219d1d918266758e3a063'
        + 'ff5820ae6b465d766ce0a13265ef00859bddd523c9d858523b687903a60bcebd95a7a7ff',
    );
    expect(datumStakeKeyHash(datum)).toBe(STAKE_KEY_HASH);
    expect(datum.dust_address).toHaveLength(64); // right length, wrong key: visible
  });

  it('rejects a receiver longer than the validator\'s 33-byte bound', () => {
    expect(() =>
      encodeDustMappingDatum(buildDustMappingDatum(STAKE_KEY_HASH, '11'.repeat(34))),
    ).toThrow();
  });
});

describe('redeemers', () => {
  it('matches the dApp byte for byte', () => {
    expect(encodeMintRedeemer('Create')).toBe('d87980');
    expect(encodeMintRedeemer('Burn')).toBe('d87a80');
    expect(unitRedeemer()).toBe('d87980');
  });
});

describe('resolveDustReceiver', () => {
  const DUST =
    'mn_dust_preprod1wwxhaf472uhxnltad72rmph52gdpef7a7ytq78vneqs2secjdyjzyh4t0ey';
  const SHIELDED =
    'mn_shield-addr1ehmxwu6u7vz8wjs5ddm0e409hk7p7kud3gz5e6v3p0xqj44wderqrpwkgz4zhffyx47k0tv9qudcd6qxh7vmgjsjt00ah88hltw3pucuz795u';

  it('serializes a DUST address to the bytes a datum records', () => {
    expect(resolveDustReceiver(DUST)).toBe(DUST_ADDRESS_BYTES);
  });

  it('accepts the raw 33-byte hex too', () => {
    expect(resolveDustReceiver(DUST_ADDRESS_BYTES)).toBe(DUST_ADDRESS_BYTES);
    expect(resolveDustReceiver(`0x${DUST_ADDRESS_BYTES}`)).toBe(DUST_ADDRESS_BYTES);
  });

  it('refuses a shielded address by name', () => {
    // The other plausible paste, and what an earlier version of the dApp used.
    // Accepting it silently is what cost twelve hours of waiting for DUST that
    // could never arrive.
    expect(() => resolveDustReceiver(SHIELDED)).toThrow(/DUST address/);
  });

  it('refuses a 32-byte coin public key', () => {
    // The other plausible receiver, same shape, different key. Accepting it is
    // what produced a registration that confirmed and generated nothing.
    expect(() => resolveDustReceiver('ab'.repeat(32))).toThrow(/DUST address/);
  });

  it('refuses anything that is not a Midnight address', () => {
    expect(() => resolveDustReceiver('not-an-address')).toThrow();
  });
});

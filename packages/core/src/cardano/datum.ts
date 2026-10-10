import { Data } from '@lucid-evolution/lucid';

/**
 * `cardano/address/Credential` from the blueprint: a two-way choice between a
 * key hash and a script hash. Registration only ever produces the key-hash arm,
 * but the script arm has to be declared or the constructor indices shift and
 * every datum moth writes would decode as the wrong variant.
 */
const CredentialSchema = Data.Enum([
  Data.Object({ VerificationKey: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
  Data.Object({ Script: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
]);

/**
 * `cnight_generates_dust/DustMappingDatum`: the on-chain mapping itself.
 *
 * `c_wallet` is the Cardano **stake** key hash, not the payment key hash — DUST
 * generation follows the stake credential so that moving cNIGHT between a
 * wallet's own payment addresses does not break the mapping.
 *
 * `dust_address` is a serialized Midnight DUST address: the 33 bytes
 * `DustAddress.serialize()` returns, a 0x73 type tag then the payload. NOT the 32-byte shielded coin
 * public key — those are different keys, both plausible, and the wrong one
 * produces a registration that is well-formed on Cardano, correctly signed,
 * and simply never matched by the bridge. There is no error; DUST just never
 * arrives, and you find out twelve hours later.
 *
 * The bound is the deployed validator's own: `length_of_bytearray(dust_address)
 * <= 33`. The range is open below 33 because this schema also has to *read*
 * what is already on chain. Registrations written against the 32-byte coin public key
 * exist, and a stricter schema does not reject them so much as hide them: the
 * datum stops decoding, `findRegistrations` returns nothing, the UI reports
 * "Not registered", and the next register mints a second auth NFT against a
 * stake key that already has one — which the validator kills at Mint[0].
 * Being unable to see a bad registration is strictly worse than reading it,
 * because you cannot deregister what you cannot find. What moth *writes* stays
 * pinned to 33 by assertDustAddressBytes, upstream in registration.ts.
 */
const DustMappingDatumSchema = Data.Object({
  c_wallet: CredentialSchema,
  dust_address: Data.Bytes({ minLength: 1, maxLength: 33 }),
});

export type DustMappingDatum = Data.Static<typeof DustMappingDatumSchema>;
export const DustMappingDatum = DustMappingDatumSchema as unknown as DustMappingDatum;

/** `cnight_generates_dust/DustAction`, the minting-policy redeemer. */
const DustActionSchema = Data.Enum([Data.Literal('Create'), Data.Literal('Burn')]);
export type DustAction = Data.Static<typeof DustActionSchema>;
export const DustAction = DustActionSchema as unknown as DustAction;

export function buildDustMappingDatum(
  stakeKeyHash: string,
  dustAddressHex: string,
): DustMappingDatum {
  return {
    c_wallet: { VerificationKey: [stakeKeyHash] },
    dust_address: dustAddressHex,
  };
}

export function encodeDustMappingDatum(datum: DustMappingDatum): string {
  return Data.to(datum, DustMappingDatum);
}

export function decodeDustMappingDatum(cbor: string): DustMappingDatum {
  return Data.from(cbor, DustMappingDatum);
}

/** The stake key hash a registration datum points at, or null for a script credential. */
export function datumStakeKeyHash(datum: DustMappingDatum): string | null {
  return 'VerificationKey' in datum.c_wallet ? datum.c_wallet.VerificationKey[0] : null;
}

export function encodeMintRedeemer(action: 'Create' | 'Burn'): string {
  return Data.to(action, DustAction);
}

/**
 * Spend and withdrawal redeemers are the unit constructor. The validator
 * branches on the transaction's shape — what is minted, burned, or withdrawn —
 * rather than on anything the redeemer carries.
 */
export function unitRedeemer(): string {
  return Data.void();
}

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
 * `dust_address` is the Midnight coin public key, 32 raw bytes. It is not a
 * bech32m address and not the night address; passing either produces a
 * registration that looks fine on Cardano and silently generates DUST nobody
 * can spend.
 */
const DustMappingDatumSchema = Data.Object({
  c_wallet: CredentialSchema,
  dust_address: Data.Bytes({ minLength: 32, maxLength: 32 }),
});

export type DustMappingDatum = Data.Static<typeof DustMappingDatumSchema>;
export const DustMappingDatum = DustMappingDatumSchema as unknown as DustMappingDatum;

/** `cnight_generates_dust/DustAction`, the minting-policy redeemer. */
const DustActionSchema = Data.Enum([Data.Literal('Create'), Data.Literal('Burn')]);
export type DustAction = Data.Static<typeof DustActionSchema>;
export const DustAction = DustActionSchema as unknown as DustAction;

export function buildDustMappingDatum(stakeKeyHash: string, coinPublicKeyHex: string): DustMappingDatum {
  return {
    c_wallet: { VerificationKey: [stakeKeyHash] },
    dust_address: coinPublicKeyHex,
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

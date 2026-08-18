// Signature encodings differ across the ledger fork. v8 types Signature,
// SigningKey and SignatureVerifyingKey as bare hex strings; v9 types them as
// {tag, value}, where the tag names the algorithm. Both reach the dApp
// connector, so the wire value is unwrapped rather than stringified — String()
// on a v9 value yields "[object Object]", which is well-formed enough to look
// like a signature and wrong enough to never verify. See ADR-0006.

/** BIP-340 Schnorr, or ECDSA over secp256k1. New in ledger v9. */
export type SignatureKind = 'schnorr' | 'ecdsa';

/** A hex value that may or may not carry its algorithm, depending on ledger. */
export type TaggedOrBare = string | {readonly tag: SignatureKind; readonly value: string};

function isTagged(v: unknown): v is {tag: SignatureKind; value: string} {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as {tag?: unknown; value?: unknown};
  return (c.tag === 'schnorr' || c.tag === 'ecdsa') && typeof c.value === 'string';
}

/** The hex value, whichever ledger produced it. */
export function unwrapSignatureValue(value: TaggedOrBare): string {
  if (typeof value === 'string') return value;
  if (isTagged(value)) return value.value;
  throw new Error('Unrecognized signature encoding: expected a hex string or a {tag, value} pair');
}

/**
 * The algorithm behind a value. v8 has only one, so an untagged value is
 * Schnorr — the fork adds the choice, it does not change what v8 produced.
 */
export function signatureKindOf(value: TaggedOrBare): SignatureKind {
  if (typeof value === 'string') return 'schnorr';
  if (isTagged(value)) return value.tag;
  throw new Error('Unrecognized signature encoding: expected a hex string or a {tag, value} pair');
}

// Message signing for the dApp connector's `signData`. Signs arbitrary data
// with the wallet's unshielded (NightExternal) key, applying the Midnight
// domain-separation prefix so a signed message can never also be a valid
// transaction: the unshielded key authorizes transfers too, and ledger's
// signData explicitly warns against signing uncontrolled data without such
// separation.
//
// Per the Midnight dApp connector spec, the bytes actually signed are
//   utf8(`midnight_signed_message:${byteLength}:`) ++ decodedData
// where byteLength is the length of the decoded data in bytes.

import {createKeystoreFor} from '../sdk/index.js';
import { Roles, deriveRawKeys } from './address.js';
import {
  signatureKindOf,
  unwrapSignatureValue,
  type SignatureKind,
  type TaggedOrBare,
} from './signature-encoding.js';

export type SignEncoding = 'hex' | 'base64' | 'text';

export interface SignedMessage {
  /** The original data string, echoed back so the caller can correlate. */
  data: string;
  /** Signature in the keystore's native hex encoding. connector-api 4.0.1
   *  leaves the wire format unspecified, so we return the ledger encoding. */
  signature: string;
  /** Verifying (public) key in the keystore's native hex encoding. */
  verifyingKey: string;
  /** The algorithm that produced the signature. Always `schnorr` on ledger v8. */
  signatureKind: SignatureKind;
}

const MESSAGE_PREFIX = 'midnight_signed_message';

/** Decode the request payload into the raw bytes to be signed. */
function decodeData(data: string, encoding: SignEncoding): Uint8Array {
  switch (encoding) {
    case 'text':
      // JS strings are UTF-16; normalize to UTF-8 as the spec requires.
      return new TextEncoder().encode(data);
    case 'hex': {
      const hex = data.startsWith('0x') ? data.slice(2) : data;
      if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error('Invalid hex data');
      return Uint8Array.from(Buffer.from(hex, 'hex'));
    }
    case 'base64': {
      const clean = data.replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('Invalid base64 data');
      return Uint8Array.from(Buffer.from(clean, 'base64'));
    }
  }
}

/** The exact byte sequence signed for a message: the domain prefix ++ data.
 *  Exposed so verifiers (and tests) can reconstruct what was signed. */
export function signedMessageBytes(data: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${MESSAGE_PREFIX}:${data.length}:`);
  const out = new Uint8Array(prefix.length + data.length);
  out.set(prefix, 0);
  out.set(data, prefix.length);
  return out;
}

/**
 * Sign `data` (interpreted per `encoding`) with the seed's unshielded key,
 * returning the signature and verifying key. Only `keyType: 'unshielded'` is
 * supported by the connector, so no key type is threaded here.
 */
export function signMessage(
  seedHex: string,
  networkId: string,
  data: string,
  encoding: SignEncoding,
): SignedMessage {
  const payload = signedMessageBytes(decodeData(data, encoding));
  const keys = deriveRawKeys(seedHex);
  const keystore = createKeystoreFor(keys[Roles.NightExternal], networkId);
  const signature = keystore.signData(payload) as TaggedOrBare;
  const verifyingKey = keystore.getPublicKey() as TaggedOrBare;
  return {
    data,
    signature: unwrapSignatureValue(signature),
    verifyingKey: unwrapSignatureValue(verifyingKey),
    signatureKind: signatureKindOf(signature),
  };
}

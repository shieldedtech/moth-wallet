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

import { createKeystore } from '@midnightntwrk/wallet-sdk/unshielded';
import { Roles, deriveRawKeys } from './address.js';

export type SignEncoding = 'hex' | 'base64' | 'text';

/** The dApp connector's name for a signature scheme (connector-api 4.1.0 `Signature.scheme`). */
export type SignatureScheme = 'schnorr_bip340' | 'ecdsa_secp256k1_sha256';

export interface SignedMessage {
  /** The original data string, echoed back so the caller can correlate. */
  data: string;
  /** Always set, though connector-api 4.1.0 reads an absent scheme as schnorr. */
  scheme: SignatureScheme;
  /** The ledger's hex value: r‖s, 64 bytes, as connector-api 4.1.0 specifies.
   *  Untagged, so a dApp still on ledger-v8 can verify it as it stands. */
  signature: string;
  /** Hex verifying key: 32-byte x-only for schnorr, 33-byte compressed for ECDSA. */
  verifyingKey: string;
}

/** The connector's scheme for each ledger signature kind. */
const SCHEMES: Record<'schnorr' | 'ecdsa', SignatureScheme> = {
  schnorr: 'schnorr_bip340',
  ecdsa: 'ecdsa_secp256k1_sha256',
};

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
  const keystore = createKeystore({ kind: 'schnorr', secret: keys[Roles.NightExternal] }, networkId);
  // The scheme is read off the ledger's tag, so it names what actually signed.
  const signature = keystore.signData(payload);
  return {
    data,
    scheme: SCHEMES[signature.tag],
    signature: signature.value,
    verifyingKey: keystore.getPublicKey().value,
  };
}

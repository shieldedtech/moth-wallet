import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { scrypt } from '@noble/hashes/scrypt.js';

export interface EncryptedKeystore {
  readonly version: number;
  readonly algorithm: string;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

const KEYSTORE_VERSION = 2;
const ALGORITHM = 'chacha20-poly1305';
const SALT_LENGTH = 32;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;

// scrypt parameters per keystore version.
// V1: N=2^15 (~8 MiB, ~50ms) — too weak for offline key storage.
// V2: N=2^18 (~256 MiB, ~300ms) — meets NIST SP 800-132 interactive threshold.
const SCRYPT_PARAMS: Record<number, { N: number; r: number; p: number }> = {
  1: { N: 2 ** 15, r: 8, p: 1 },
  2: { N: 2 ** 18, r: 8, p: 1 },
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function deriveEncryptionKey(
  passphrase: string,
  salt: Uint8Array,
  version: number = KEYSTORE_VERSION,
): Uint8Array {
  const params = SCRYPT_PARAMS[version] ?? SCRYPT_PARAMS[KEYSTORE_VERSION];
  return scrypt(encoder.encode(passphrase), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: KEY_LENGTH,
  });
}

export async function encryptKeystore(
  mnemonic: string,
  passphrase: string,
): Promise<EncryptedKeystore> {
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const key = deriveEncryptionKey(passphrase, salt);

  const cipher = chacha20poly1305(key, nonce);
  const plaintext = encoder.encode(mnemonic);
  const sealed = cipher.encrypt(plaintext);

  // ChaCha20-Poly1305 appends 16-byte tag to ciphertext
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  // Zero the key from memory
  key.fill(0);

  return {
    version: KEYSTORE_VERSION,
    algorithm: ALGORITHM,
    salt,
    nonce,
    ciphertext,
    tag,
  };
}

/** Current keystore version — new keystores are always created at this version */
export { KEYSTORE_VERSION };

/** Check if a keystore needs re-encryption with stronger KDF parameters */
export function keystoreNeedsUpgrade(keystore: EncryptedKeystore): boolean {
  return keystore.version < KEYSTORE_VERSION;
}

export async function decryptKeystore(
  keystore: EncryptedKeystore,
  passphrase: string,
): Promise<string> {
  if (!SCRYPT_PARAMS[keystore.version]) {
    throw new Error(
      `Unsupported keystore version: ${keystore.version} (supported: ${Object.keys(SCRYPT_PARAMS).join(', ')})`,
    );
  }

  // Derive key using the version-specific scrypt parameters
  const key = deriveEncryptionKey(passphrase, keystore.salt, keystore.version);

  // Reconstruct sealed message (ciphertext + tag)
  const sealed = new Uint8Array(
    keystore.ciphertext.length + keystore.tag.length,
  );
  sealed.set(keystore.ciphertext);
  sealed.set(keystore.tag, keystore.ciphertext.length);

  const cipher = chacha20poly1305(key, keystore.nonce);

  try {
    const plaintext = cipher.decrypt(sealed);
    return decoder.decode(plaintext);
  } catch {
    throw new Error('Decryption failed: invalid passphrase or corrupted keystore');
  } finally {
    key.fill(0);
  }
}

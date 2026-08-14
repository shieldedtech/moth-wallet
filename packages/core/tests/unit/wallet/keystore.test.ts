import { describe, it, expect, beforeAll } from 'vitest';
import { encryptKeystore, decryptKeystore, type EncryptedKeystore } from '../../../src/wallet/keystore.js';

// Every encrypt and decrypt here runs scrypt at the v2 parameter N=2^18 (~256 MiB,
// ~300ms), which is the security control working as designed — so the cost is not
// a thing to optimise away, only to stop paying more times than the assertions
// need. The round-trip test keeps its own independent encrypt+decrypt so the
// full-strength path is exercised end to end; the shape and tamper-detection
// tests share one keystore, since re-deriving a key proves nothing they assert.
describe('Encrypted Keystore', () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const passphrase = 'test-passphrase-2026';

  let shared: EncryptedKeystore;

  beforeAll(async () => {
    shared = await encryptKeystore(testMnemonic, passphrase);
  });

  it('should encrypt and decrypt a mnemonic round-trip', async () => {
    const encrypted = await encryptKeystore(testMnemonic, passphrase);
    const decrypted = await decryptKeystore(encrypted, passphrase);
    expect(decrypted).toBe(testMnemonic);
  });

  it('should produce a keystore with required fields', () => {
    expect(shared.version).toBe(2);
    expect(shared.algorithm).toBe('chacha20-poly1305');
    expect(shared.salt).toBeInstanceOf(Uint8Array);
    expect(shared.nonce).toBeInstanceOf(Uint8Array);
    expect(shared.ciphertext).toBeInstanceOf(Uint8Array);
    expect(shared.tag).toBeInstanceOf(Uint8Array);
  });

  it('should reject wrong passphrase', async () => {
    await expect(
      decryptKeystore(shared, 'wrong-passphrase'),
    ).rejects.toThrow();
  });

  it('should detect corruption (tampered ciphertext)', async () => {
    const tampered = {
      ...shared,
      ciphertext: new Uint8Array(shared.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;

    await expect(
      decryptKeystore(tampered, passphrase),
    ).rejects.toThrow();
  });

  it('should detect corruption (tampered tag)', async () => {
    const tampered = {
      ...shared,
      tag: new Uint8Array(shared.tag),
    };
    tampered.tag[0] ^= 0xff;

    await expect(
      decryptKeystore(tampered, passphrase),
    ).rejects.toThrow();
  });

  // Both keystores must be freshly encrypted: the property under test is that a
  // second encryption of the same input draws a new salt and nonce.
  it('should produce different ciphertext for same input (random salt/nonce)', async () => {
    const enc2 = await encryptKeystore(testMnemonic, passphrase);
    expect(shared.ciphertext).not.toEqual(enc2.ciphertext);
    expect(shared.salt).not.toEqual(enc2.salt);
    expect(shared.nonce).not.toEqual(enc2.nonce);
  });

  it('should handle empty mnemonic', async () => {
    const encrypted = await encryptKeystore('', passphrase);
    const decrypted = await decryptKeystore(encrypted, passphrase);
    expect(decrypted).toBe('');
  });
});

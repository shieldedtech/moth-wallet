import { describe, it, expect } from 'vitest';
import { encryptKeystore, decryptKeystore } from '../../../src/wallet/keystore.js';

describe('Encrypted Keystore', () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const passphrase = 'test-passphrase-2026';

  it('should encrypt and decrypt a mnemonic round-trip', async () => {
    const encrypted = await encryptKeystore(testMnemonic, passphrase);
    const decrypted = await decryptKeystore(encrypted, passphrase);
    expect(decrypted).toBe(testMnemonic);
  });

  it('should produce a keystore with required fields', async () => {
    const encrypted = await encryptKeystore(testMnemonic, passphrase);
    expect(encrypted.version).toBe(2);
    expect(encrypted.algorithm).toBe('chacha20-poly1305');
    expect(encrypted.salt).toBeInstanceOf(Uint8Array);
    expect(encrypted.nonce).toBeInstanceOf(Uint8Array);
    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encrypted.tag).toBeInstanceOf(Uint8Array);
  });

  it('should reject wrong passphrase', async () => {
    const encrypted = await encryptKeystore(testMnemonic, passphrase);
    await expect(
      decryptKeystore(encrypted, 'wrong-passphrase'),
    ).rejects.toThrow();
  });

  it('should detect corruption (tampered ciphertext)', async () => {
    const encrypted = await encryptKeystore(testMnemonic, passphrase);
    // Tamper with ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: new Uint8Array(encrypted.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;

    await expect(
      decryptKeystore(tampered, passphrase),
    ).rejects.toThrow();
  });

  it('should detect corruption (tampered tag)', async () => {
    const encrypted = await encryptKeystore(testMnemonic, passphrase);
    const tampered = {
      ...encrypted,
      tag: new Uint8Array(encrypted.tag),
    };
    tampered.tag[0] ^= 0xff;

    await expect(
      decryptKeystore(tampered, passphrase),
    ).rejects.toThrow();
  });

  it('should produce different ciphertext for same input (random salt/nonce)', async () => {
    const enc1 = await encryptKeystore(testMnemonic, passphrase);
    const enc2 = await encryptKeystore(testMnemonic, passphrase);
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
    expect(enc1.salt).not.toEqual(enc2.salt);
    expect(enc1.nonce).not.toEqual(enc2.nonce);
  });

  it('should handle empty mnemonic', async () => {
    const encrypted = await encryptKeystore('', passphrase);
    const decrypted = await decryptKeystore(encrypted, passphrase);
    expect(decrypted).toBe('');
  });
});

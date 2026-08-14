/**
 * deriveAppSecret (dApp connector extension). Verifies the six security
 * properties from specs/003-derive-app-secret/spec.md §6: determinism,
 * portability (same seed ⇒ same secret), domain separation, origin isolation,
 * privacy (independent of public data), and key isolation.
 */

import { describe, it, expect } from 'vitest';
import { mnemonicToSeed } from '../../../src/wallet/mnemonic.js';
import { deriveAppSecret } from '../../../src/wallet/app-secret.js';
import { deriveRawKeys, deriveAllAddressesFromSeed, Roles } from '../../../src/wallet/address.js';
import { TEST_MNEMONIC } from '../../helpers/seed.js';

// A different, valid BIP-39 24-word mnemonic (all-"abandon" with the correct
// final checksum word) — the "different seed" case.
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

const ORIGIN = 'https://attested.me';
const DOMAIN = 'names-deed:v1';

const hex = (u: Uint8Array): string =>
  Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');

async function seedHex(mnemonic: string = TEST_MNEMONIC): Promise<string> {
  return hex(await mnemonicToSeed(mnemonic));
}

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(digest));
}

describe('deriveAppSecret', () => {
  it('1. determinism — same (seed, origin, domain) yields the same 32-byte hex secret', async () => {
    const sh = await seedHex();
    const a = await deriveAppSecret(sh, ORIGIN, DOMAIN);
    const b = await deriveAppSecret(sh, ORIGIN, DOMAIN);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('2. portability — the same seed reproduces the secret; a different seed does not', async () => {
    // deriveAppSecret is pure over the seed, so a second wallet instance built
    // from the same mnemonic (the cross-device case) produces the identical
    // value. Simulated by deriving the seed independently from the mnemonic.
    const sh1 = await seedHex();
    const sh2 = await seedHex();
    expect(await deriveAppSecret(sh2, ORIGIN, DOMAIN)).toBe(await deriveAppSecret(sh1, ORIGIN, DOMAIN));
    const other = await seedHex(OTHER_MNEMONIC);
    expect(await deriveAppSecret(other, ORIGIN, DOMAIN)).not.toBe(await deriveAppSecret(sh1, ORIGIN, DOMAIN));
  });

  it('3. domain separation — different domain ⇒ different secret', async () => {
    const sh = await seedHex();
    expect(await deriveAppSecret(sh, ORIGIN, 'a:v1')).not.toBe(await deriveAppSecret(sh, ORIGIN, 'b:v1'));
  });

  it('4. origin isolation — different origin ⇒ different secret', async () => {
    const sh = await seedHex();
    expect(await deriveAppSecret(sh, 'https://a.example', DOMAIN)).not.toBe(
      await deriveAppSecret(sh, 'https://b.example', DOMAIN),
    );
  });

  it('5. privacy — independent of public data (not equal to any exposed address, nor a public-only hash)', async () => {
    const sh = await seedHex();
    const secret = await deriveAppSecret(sh, ORIGIN, DOMAIN);

    // Not equal to any public bech32m address the wallet exposes.
    const addrs = deriveAllAddressesFromSeed(sh);
    for (const enc of Object.values(addrs)) {
      for (const addr of Object.values(enc.bech32m ?? {})) {
        expect(secret).not.toBe(addr);
      }
    }

    // Crucially, NOT recomputable from public inputs alone — this is the flaw
    // in the SHA-256(publicValue ‖ domain) approach it replaces.
    expect(secret).not.toBe(await sha256hex(`${ORIGIN}|${DOMAIN}`));
    for (const enc of Object.values(addrs)) {
      for (const addr of Object.values(enc.bech32m ?? {})) {
        expect(secret).not.toBe(await sha256hex(`${addr}${DOMAIN}`));
      }
    }
  });

  it('6. key isolation — output is not, and does not reveal, any raw role key (incl. the IKM)', async () => {
    const sh = await seedHex();
    const secret = await deriveAppSecret(sh, ORIGIN, DOMAIN);
    const keys = deriveRawKeys(sh);
    expect(secret).not.toBe(hex(keys[Roles.NightExternal]));
    expect(secret).not.toBe(hex(keys[Roles.Zswap]));
    expect(secret).not.toBe(hex(keys[Roles.Dust]));
    // Even the IKM (Metadata role key) must not be recoverable from the output.
    const ikmHex = hex(keys[Roles.Metadata]);
    expect(secret).not.toBe(ikmHex);
    expect(ikmHex).not.toContain(secret);
    expect(secret).not.toContain(ikmHex);
  });
});

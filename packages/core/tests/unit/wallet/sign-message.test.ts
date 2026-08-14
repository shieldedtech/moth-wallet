/**
 * Message signing (dApp connector `signData`). Verifies the domain-separation
 * prefix is applied and that signatures verify against the exact prefixed bytes
 * via the ledger's own verifier — and, crucially, do NOT verify against the raw
 * unprefixed data (the property that stops a signed message being a valid tx).
 */

import { describe, it, expect } from 'vitest';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { signMessage, signedMessageBytes } from '../../../src/wallet/sign-message.js';
import { testSeedHex as seedHex } from '../../helpers/seed.js';

describe('signMessage', () => {
  it('prepends the midnight_signed_message prefix with the decoded byte length', () => {
    const out = signedMessageBytes(new Uint8Array([1, 2, 3]));
    expect(new TextDecoder().decode(out.slice(0, 26))).toBe('midnight_signed_message:3:');
    expect(Array.from(out.slice(-3))).toEqual([1, 2, 3]);
  });

  it('signs text and verifies against the prefixed bytes', async () => {
    const { signature, verifyingKey, data } = signMessage(await seedHex(), 'devnet', 'hello world', 'text');
    expect(data).toBe('hello world');
    const payload = signedMessageBytes(new TextEncoder().encode('hello world'));
    expect(ledger.verifySignature(verifyingKey, payload, signature)).toBe(true);
  });

  it('does not verify against the raw unprefixed data (domain separation)', async () => {
    const { signature, verifyingKey } = signMessage(await seedHex(), 'devnet', 'abcd', 'hex');
    expect(ledger.verifySignature(verifyingKey, new Uint8Array([0xab, 0xcd]), signature)).toBe(false);
  });

  it('treats hex and base64 as the same underlying bytes', async () => {
    const sh = await seedHex();
    const payload = signedMessageBytes(new TextEncoder().encode('hello'));
    const fromHex = signMessage(sh, 'devnet', '68656c6c6f', 'hex'); // "hello"
    const fromB64 = signMessage(sh, 'devnet', 'aGVsbG8=', 'base64'); // "hello"
    expect(ledger.verifySignature(fromHex.verifyingKey, payload, fromHex.signature)).toBe(true);
    expect(ledger.verifySignature(fromB64.verifyingKey, payload, fromB64.signature)).toBe(true);
  });

  it('rejects malformed hex and base64', async () => {
    const sh = await seedHex();
    expect(() => signMessage(sh, 'devnet', 'xyz', 'hex')).toThrow();
    expect(() => signMessage(sh, 'devnet', '!!!!', 'base64')).toThrow();
  });

  it('derives a network-independent verifying key', async () => {
    const sh = await seedHex();
    expect(signMessage(sh, 'devnet', 'x', 'text').verifyingKey).toBe(
      signMessage(sh, 'mainnet', 'x', 'text').verifyingKey,
    );
  });
});

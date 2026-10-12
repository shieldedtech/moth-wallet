import { describe, expect, it } from 'vitest';
import {
  canRegisterForDust,
  CardanoNetworkUnavailableError,
  effectiveCardanoNetwork,
  isLocalMidnightNetwork,
  resolveCardanoNetwork,
  TestPairingRegistrationError,
} from '../../../src/cardano/network.js';
import { parseTestPairing } from '../../../src/cardano/config.js';
import { deregisterFromDust, registerForDust, updateDustAddress } from '../../../src/cardano/registration.js';
import type { CardanoSession } from '../../../src/cardano/session.js';

// A local Midnight network has no Cardano bridge. It may be paired with a Cardano
// testnet for testing payments and signing, never for DUST registration.
describe('test pairing for local Midnight networks', () => {
  it('applies only to local networks, only Preprod or Preview', () => {
    expect(isLocalMidnightNetwork('undeployed')).toBe(true);
    expect(isLocalMidnightNetwork('preprod')).toBe(false);
    expect(effectiveCardanoNetwork('undeployed', 'Preprod')).toBe('Preprod');
    expect(effectiveCardanoNetwork('devnet', 'Preview')).toBe('Preview');
    expect(effectiveCardanoNetwork('qanet')).toBeNull();
    // Never Mainnet, even if asked.
    expect(effectiveCardanoNetwork('undeployed', 'Mainnet')).toBeNull();
  });

  it('never overrides a bridge pairing', () => {
    expect(effectiveCardanoNetwork('preprod', 'Preview')).toBe('Preprod');
    expect(effectiveCardanoNetwork('mainnet', 'Preprod')).toBe('Mainnet');
    const c = resolveCardanoNetwork('preview', { testPairing: 'Preprod' });
    expect(c.network).toBe('Preview');
    expect(c.testPairing).toBeUndefined();
    expect(canRegisterForDust(c)).toBe(true);
  });

  it('marks the resolved config as a test pairing, which cannot register', () => {
    const c = resolveCardanoNetwork('undeployed', { testPairing: 'Preprod' });
    expect(c.network).toBe('Preprod');
    expect(c.cnightPolicyId).toBe('d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1');
    expect(c.testPairing).toBe(true);
    expect(canRegisterForDust(c)).toBe(false);
    expect(() => resolveCardanoNetwork('undeployed')).toThrow(CardanoNetworkUnavailableError);
  });

  it('refuses registration, update and deregistration on a test pairing before touching the chain', async () => {
    const config = resolveCardanoNetwork('undeployed', { testPairing: 'Preprod' });
    // Any chain access would throw a different error: the guard must come first.
    const session = { config, lucid: new Proxy({}, { get: () => { throw new Error('touched the chain'); } }), addresses: {} } as unknown as CardanoSession;
    await expect(registerForDust(session, 'x')).rejects.toBeInstanceOf(TestPairingRegistrationError);
    await expect(updateDustAddress(session, 'x')).rejects.toBeInstanceOf(TestPairingRegistrationError);
    await expect(deregisterFromDust(session)).rejects.toBeInstanceOf(TestPairingRegistrationError);
  });

  it('parses the CLI/env value case-insensitively and rejects Mainnet', () => {
    expect(parseTestPairing('preprod')).toBe('Preprod');
    expect(parseTestPairing(' PREVIEW ')).toBe('Preview');
    expect(parseTestPairing('mainnet')).toBeNull();
    expect(parseTestPairing('')).toBeNull();
    expect(parseTestPairing(undefined)).toBeNull();
  });
});

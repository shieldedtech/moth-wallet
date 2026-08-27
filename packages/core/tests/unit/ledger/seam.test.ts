/**
 * The ledger seam. Midnight is forking v8 -> v9, so one process may need both.
 * Loading is async because the modules are WASM; access is sync because key
 * derivation (wallet/address.ts) cannot await. See ADR-0006.
 */

import {describe, expect, it, beforeEach} from 'vitest';
import {
  initLedger,
  ledger,
  ledgerFor,
  activeLedgerVersion,
  resetLedgerRegistry,
} from '../../../src/ledger/index.js';

describe('ledger seam', () => {
  beforeEach(() => resetLedgerRegistry());

  it('refuses sync access before anything is loaded, rather than guessing', () => {
    expect(() => ledger()).toThrow(/initLedger/);
  });

  it('loads v8 and then serves it synchronously', async () => {
    await initLedger('v8');
    expect(activeLedgerVersion()).toBe('v8');
    expect(typeof ledger().ZswapSecretKeys.fromSeed).toBe('function');
  });

  it('loads v9 and then serves it synchronously', async () => {
    await initLedger('v9');
    expect(activeLedgerVersion()).toBe('v9');
    expect(typeof ledger().ZswapSecretKeys.fromSeed).toBe('function');
  });

  it('caches: initialising the same version twice yields the same module object', async () => {
    const first = await initLedger('v8');
    const second = await initLedger('v8');
    expect(second).toBe(first);
  });

  it('holds both ledgers at once, as distinct modules', async () => {
    const v8 = await initLedger('v8');
    const v9 = await initLedger('v9');
    expect(v8).not.toBe(v9);
    expect(ledgerFor('v8')).toBe(v8);
    expect(ledgerFor('v9')).toBe(v9);
  });

  it('keeps the two ledgers at distinct class identity, so objects never cross', async () => {
    // Mirrors the upstream coexistence spike (midnight-wallet#629): a v8 value
    // must not satisfy a v9 instanceof, or the seam would silently mix them.
    const v8 = await initLedger('v8');
    const v9 = await initLedger('v9');
    const seed = new Uint8Array(32).fill(7);
    const k8 = v8.ZswapSecretKeys.fromSeed(seed);
    expect(k8).not.toBeInstanceOf(v9.ZswapSecretKeys);
  });

  it('tracks the most recently initialised version as current', async () => {
    await initLedger('v8');
    await initLedger('v9');
    expect(activeLedgerVersion()).toBe('v9');
  });

  it('refuses a version that was never loaded', async () => {
    await initLedger('v8');
    expect(() => ledgerFor('v9')).toThrow(/not loaded/i);
  });
});

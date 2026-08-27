/**
 * The ledger/network guard. A wallet holding the wrong ledger for a network
 * must refuse before it transacts, with an error that says what is wrong.
 *
 * This matters more than it looks: the fork is partial. Collapsed Merkle
 * updates are shared across v8 and v9, so a mismatched wallet syncs happily
 * and only fails when it reaches a transaction — late, and with a header-tag
 * error that explains nothing. See ADR-0006.
 */

import {describe, expect, it} from 'vitest';
import {
  PROTOCOL_VERSION_V8,
  PROTOCOL_VERSION_V9,
  ledgerVersionForProtocol,
  assertLedgerForNetwork,
  verifyNetworkLedger,
} from '../../../src/ledger/protocol-version.js';

describe('ledgerVersionForProtocol', () => {
  it('maps the two known protocol versions', () => {
    expect(ledgerVersionForProtocol(PROTOCOL_VERSION_V8)).toBe('v8');
    expect(ledgerVersionForProtocol(PROTOCOL_VERSION_V9)).toBe('v9');
  });

  it('returns undefined for a version it does not know, rather than guessing', () => {
    expect(ledgerVersionForProtocol(3_000_000)).toBeUndefined();
    expect(ledgerVersionForProtocol(0)).toBeUndefined();
  });
});

describe('assertLedgerForNetwork', () => {
  it('passes when the wallet ledger matches the network', () => {
    expect(() =>
      assertLedgerForNetwork({networkId: 'preprod', using: 'v8', observedProtocolVersion: PROTOCOL_VERSION_V8}),
    ).not.toThrow();
    expect(() =>
      assertLedgerForNetwork({networkId: 'devnet', using: 'v9', observedProtocolVersion: PROTOCOL_VERSION_V9}),
    ).not.toThrow();
  });

  it('refuses a v8 wallet on a v9 network, naming both sides', () => {
    let msg = '';
    try {
      assertLedgerForNetwork({networkId: 'devnet', using: 'v8', observedProtocolVersion: PROTOCOL_VERSION_V9});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('devnet');
    expect(msg).toContain('v9');
    expect(msg).toContain('v8');
    // The user's real question is "did anything happen?"
    expect(msg).toMatch(/nothing was submitted/i);
  });

  it('refuses a v9 wallet on a v8 network', () => {
    expect(() =>
      assertLedgerForNetwork({networkId: 'preprod', using: 'v9', observedProtocolVersion: PROTOCOL_VERSION_V8}),
    ).toThrow(/preprod/);
  });

  it('refuses an unrecognised protocol version instead of assuming a ledger', () => {
    expect(() =>
      assertLedgerForNetwork({networkId: 'futurenet', using: 'v9', observedProtocolVersion: 3_000_000}),
    ).toThrow(/3000000|unrecognised|unknown/i);
  });

  it('throws a WalletError so callers can categorise it', () => {
    try {
      assertLedgerForNetwork({networkId: 'devnet', using: 'v8', observedProtocolVersion: PROTOCOL_VERSION_V9});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as {category?: string}).category).toBeDefined();
    }
  });
});

describe('verifyNetworkLedger', () => {
  const devnet = {id: 'devnet', indexerUrl: 'https://indexer.devnet.example/api/v4/graphql'};

  it('passes when the network confirms the loaded ledger', async () => {
    await expect(
      verifyNetworkLedger(devnet, {using: 'v9', probe: async () => PROTOCOL_VERSION_V9}),
    ).resolves.toBeUndefined();
  });

  it('rejects when the network is on the other ledger', async () => {
    await expect(
      verifyNetworkLedger(devnet, {using: 'v8', probe: async () => PROTOCOL_VERSION_V9}),
    ).rejects.toThrow(/nothing was submitted/i);
  });

  it('rejects when the network reports no protocol version at all', async () => {
    await expect(
      verifyNetworkLedger(devnet, {using: 'v9', probe: async () => undefined}),
    ).rejects.toThrow(/did not report/i);
  });
});

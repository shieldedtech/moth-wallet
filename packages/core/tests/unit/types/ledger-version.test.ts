/**
 * Ledger-version and faucet fields on NetworkConfig, and the stagenet preset.
 * Midnight is forking v8 -> v9, so every network has to say which ledger it
 * speaks; the default stays v8 so existing configs keep their behavior.
 */

import {describe, expect, it} from 'vitest';
import {
  DEFAULT_NETWORKS,
  SUPPORTED_NETWORKS,
  resolveLedgerVersion,
  validateNetworkConfig,
  type NetworkConfig,
} from '../../../src/types/network.js';

const endpoints = {
  id: 'devnet',
  nodeUrl: 'https://rpc.devnet.midnight.network',
  indexerUrl: 'https://indexer.devnet.midnight.network/api/v4/graphql',
  prover: {type: 'server', url: 'http://localhost:6300'},
} as const satisfies NetworkConfig;

describe('ledger version', () => {
  it('defaults to v8 when a config does not say', () => {
    expect(resolveLedgerVersion(endpoints)).toBe('v8');
  });

  it('honors an explicit version', () => {
    expect(resolveLedgerVersion({...endpoints, ledgerVersion: 'v9'})).toBe('v9');
  });

  it('marks stagenet as a v9 network', () => {
    expect(resolveLedgerVersion(DEFAULT_NETWORKS.stagenet!)).toBe('v9');
  });

  it('keeps mainnet on v8 — it is still reporting protocol 1000000', () => {
    expect(resolveLedgerVersion(DEFAULT_NETWORKS.mainnet!)).toBe('v8');
  });
});

describe('stagenet preset', () => {
  it('carries all three stagenet services', () => {
    const stagenet = DEFAULT_NETWORKS.stagenet!;
    expect(stagenet.nodeUrl).toBe('https://rpc.stagenet.shielded.tools');
    expect(stagenet.indexerUrl).toBe('https://indexer.stagenet.shielded.tools/api/v4/graphql');
    expect(stagenet.faucetUrl).toBe('https://faucet.stagenet.shielded.tools');
  });

  it('is offered as a supported network', () => {
    expect(SUPPORTED_NETWORKS).toContain('stagenet');
  });

  it('validates', () => {
    expect(() => validateNetworkConfig(DEFAULT_NETWORKS.stagenet!)).not.toThrow();
  });
});

describe('faucet URL validation', () => {
  it('rejects a faucet URL with a disallowed scheme', () => {
    const config: NetworkConfig = {...endpoints, faucetUrl: 'file:///etc/passwd'};
    expect(() => validateNetworkConfig(config)).toThrow(/Faucet URL/);
  });

  it('accepts a config with no faucet at all', () => {
    expect(() => validateNetworkConfig(endpoints)).not.toThrow();
  });
});

/**
 * Deriving the ledger from what the network reports, rather than from a table
 * Moth ships. The table goes stale the moment a network forks — devnet forked
 * and Moth was wrong about it until someone noticed — and when preprod forks
 * every install is wrong until a release goes out.
 *
 * Detection must never stop a wallet starting: an unreachable indexer or a
 * protocol version we do not recognise falls back to the configured value. The
 * strict refusal belongs at submission, where verifyNetworkLedger runs live.
 */

import {describe, expect, it, beforeEach} from 'vitest';
import {
  detectLedgerVersion,
  resetLedgerDetectionCache,
  PROTOCOL_VERSION_V8,
  PROTOCOL_VERSION_V9,
} from '../../../src/ledger/protocol-version.js';

const devnet = {id: 'devnet', indexerUrl: 'https://indexer.example/graphql', ledgerVersion: 'v9'} as const;
const preprod = {id: 'preprod', indexerUrl: 'https://indexer.example/graphql', ledgerVersion: 'v8'} as const;

describe('detectLedgerVersion', () => {
  beforeEach(() => resetLedgerDetectionCache());

  it('uses what the network reports', async () => {
    const got = await detectLedgerVersion(preprod, {probe: async () => PROTOCOL_VERSION_V9});
    expect(got).toEqual({version: 'v9', source: 'network', observedProtocolVersion: PROTOCOL_VERSION_V9});
  });

  it('catches a network that has forked past its configured version', async () => {
    // The preprod-fork case: config still says v8, the chain says otherwise.
    const got = await detectLedgerVersion(preprod, {probe: async () => PROTOCOL_VERSION_V9});
    expect(got.version).toBe('v9');
    expect(got.source).toBe('network');
  });

  it('falls back to the configured version when the indexer is unreachable', async () => {
    const got = await detectLedgerVersion(devnet, {
      probe: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(got).toEqual({version: 'v9', source: 'config'});
  });

  it('falls back when the protocol version is one we do not recognise', async () => {
    const got = await detectLedgerVersion(preprod, {probe: async () => 3_000_000});
    expect(got).toEqual({version: 'v8', source: 'config', observedProtocolVersion: 3_000_000});
  });

  it('defaults to v8 when neither the network nor the config says', async () => {
    const bare = {id: 'local', indexerUrl: 'http://localhost:8088/graphql'};
    const got = await detectLedgerVersion(bare, {probe: async () => undefined});
    expect(got).toEqual({version: 'v8', source: 'config'});
  });

  it('does not let an endpoint override inherit what the preset reported', async () => {
    const preset = {id: 'undeployed', indexerUrl: 'http://localhost:8088/api/v4/graphql'};
    const overridden = {id: 'undeployed', indexerUrl: 'http://localhost:8110/api/v4/graphql'};
    await detectLedgerVersion(preset, {probe: async () => PROTOCOL_VERSION_V8});
    const got = await detectLedgerVersion(overridden, {probe: async () => 2_001_000});
    expect(got).toEqual({version: 'v9', source: 'network', observedProtocolVersion: 2_001_000});
  });

  it('forgets every endpoint of a network on reset', async () => {
    const a = {id: 'undeployed', indexerUrl: 'http://a/graphql'};
    const b = {id: 'undeployed', indexerUrl: 'http://b/graphql'};
    await detectLedgerVersion(a, {probe: async () => PROTOCOL_VERSION_V8});
    await detectLedgerVersion(b, {probe: async () => PROTOCOL_VERSION_V8});
    resetLedgerDetectionCache('undeployed');
    expect((await detectLedgerVersion(a, {probe: async () => PROTOCOL_VERSION_V9})).version).toBe('v9');
    expect((await detectLedgerVersion(b, {probe: async () => PROTOCOL_VERSION_V9})).version).toBe('v9');
  });

  it('probes a network once and reuses the answer', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return PROTOCOL_VERSION_V9;
    };
    await detectLedgerVersion(devnet, {probe});
    await detectLedgerVersion(devnet, {probe});
    expect(calls).toBe(1);
  });

  it('caches per network, not globally', async () => {
    await detectLedgerVersion(devnet, {probe: async () => PROTOCOL_VERSION_V9});
    const got = await detectLedgerVersion(preprod, {probe: async () => PROTOCOL_VERSION_V8});
    expect(got.version).toBe('v8');
  });
});

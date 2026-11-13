import {describe, expect, it} from 'vitest';
import {
  canonicalNetworkId,
  DEFAULT_NETWORKS,
  describeProver,
  proverConfigsEqual,
  resolveProverConfig,
  SUPPORTED_NETWORKS,
  validateNetworkConfig,
  type NetworkConfig,
} from '../../../src/types/network.js';

const endpoints = {
  id: 'devnet',
  nodeUrl: 'https://rpc.devnet.shielded.tools',
  indexerUrl: 'https://indexer.devnet.shielded.tools/api/v4/graphql',
};

describe('prover network configuration', () => {
  it('keeps proof-server proving as the maintained default', () => {
    expect(resolveProverConfig(DEFAULT_NETWORKS.devnet!)).toEqual({
      type: 'server',
      url: 'http://localhost:6300',
    });
  });

  it('accepts local WASM proving without a proof-server URL', () => {
    const config: NetworkConfig = {...endpoints, prover: {type: 'wasm'}};
    expect(() => validateNetworkConfig(config)).not.toThrow();
    expect(describeProver(resolveProverConfig(config))).toBe('WASM (local)');
  });

  it('validates a configured proof-server URL', () => {
    const config: NetworkConfig = {...endpoints, prover: {type: 'server', url: 'file:///tmp/prover'}};
    expect(() => validateNetworkConfig(config)).toThrow('scheme "file:" not allowed');
  });

  it('normalizes the legacy proofServerUrl shape', () => {
    const config: NetworkConfig = {...endpoints, proofServerUrl: 'https://proof.example'};
    expect(resolveProverConfig(config)).toEqual({type: 'server', url: 'https://proof.example'});
  });

  it('compares server URLs as well as prover modalities', () => {
    expect(proverConfigsEqual({type: 'wasm'}, {type: 'wasm'})).toBe(true);
    expect(proverConfigsEqual({type: 'server', url: 'https://a'}, {type: 'server', url: 'https://b'})).toBe(false);
    expect(proverConfigsEqual({type: 'wasm'}, {type: 'server', url: 'https://a'})).toBe(false);
  });
});

// The two lists drifted once already: `undeployed` had a preset no interface
// could select. Holding them equal makes either mistake a
// test failure rather than a network that silently cannot be reached.
describe('supported networks', () => {
  it('offers exactly the networks that have a preset', () => {
    expect([...SUPPORTED_NETWORKS].sort()).toEqual(Object.keys(DEFAULT_NETWORKS).sort());
  });

  it('gives every offered network a preset whose id matches its key', () => {
    for (const id of SUPPORTED_NETWORKS) {
      expect(DEFAULT_NETWORKS[id]?.id, `preset for ${id}`).toBe(id);
    }
  });

  it('points the local devnet stack at the port the stack listens on', () => {
    // 9944 is what the compose stack, docs/TESTING.md, and every localhost
    // fallback in the repo use.
    expect(DEFAULT_NETWORKS.undeployed!.nodeUrl).toBe('ws://localhost:9944');
    expect(DEFAULT_NETWORKS.undeployed!.indexerUrl).toBe('http://localhost:8088/api/v4/graphql');
  });

  it('points local at midnight-node local-env, which serves node-1 on 9933', () => {
    expect(DEFAULT_NETWORKS.local!.nodeUrl).toBe('ws://localhost:9933');
    expect(DEFAULT_NETWORKS.local!.indexerUrl).toBe('http://localhost:8088/api/v4/graphql');
  });
});

describe('canonicalNetworkId', () => {
  it('keeps local as its own network rather than folding it into undeployed', () => {
    // local-env's addresses are `mn_addr_local1…`; renaming the id derives the
    // wrong HRP and every unshielded balance reads zero.
    expect(canonicalNetworkId('local')).toBe('local');
  });

  it('leaves every offered network id untouched', () => {
    for (const id of SUPPORTED_NETWORKS) {
      expect(canonicalNetworkId(id)).toBe(id);
    }
  });

  it('returns a string for keys that exist on Object.prototype', () => {
    // Network ids are not restricted to a known list, so an arbitrary string
    // reaches here from `--network`. An object-literal lookup answers these from
    // the prototype chain, putting a function where a string is declared and
    // sending it on to the providers' network id, socket paths and JSON output.
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(typeof canonicalNetworkId(key), `canonicalNetworkId(${key})`).toBe('string');
      expect(canonicalNetworkId(key)).toBe(key);
    }
  });

  it('passes through ids it does not know, including the empty string', () => {
    // Custom and unlisted ids are legitimate — endpoints are overridable and
    // `stagenet` has addresses but no preset — so this must not gate on a list.
    expect(canonicalNetworkId('stagenet')).toBe('stagenet');
    expect(canonicalNetworkId('some-future-net')).toBe('some-future-net');
    expect(canonicalNetworkId('')).toBe('');
  });
});

describe('hosted network presets', () => {
  // Written out rather than read from the presets, so a mistyped or retired host
  // fails here instead of being copied in. preview stays on midnight.network
  // because its shielded.tools hosts have no DNS records yet.
  it.each([
    ['mainnet', 'https://rpc.mainnet.shielded.tools', 'https://indexer.mainnet.shielded.tools/api/v4/graphql'],
    ['preprod', 'https://rpc.preprod.shielded.tools', 'https://indexer.preprod.shielded.tools/api/v4/graphql'],
    ['preview', 'https://rpc.preview.midnight.network', 'https://indexer.preview.midnight.network/api/v4/graphql'],
    ['qanet', 'https://rpc.qanet.shielded.tools', 'https://indexer.qanet.shielded.tools/api/v4/graphql'],
    ['devnet', 'https://rpc.devnet.shielded.tools', 'https://indexer.devnet.shielded.tools/api/v4/graphql'],
  ] as const)("points %s at that network's published node and indexer", (id, nodeUrl, indexerUrl) => {
    expect(DEFAULT_NETWORKS[id]).toMatchObject({id, nodeUrl, indexerUrl});
  });
});

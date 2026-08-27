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
  nodeUrl: 'https://rpc.devnet.midnight.network',
  indexerUrl: 'https://indexer.devnet.midnight.network/api/v4/graphql',
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
// could select, and `local` was offered against a preset pointing at a node port
// the local stack does not listen on. Holding them equal makes either mistake a
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
    // fallback in the repo use. The retired `local` preset said 9933.
    expect(DEFAULT_NETWORKS.undeployed!.nodeUrl).toBe('ws://localhost:9944');
    expect(DEFAULT_NETWORKS.undeployed!.indexerUrl).toBe('http://localhost:8088/api/v4/graphql');
  });
});

describe('canonicalNetworkId', () => {
  it('resolves the retired local id to undeployed', () => {
    expect(canonicalNetworkId('local')).toBe('undeployed');
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
    // sending it on to setNetworkId(), socket paths and JSON output.
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(typeof canonicalNetworkId(key), `canonicalNetworkId(${key})`).toBe('string');
      expect(canonicalNetworkId(key)).toBe(key);
    }
  });

  it('passes through ids it does not know, including the empty string', () => {
    // Custom and unlisted ids are legitimate — endpoints are overridable and
    // future networks may have addresses before they gain a preset — so this
    // must not gate on the current supported-network list.
    expect(canonicalNetworkId('some-future-net')).toBe('some-future-net');
    expect(canonicalNetworkId('')).toBe('');
  });
});

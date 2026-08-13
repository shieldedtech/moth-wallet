import {describe, expect, it} from 'vitest';
import {
  DEFAULT_NETWORKS,
  describeProver,
  proverConfigsEqual,
  resolveProverConfig,
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

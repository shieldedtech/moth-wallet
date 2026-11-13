import {describe, expect, it} from 'vitest';
import {
  canonicalNetworkId,
  DEFAULT_NETWORKS,
  applyStoredProofServerPin,
  attestedServerProver,
  describeProver,
  isLoopbackProofServer,
  parseProofServerAttestation,
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

  it('treats two pins for the same URL as different provers', () => {
    const pin = {
      attestationHost: 'attestation.example',
      pin: {
        launchMeasurement: 'AA',
        imageId: 'bb',
        microcodeSvn: 1,
        snpfwSvn: 2,
        pcrs: {0: '00', 1: '01', 2: '02', 3: '03', 4: '04'},
        applicationDiskRoothash: 'cc',
      },
    };
    const other = {...pin, pin: {...pin.pin, launchMeasurement: 'ff'}};
    expect(proverConfigsEqual(attestedServerProver('https://proof.example', pin), attestedServerProver('https://proof.example', pin))).toBe(true);
    expect(proverConfigsEqual(
      attestedServerProver('https://proof.example', pin),
      attestedServerProver('https://proof.example', {...pin, pin: {...pin.pin, launchMeasurement: 'aa'}}),
    )).toBe(true);
    expect(proverConfigsEqual(attestedServerProver('https://proof.example', pin), attestedServerProver('https://proof.example', other))).toBe(false);
  });

  it('keeps a stored pin off the loopback proof server', () => {
    const pin = parseProofServerAttestation(JSON.stringify({
      attestationHost: 'attestation.example',
      pin: {
        launchMeasurement: 'aa',
        imageId: 'bb',
        microcodeSvn: 1,
        snpfwSvn: 2,
        pcrs: {0: '00', 1: '01', 2: '02', 3: '03', 4: '04'},
        applicationDiskRoothash: 'cc',
      },
    }));
    expect(isLoopbackProofServer('http://localhost:6300')).toBe(true);
    expect(isLoopbackProofServer('https://proof.example')).toBe(false);
    expect(applyStoredProofServerPin({type: 'server', url: 'http://localhost:6300'}, pin)).toEqual({
      type: 'server',
      url: 'http://localhost:6300',
    });
    expect(applyStoredProofServerPin({type: 'server', url: 'https://proof.example'}, pin).attestation).toBe(pin);
    expect(describeProver(attestedServerProver('https://proof.example', pin))).toBe(
      'attested proof server (https://proof.example)',
    );
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
    // `stagenet` has addresses but no preset — so this must not gate on a list.
    expect(canonicalNetworkId('stagenet')).toBe('stagenet');
    expect(canonicalNetworkId('some-future-net')).toBe('some-future-net');
    expect(canonicalNetworkId('')).toBe('');
  });
});

// Measurements of the preprod proof server (Veritee registration 54399cab…,
// 2026-10-13). A fixture for the pin format, not a trusted default: these go
// stale when the proof server is redeployed, and no test here contacts it.
const PREPROD_PROOF_SERVER_URL = 'https://api.proofserver.wastedp.io';
const PREPROD_PIN_JSON = JSON.stringify({
  attestationHost: 'attestation.proofserver.wastedp.io',
  pin: {
    launchMeasurement: '11920f61def85094b343e12e306217e95dace3b19e1aaf9d116749e3655ee73a185f517b08a5fd932a04295a559591c4',
    imageId: '02000000000000000000000000000000',
    microcodeSvn: 88,
    snpfwSvn: 28,
    pcrs: {
      0: '372bf3434345039622a009784b504a488efd26a4d2d551d12e39d3ac7de232db',
      1: '3d458cfe55cc03ea1f443f1562beec8df51c75e14a9fcf9a7234a13f198e7969',
      2: '31bab2da1c9a8a6059eac59a4b7e5dec065190a834fce18beb34bf5ccd3e3443',
      3: '3d458cfe55cc03ea1f443f1562beec8df51c75e14a9fcf9a7234a13f198e7969',
      4: '52fafb48348f2e81ebfe8bc3e38a03675e46f7cff9ffd4ca7ffcfa0e8579c37c',
    },
    applicationDiskRoothash: '293fbfb711f9740037b374b3676a510bfedb16c04e7bd5accc62c0a72966f8a0',
  },
});

describe('preprod proof-server pin', () => {
  it('parses the pin as stored by `moth config set proof-server-pin`', () => {
    const attestation = parseProofServerAttestation(PREPROD_PIN_JSON);
    expect(attestation.attestationHost).toBe('attestation.proofserver.wastedp.io');
    expect(attestation.pin.microcodeSvn).toBe(88);
    expect(attestation.pin.snpfwSvn).toBe(28);
    expect(attestation.pin.pcrs[4]).toBe('52fafb48348f2e81ebfe8bc3e38a03675e46f7cff9ffd4ca7ffcfa0e8579c37c');
  });

  it('carries the field sizes the attestation verifier requires', () => {
    // The verifier rejects a pin whose hex fields are not exactly these sizes.
    const {pin} = parseProofServerAttestation(PREPROD_PIN_JSON);
    const hex = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
    expect(pin.launchMeasurement).toMatch(hex(48));
    expect(pin.imageId).toMatch(hex(16));
    expect(pin.applicationDiskRoothash).toMatch(hex(32));
    for (const index of [0, 1, 2, 3, 4] as const) expect(pin.pcrs[index]).toMatch(hex(32));
  });

  it('attaches to the preprod proof server', () => {
    const attestation = parseProofServerAttestation(PREPROD_PIN_JSON);
    const prover = applyStoredProofServerPin({type: 'server', url: PREPROD_PROOF_SERVER_URL}, attestation);
    expect(prover).toEqual({type: 'server', url: PREPROD_PROOF_SERVER_URL, attestation});
    expect(describeProver(prover)).toBe(`attested proof server (${PREPROD_PROOF_SERVER_URL})`);
    expect(isLoopbackProofServer(PREPROD_PROOF_SERVER_URL)).toBe(false);
  });

  it('stays off a local proof server', () => {
    const attestation = parseProofServerAttestation(PREPROD_PIN_JSON);
    expect(applyStoredProofServerPin({type: 'server', url: 'http://localhost:6300'}, attestation))
      .toEqual({type: 'server', url: 'http://localhost:6300'});
  });

  it('rejects the pin when a measurement field is missing', () => {
    const {pin, ...rest} = JSON.parse(PREPROD_PIN_JSON);
    const {applicationDiskRoothash: _dropped, ...partial} = pin;
    expect(() => parseProofServerAttestation(JSON.stringify({...rest, pin: partial})))
      .toThrow('Proof server pin is missing a host or a measurement field');
  });
});

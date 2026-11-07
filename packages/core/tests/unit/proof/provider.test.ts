import {describe, it, expect, afterEach} from 'vitest';
import {
  createProvingProvider,
  createWalletProvingService,
  ensureProverReady,
  setAttestedChannelFactory,
  setWasmProvingProviderFactory,
  type WasmKeyMaterialProvider,
} from '../../../src/proof/provider.js';
import {boundProvingProvider, type AttestedChannel} from '../../../src/proof/attested-channel.js';
import type {ProofServerAttestation} from '../../../src/types/network.js';

// Local (WASM) proving is single-threaded per provider, while the ledger asks
// for a transaction's proofs concurrently. Hosts with threads to spare install
// their own provider through the factory; these pin the seam they rely on.

const keyMaterial = {
  getZKIR: async () => new Uint8Array([1]),
  getProverKey: async () => new Uint8Array([2]),
  getVerifierKey: async () => new Uint8Array([3]),
};

const attestation: ProofServerAttestation = {
  attestationHost: 'attestation.example',
  pin: {
    launchMeasurement: 'aa',
    imageId: 'bb',
    microcodeSvn: 1,
    snpfwSvn: 2,
    pcrs: {0: '00', 1: '01', 2: '02', 3: '03', 4: '04'},
    applicationDiskRoothash: 'cc',
  },
};

afterEach(() => {
  setWasmProvingProviderFactory(null);
  setAttestedChannelFactory(null);
});

describe('setWasmProvingProviderFactory', () => {
  it('routes WASM createProvingProvider through the installed factory, with the key source', async () => {
    const seen: WasmKeyMaterialProvider[] = [];
    const proof = new Uint8Array([7]);
    setWasmProvingProviderFactory(km => {
      seen.push(km);
      return {check: async () => [], prove: async () => proof};
    });

    const provider = createProvingProvider({type: 'wasm'}, keyMaterial);

    expect(seen).toHaveLength(1);
    await expect(provider.prove(new Uint8Array(), 'midnight/zswap/spend')).resolves.toBe(proof);
    // The factory sees the combined source: SDK-maintained wallet circuits
    // first, then the caller's contract keys.
    await expect(seen[0]!.lookupKey('some/contract/circuit')).resolves.toEqual({
      ir: new Uint8Array([1]),
      proverKey: new Uint8Array([2]),
      verifierKey: new Uint8Array([3]),
    });
  });

  it('routes the wallet facade proving service through the factory in a browser-like host', () => {
    let calls = 0;
    setWasmProvingProviderFactory(() => {
      calls += 1;
      return {check: async () => [], prove: async () => new Uint8Array()};
    });
    const nodeProcess = globalThis.process;
    try {
      // createWalletProvingService takes the SDK's own worker path under Node;
      // hide `process` to exercise the in-host branch the extension uses.
      (globalThis as {process?: unknown}).process = undefined;
      createWalletProvingService({type: 'wasm'});
    } finally {
      globalThis.process = nodeProcess;
    }

    expect(calls).toBe(1);
  });

  it('leaves the proof-server path untouched', () => {
    let calls = 0;
    setWasmProvingProviderFactory(() => {
      calls += 1;
      return {check: async () => [], prove: async () => new Uint8Array()};
    });

    createProvingProvider({type: 'server', url: 'http://localhost:6300'}, keyMaterial);

    expect(calls).toBe(0);
  });
});

describe('remote proof server gate', () => {
  it('keeps a loopback proof server on the plain client', () => {
    expect(() => createProvingProvider({type: 'server', url: 'http://127.0.0.1:6300'}, keyMaterial)).not.toThrow();
    expect(() => createWalletProvingService({type: 'server', url: 'http://localhost:6300'})).not.toThrow();
  });

  it('refuses a remote proof server that has no measurement pin', async () => {
    const remote = {type: 'server' as const, url: 'https://proof.example'};
    expect(() => createProvingProvider(remote, keyMaterial)).toThrow(/measurement pin/);
    expect(() => createWalletProvingService(remote)).toThrow(/measurement pin/);
    await expect(ensureProverReady(remote)).rejects.toThrow(/measurement pin/);
  });

  it('requires https once a pin is set', () => {
    expect(() => createProvingProvider(
      {type: 'server', url: 'http://proof.example', attestation},
      keyMaterial,
    )).toThrow(/https/);
  });

  it('posts the witness only after the session opens', async () => {
    let posted: Uint8Array | undefined;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new Uint8Array([4, 5, 6]);
    const provider = boundProvingProvider(
      async () => {
        await opened;
        const channel: AttestedChannel = {
          check: async (payload) => {
            posted = payload;
            return new Uint8Array();
          },
          prove: async () => new Uint8Array(),
          ready: async () => {},
        };
        return channel;
      },
      {
        checkPayload: async () => body,
        provePayload: async () => body,
      },
    );

    const pending = provider.check(new Uint8Array([1]), 'circuit');
    await Promise.resolve();
    expect(posted).toBeUndefined();
    release();
    await expect(pending).rejects.toThrow();
    expect(posted).toBe(body);
  });

  it('does not read circuit keys before the session opens', async () => {
    let keysRead = 0;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    setAttestedChannelFactory(async () => {
      await opened;
      return {
        check: async () => new Uint8Array(),
        prove: async () => new Uint8Array(),
        ready: async () => {},
      };
    });
    const keys = {
      getZKIR: async () => {
        keysRead += 1;
        return new Uint8Array([1]);
      },
      getProverKey: async () => new Uint8Array([2]),
      getVerifierKey: async () => new Uint8Array([3]),
    };

    const pending = createProvingProvider(
      {type: 'server', url: 'https://proof.example', attestation},
      keys,
    ).check(new Uint8Array([1]), 'circuit');

    await Promise.resolve();
    expect(keysRead).toBe(0);
    release();
    await expect(pending).rejects.toThrow();
    expect(keysRead).toBe(1);
  });

  it('leaves the witness unsent when the session fails', async () => {
    setAttestedChannelFactory(() => Promise.reject(new Error('quote mismatch')));

    await expect(createProvingProvider(
      {type: 'server', url: 'https://proof.example', attestation},
      keyMaterial,
    ).check(new Uint8Array([1]), 'circuit')).rejects.toThrow(/quote mismatch/);
  });
});

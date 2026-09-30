import {describe, it, expect, afterEach} from 'vitest';
import {
  createProvingProvider,
  createWalletProvingService,
  setWasmProvingProviderFactory,
  type WasmKeyMaterialProvider,
} from '../../../src/proof/provider.js';

// Local (WASM) proving is single-threaded per provider, while the ledger asks
// for a transaction's proofs concurrently. Hosts with threads to spare install
// their own provider through the factory; these pin the seam they rely on.

const keyMaterial = {
  getZKIR: async () => new Uint8Array([1]),
  getProverKey: async () => new Uint8Array([2]),
  getVerifierKey: async () => new Uint8Array([3]),
};

afterEach(() => setWasmProvingProviderFactory(null));

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

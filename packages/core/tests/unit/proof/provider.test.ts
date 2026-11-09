import {describe, it, expect, afterEach, beforeEach} from 'vitest';
import {ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import * as ledgerV8 from '@midnightntwrk/wallet-sdk/ledger/v8';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import {
  createProvingProvider,
  createWalletProvingService,
  setWasmProvingProviderFactory,
  type WasmKeyMaterialProvider,
  type ZkirVersion,
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
    const seen: Array<{km: WasmKeyMaterialProvider; zkir: ZkirVersion}> = [];
    const proof = new Uint8Array([7]);
    setWasmProvingProviderFactory((km, zkir) => {
      seen.push({km, zkir});
      return {check: async () => [], prove: async () => proof};
    });

    const provider = createProvingProvider({type: 'wasm'}, keyMaterial);
    await expect(provider.prove(new Uint8Array(), 'some/contract/circuit')).resolves.toBe(proof);

    // Built on the first proof, for the ZKIR version the circuit's IR names.
    expect(seen.map(({zkir}) => zkir)).toEqual(['v2']);
    // The factory sees the combined source: SDK-maintained wallet circuits
    // first, then the caller's contract keys.
    await expect(seen[0]!.km.lookupKey('some/contract/circuit')).resolves.toEqual({
      ir: new Uint8Array([1]),
      proverKey: new Uint8Array([2]),
      verifierKey: new Uint8Array([3]),
    });
  });

  it('routes the wallet facade proving service through the factory in a browser-like host, on zkir-v2', () => {
    const built: Array<{km: WasmKeyMaterialProvider; zkir: ZkirVersion}> = [];
    setWasmProvingProviderFactory((km, zkir) => {
      built.push({km, zkir});
      return {check: async () => [], prove: async () => new Uint8Array()};
    });
    const nodeProcess = globalThis.process;
    try {
      // createWalletProvingService takes the SDK's own worker path under Node;
      // hide `process` to exercise the in-host branch the extension uses.
      (globalThis as {process?: unknown}).process = undefined;
      createWalletProvingService({type: 'wasm'}, ProtocolVersion.V9NativeForkSchedule);
    } finally {
      globalThis.process = nodeProcess;
    }

    // One prover per ledger version, each over its own key material, and the SDK publishes the
    // wallet's own circuits as ZKIR v2 for both.
    expect(built.map(({zkir}) => zkir)).toEqual(['v2', 'v2']);
    expect(built[0]!.km).not.toBe(built[1]!.km);
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

describe('createWalletProvingService in a browser-like host', () => {
  const forks = ProtocolVersion.V9NativeForkSchedule;
  const ttl = () => new Date(Date.now() + 60_000);
  const v8Tx = () => ledgerV8.Transaction.fromParts('preprod', undefined, undefined, ledgerV8.Intent.new(ttl()));
  const v9Tx = () => ledgerV9.Transaction.fromParts('preprod', undefined, undefined, ledgerV9.Intent.new(ttl()));

  function inBrowser<T>(build: () => T): T {
    const nodeProcess = globalThis.process;
    try {
      (globalThis as {process?: unknown}).process = undefined;
      return build();
    } finally {
      globalThis.process = nodeProcess;
    }
  }

  // The router picks a backend by the transaction's stamp; a stamp that names the
  // other ledger version must be refused before the bytes reach that ledger.
  it('refuses a transaction built by the other ledger version than its stamp names', async () => {
    const service = inBrowser(() => createWalletProvingService({type: 'wasm'}, forks));
    const mismatch = /handed a transaction built by the other ledger version/;

    await expect(service.prove(v8Tx(), forks.v9)).rejects.toThrow(mismatch);
    await expect(service.prove(v9Tx(), ProtocolVersion.MinSupportedVersion)).rejects.toThrow(mismatch);
  });

  it('proves each ledger version on its own side of the fork', async () => {
    const service = inBrowser(() => createWalletProvingService({type: 'wasm'}, forks));

    await expect(service.prove(v8Tx(), ProtocolVersion.MinSupportedVersion)).resolves.toBeInstanceOf(ledgerV8.Transaction);
    await expect(service.prove(v9Tx(), forks.v9)).resolves.toBeInstanceOf(ledgerV9.Transaction);
  });

  // Ledger-v8's circuits are generation 9 and ledger-v9's generation 10, and a node rejects a DUST
  // spend proved with the other's keys. The key source path names the generation it reads.
  describe('reads the DUST spend keys of the ledger version it proves for', () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    beforeEach(() => {
      fetched.length = 0;
      globalThis.fetch = (async (url: URL | string) => {
        fetched.push(String(url));
        return new Response(null, {status: 404});
      }) as typeof fetch;
      // Each proof the ledger asks for stands in for a DUST spend, whose keys zkir looks up so.
      setWasmProvingProviderFactory((keys) => {
        const dustSpend = async () => {
          await keys.lookupKey('midnight/dust/spend');
          throw new Error('unreachable: the key source is offline');
        };
        return {check: dustSpend, prove: dustSpend};
      });
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    // A shielded output, so the ledger asks the provider for a proof.
    const seed = new Uint8Array(32).fill(7);
    const withOutput = {
      v8: () => {
        const keys = ledgerV8.ZswapSecretKeys.fromSeed(seed);
        const coin = ledgerV8.createShieldedCoinInfo(ledgerV8.shieldedToken().raw, 1n);
        const output = ledgerV8.ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey);
        return ledgerV8.Transaction.fromParts('preprod', ledgerV8.ZswapOffer.fromOutput(output, coin.type, coin.value));
      },
      v9: () => {
        const keys = ledgerV9.ZswapSecretKeys.fromSeed(seed);
        const coin = ledgerV9.createShieldedCoinInfo(ledgerV9.shieldedToken().raw, 1n);
        const output = ledgerV9.ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey);
        return ledgerV9.Transaction.fromParts('preprod', ledgerV9.ZswapOffer.fromOutput(output, coin.type, coin.value));
      },
    };
    const generationsFetched = () => [...new Set(fetched.map((url) => /\/dust\/(\d+)\/spend\./.exec(url)?.[1] ?? url))];

    it('generation 9 below the fork', async () => {
      const service = inBrowser(() => createWalletProvingService({type: 'wasm'}, forks));
      await expect(service.prove(withOutput.v8(), ProtocolVersion.MinSupportedVersion)).rejects.toThrow();
      expect(generationsFetched()).toEqual(['9']);
    });

    it('generation 10 from the fork', async () => {
      const service = inBrowser(() => createWalletProvingService({type: 'wasm'}, forks));
      await expect(service.prove(withOutput.v9(), forks.v9)).rejects.toThrow();
      expect(generationsFetched()).toEqual(['10']);
    });
  });
});

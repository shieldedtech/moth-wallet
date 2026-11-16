import { describe, expect, it } from 'vitest';
import type { KeyMaterialProvider } from '@midnight-ntwrk/dapp-connector-api';
import { decodeBigintJson, encodeBigintJson } from '../lib/messaging/bigint-json';
import type { PageClient } from '../lib/messaging/page-transport';
import { createProvingProxy } from '../lib/connector/proving-proxy';
import { ProverKeyCache } from '../lib/offscreen/prover-key-cache';

const ORIGIN = 'https://dapp.example';
const LOCATION = `contract:${'ab'.repeat(32)}/join?vk=${'cd'.repeat(32)}`;
const PROVER_KEY = Uint8Array.from({ length: 2500 }, (_, i) => i % 251);
const CHUNK = 1000;

interface Call {
  method: string;
  params: unknown[];
}

/** The background and the wallet host behind the page client, holding keys in a real cache. */
function fakeWallet(options: { fail?: Error } = {}) {
  const wallet = { cache: new ProverKeyCache(), calls: [] as Call[] };
  const client: PageClient = {
    async request(method, paramsJson) {
      const params = decodeBigintJson<unknown[]>(paramsJson);
      wallet.calls.push({ method, params });
      try {
        if (method === 'proverKeyPut') {
          const [sha256, uploadId, index, count, chunk] = params as [string, string, number, number, Uint8Array];
          return encodeBigintJson(await wallet.cache.put(ORIGIN, { sha256, uploadId, index, count, chunk }));
        }
        if (options.fail) throw options.fail;
        const material = wallet.cache.resolve(ORIGIN, params[2] as never);
        if (material && material.proverKey.length !== PROVER_KEY.length) throw new Error('wrong prover key');
        return encodeBigintJson(method === 'provingProviderProve' ? new Uint8Array([9]) : [1n]);
      } catch (err) {
        throw Object.assign(new Error((err as Error).message), { code: 'InternalError', reason: (err as Error).message });
      }
    },
  };
  return { wallet, client };
}

const keys: KeyMaterialProvider = {
  getZKIR: async () => new Uint8Array([1]),
  getProverKey: async () => PROVER_KEY,
  getVerifierKey: async () => new Uint8Array([2]),
};

const proxy = (client: PageClient, secureContext = true) =>
  createProvingProxy(client, keys, {
    subtle: secureContext ? crypto.subtle : undefined,
    chunkBytes: CHUNK,
    randomId: () => crypto.randomUUID(),
  });

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'proverKeyPut');
const proofs = (calls: Call[]) => calls.filter((c) => c.method !== 'proverKeyPut');
const carriesProverKey = (call: Call) => 'proverKey' in ((call.params[2] as object | null) ?? {});

describe('the page-side proving provider', () => {
  it("sends a contract circuit's prover key once, then names it by hash", async () => {
    const { wallet, client } = fakeWallet();
    const provider = proxy(client);

    await expect(provider.check(new Uint8Array([7]), LOCATION)).resolves.toEqual([1n]);
    await expect(provider.prove(new Uint8Array([7]), LOCATION, 3n)).resolves.toEqual(new Uint8Array([9]));
    await expect(provider.prove(new Uint8Array([7]), LOCATION)).resolves.toEqual(new Uint8Array([9]));

    expect(puts(wallet.calls)).toHaveLength(3);
    expect(puts(wallet.calls).map((c) => (c.params[4] as Uint8Array).length)).toEqual([1000, 1000, 500]);
    // The first check is refused for want of the key and asked again; nothing else is.
    expect(proofs(wallet.calls).map((c) => c.method)).toEqual([
      'provingProviderCheck',
      'provingProviderCheck',
      'provingProviderProve',
      'provingProviderProve',
    ]);
    expect(proofs(wallet.calls).some(carriesProverKey)).toBe(false);
    expect(proofs(wallet.calls)[2]!.params[3]).toBe(3n);
  });

  it('shares one upload between proofs that need the key at once', async () => {
    const { wallet, client } = fakeWallet();
    const provider = proxy(client);

    await Promise.all([1, 2, 3].map((n) => provider.prove(new Uint8Array([n]), LOCATION)));

    expect(puts(wallet.calls)).toHaveLength(3);
  });

  it('sends the key again once the wallet no longer holds it', async () => {
    const { wallet, client } = fakeWallet();
    const provider = proxy(client);
    await provider.prove(new Uint8Array([1]), LOCATION);

    wallet.cache = new ProverKeyCache();
    await expect(provider.prove(new Uint8Array([2]), LOCATION)).resolves.toEqual(new Uint8Array([9]));

    expect(puts(wallet.calls)).toHaveLength(6);
  });

  it('carries the keys in full outside a secure context', async () => {
    const { wallet, client } = fakeWallet();

    await proxy(client, false).prove(new Uint8Array([1]), LOCATION);

    expect(puts(wallet.calls)).toHaveLength(0);
    expect(proofs(wallet.calls).every(carriesProverKey)).toBe(true);
  });

  it("leaves the ledger's own circuits to the wallet", async () => {
    const { wallet, client } = fakeWallet();

    await proxy(client).prove(new Uint8Array([1]), 'midnight/zswap/output');

    expect(wallet.calls).toEqual([
      { method: 'provingProviderProve', params: [new Uint8Array([1]), 'midnight/zswap/output', null, undefined] },
    ]);
  });

  it('passes any other failure through without sending the key', async () => {
    const { wallet, client } = fakeWallet({ fail: new Error('proof server unreachable') });

    await expect(proxy(client).prove(new Uint8Array([1]), LOCATION)).rejects.toThrow('proof server unreachable');
    expect(puts(wallet.calls)).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { registrationOutRefs } from '../../../src/cardano/registration-lookup.js';
import { buildDustMappingDatum, encodeDustMappingDatum } from '../../../src/cardano/datum.js';
import type { CardanoNetworkConfig } from '../../../src/cardano/network.js';

const config = {
  network: 'Mainnet',
  networkId: 1,
  blockfrostUrl: 'https://bf.test',
  blockfrostProjectId: 'pid',
} as unknown as CardanoNetworkConfig;

const VALIDATOR = 'addr1validator';
const AUTH = 'auth';
const MINE = '2f947a9711b3c6a29fa3633ba67a3abe56276cc5973ad35ebc31ef81';
const THEIRS = 'd86cfcec29f8de9d9ce850d2ced5d664b4b50eebcf4108bb882b4938';
const DUST = `73${'11'.repeat(32)}`;

const reg = (tx: string, owner: string) => ({
  tx_hash: tx,
  output_index: 0,
  inline_datum: encodeDustMappingDatum(buildDustMappingDatum(owner, DUST)),
});

/** A fake Blockfrost serving the validator's registrations in pages of `pageSize`. */
function fakeBlockfrost(utxos: unknown[], opts: { pageSize?: number; fail?: number } = {}) {
  const pageSize = opts.pageSize ?? 100;
  const pages: number[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).project_id).toBe('pid');
    const u = new URL(url);
    expect(u.pathname).toBe(`/addresses/${VALIDATOR}/utxos/${AUTH}`);
    const n = Number(u.searchParams.get('page'));
    pages.push(n);
    if (opts.fail === n) return new Response('{}', { status: 429 });
    if (utxos.length === 0) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(utxos.slice((n - 1) * pageSize, n * pageSize)), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, pages };
}

describe('registrationOutRefs', () => {
  it('returns only the registrations whose datum names this stake key', async () => {
    const { fetch } = fakeBlockfrost([
      reg('a', THEIRS),
      reg('b', MINE),
      { tx_hash: 'c', output_index: 1, inline_datum: null },
      { tx_hash: 'd', output_index: 2, inline_datum: 'd87980' }, // not a registration datum
      reg('e', MINE),
    ]);

    expect(await registrationOutRefs(config, VALIDATOR, AUTH, MINE, { fetch })).toEqual([
      { txHash: 'b', outputIndex: 0 },
      { txHash: 'e', outputIndex: 0 },
    ]);
  });

  it('reads every page, several at a time, and stops at the first short one', async () => {
    // 250 registrations: pages of 100, 100, 50. Ours is on the last page.
    const utxos = [...Array.from({ length: 249 }, (_, i) => reg(`t${i}`, THEIRS)), reg('mine', MINE)];
    const { fetch, pages } = fakeBlockfrost(utxos);

    expect(await registrationOutRefs(config, VALIDATOR, AUTH, MINE, { fetch, concurrency: 2 })).toEqual([
      { txHash: 'mine', outputIndex: 0 },
    ]);
    expect(pages.sort()).toEqual([1, 2, 3, 4]);
  });

  it('is empty when the validator has never held a registration', async () => {
    const { fetch } = fakeBlockfrost([]);
    expect(await registrationOutRefs(config, VALIDATOR, AUTH, MINE, { fetch })).toEqual([]);
  });

  it('fails rather than reporting no registration when a page errors', async () => {
    const utxos = Array.from({ length: 150 }, (_, i) => reg(`t${i}`, THEIRS));
    const { fetch } = fakeBlockfrost(utxos, { fail: 2 });

    await expect(registrationOutRefs(config, VALIDATOR, AUTH, MINE, { fetch })).rejects.toThrow(/429/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blockfrost, type OutRef, type UTxO } from '@lucid-evolution/lucid';
import {
  blockfrostUtxoToUtxo,
  fetchUtxosWithUnit,
  type BlockfrostUtxo,
} from '../../../src/cardano/blockfrost.js';
import { dustAuthUnit, dustValidatorAddress } from '../../../src/cardano/blueprint.js';
import { buildDustMappingDatum, encodeDustMappingDatum } from '../../../src/cardano/datum.js';
import { resolveCardanoNetwork } from '../../../src/cardano/network.js';
import { findRegistrations } from '../../../src/cardano/registration.js';
import { BlockfrostKeyMissingError, type CardanoSession } from '../../../src/cardano/session.js';
import { NetworkError } from '../../../src/types/errors.js';

const CONFIG = resolveCardanoNetwork('mainnet', { blockfrostProjectId: 'mainnetTestProject' });
const OURS = '070c2f801567402df8e4e630ed3819e1c29219d1d918266758e3a063';
const DUST = '738d7ea6be572e69fd7d6f943d86f4521a1ca7ddf1160f1d93c820a86712692422';

function registrationRow(index: number, stakeKeyHash: string, dust = DUST): BlockfrostUtxo {
  return {
    tx_hash: index.toString(16).padStart(64, '0'),
    output_index: 0,
    address: 'addr1validator',
    amount: [
      { unit: 'lovelace', quantity: '1586080' },
      { unit: dustAuthUnit(CONFIG), quantity: '1' },
    ],
    data_hash: 'dd'.repeat(32),
    inline_datum: encodeDustMappingDatum(buildDustMappingDatum(stakeKeyHash, dust)),
    reference_script_hash: null,
  };
}

function otherWallets(count: number, offset = 0): BlockfrostUtxo[] {
  return Array.from({ length: count }, (_, i) =>
    registrationRow(offset + i, (offset + i + 1).toString(16).padStart(56, 'f')),
  );
}

/** Serves `rows` the way Blockfrost pages an address, and records each request. */
function fakeBlockfrost(rows: readonly BlockfrostUtxo[]) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    expect((init?.headers as Record<string, string>).project_id).toBe('mainnetTestProject');
    const count = Number(url.searchParams.get('count'));
    const page = Number(url.searchParams.get('page'));
    return Response.json(rows.slice((page - 1) * count, page * count));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchUtxosWithUnit', () => {
  it('reads every page, stopping at the first short one', async () => {
    const rows = otherWallets(250);
    const { requests } = fakeBlockfrost(rows);

    await expect(fetchUtxosWithUnit(CONFIG, 'addr1test', 'unit')).resolves.toEqual(rows);
    expect(requests).toHaveLength(8);
    expect(requests[0]).toBe('/api/v0/addresses/addr1test/utxos/unit?count=100&page=1');
  });

  it('keeps going while every page in a round comes back full', async () => {
    // 800 rows fill pages 1-8 exactly, so only page 9 coming back empty ends it.
    const rows = otherWallets(800);
    const { requests } = fakeBlockfrost(rows);

    await expect(fetchUtxosWithUnit(CONFIG, 'addr1test', 'unit')).resolves.toHaveLength(800);
    expect(requests).toHaveLength(16);
  });

  it('reads an address Blockfrost has never seen as empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await expect(fetchUtxosWithUnit(CONFIG, 'addr1test', 'unit')).resolves.toEqual([]);
  });

  it('backs off and retries when rate limited', async () => {
    vi.useFakeTimers();
    let limited = 2;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (limited-- > 0 ? new Response('{}', { status: 429 }) : Response.json([]))),
    );
    const result = fetchUtxosWithUnit(CONFIG, 'addr1test', 'unit');
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual([]);
  });

  it('fails on any other error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(fetchUtxosWithUnit(CONFIG, 'addr1test', 'unit')).rejects.toBeInstanceOf(NetworkError);
  });

  it('needs a project id', async () => {
    const { fetchMock } = fakeBlockfrost([]);
    const unconfigured = resolveCardanoNetwork('mainnet');
    await expect(fetchUtxosWithUnit(unconfigured, 'addr1test', 'unit')).rejects.toBeInstanceOf(
      BlockfrostKeyMissingError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('blockfrostUtxoToUtxo', () => {
  it("builds the same UTxO as Lucid's own Blockfrost provider", async () => {
    // The UTxO is spent by Lucid's transaction builder, so it must match what Lucid would build.
    vi.useFakeTimers();
    const rows = [registrationRow(1, OURS), { ...registrationRow(2, OURS), inline_datum: null }];
    const provider = new Blockfrost(CONFIG.blockfrostUrl, 'unused') as unknown as {
      blockfrostUtxosToUtxos(rows: unknown[]): Promise<UTxO[]>;
    };
    const lucidBuilt = provider.blockfrostUtxosToUtxos(rows);
    await vi.runAllTimersAsync();

    expect(rows.map(blockfrostUtxoToUtxo)).toEqual(await lucidBuilt);
  });
});

describe('findRegistrations', () => {
  /** A session whose Lucid resolves the output references it is handed, except `missing` ones. */
  function sessionWith(missing: readonly string[] = []) {
    const utxosByOutRef = vi.fn(async (refs: OutRef[]): Promise<UTxO[]> =>
      refs
        .filter((ref) => !missing.includes(ref.txHash))
        .map((ref) => ({
          ...ref,
          address: 'addr1validator',
          assets: { lovelace: 1_586_080n, [dustAuthUnit(CONFIG)]: 1n },
          scriptRef: { type: 'PlutusV3', script: '4e4d01000033222220051200120011' },
        })),
    );
    const session = {
      config: CONFIG,
      addresses: { stakeKeyHash: OURS },
      lucid: { utxosByOutRef },
    } as unknown as CardanoSession;
    return { session, utxosByOutRef };
  }

  it('finds ours among thousands without a request per UTXO', async () => {
    const mine = registrationRow(5_000, OURS);
    const rows = [...otherWallets(2_000), mine, ...otherWallets(2_000, 2_001)];
    const { requests } = fakeBlockfrost(rows);
    const { session, utxosByOutRef } = sessionWith();

    const found = await findRegistrations(session);

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      utxo: {
        txHash: mine.tx_hash,
        outputIndex: 0,
        address: 'addr1validator',
        assets: { lovelace: 1_586_080n, [dustAuthUnit(CONFIG)]: 1n },
        datumHash: undefined,
        datum: mine.inline_datum,
      },
      dustAddress: DUST,
      stakeKeyHash: OURS,
      legacyDustAddress: false,
    });
    expect(utxosByOutRef).not.toHaveBeenCalled();
    // 4,001 UTXOs: 41 pages, read eight at a time.
    expect(requests).toHaveLength(48);
    const validator = await dustValidatorAddress(CONFIG);
    expect(requests[0]).toContain(`/addresses/${validator}/utxos/${dustAuthUnit(CONFIG)}`);
  });

  it('is empty when the stake key is not registered', async () => {
    fakeBlockfrost(otherWallets(300));
    const { session } = sessionWith();
    await expect(findRegistrations(session)).resolves.toEqual([]);
  });

  it('takes an output carrying a reference script from Lucid, which fetches the script', async () => {
    const mine = { ...registrationRow(1, OURS), reference_script_hash: 'ee'.repeat(28) };
    fakeBlockfrost([mine]);
    const { session, utxosByOutRef } = sessionWith();

    const [found] = await findRegistrations(session);
    expect(utxosByOutRef).toHaveBeenCalledWith([{ txHash: mine.tx_hash, outputIndex: 0 }]);
    expect(found?.utxo.scriptRef).toBeDefined();
  });

  it('fails rather than report no registration when Lucid cannot produce it', async () => {
    // Lucid answers a Blockfrost error here with an empty list. Taken at face
    // value, register would go on to mint a second registration.
    const mine = { ...registrationRow(1, OURS), reference_script_hash: 'ee'.repeat(28) };
    fakeBlockfrost([mine]);
    const { session } = sessionWith([mine.tx_hash]);

    await expect(findRegistrations(session)).rejects.toBeInstanceOf(NetworkError);
  });

  it('skips outputs with no inline datum or one that is not a registration', async () => {
    fakeBlockfrost([
      { ...registrationRow(1, OURS), inline_datum: null },
      { ...registrationRow(2, OURS), inline_datum: 'd87980' },
      registrationRow(3, OURS),
    ]);
    const { session } = sessionWith();

    const found = await findRegistrations(session);
    expect(found.map((r) => r.utxo.txHash)).toEqual([registrationRow(3, OURS).tx_hash]);
  });

  it('reports every registration on the stake key, once each', async () => {
    // A UTXO seen on two pages, because the set shifted mid-scan, is still one registration.
    const first = registrationRow(1, OURS);
    const second = registrationRow(2, OURS, '11'.repeat(32));
    fakeBlockfrost([first, second, first]);
    const { session } = sessionWith();

    const found = await findRegistrations(session);
    expect(found.map((r) => r.utxo.txHash)).toEqual([first.tx_hash, second.tx_hash]);
    expect(found[1]!.legacyDustAddress).toBe(true);
  });
});

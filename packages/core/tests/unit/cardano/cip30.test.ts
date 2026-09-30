import { describe, expect, it } from 'vitest';
import {
  addressToHex,
  CIP30_ERROR,
  getCollateral,
  getExtensions,
  getNetworkId,
  getUnusedAddresses,
  getUsedAddresses,
  getRewardAddresses,
  getUtxos,
  paginate,
  valueFromCbor,
} from '../../../src/cardano/cip30.js';
import { resolveCardanoNetwork } from '../../../src/cardano/network.js';
import type { CardanoSession } from '../../../src/cardano/session.js';

const ADDRESS =
  'addr_test1qz4evy8nat6kwv4n0ww8mhrz6g8d8py7dfgrhltzm3l4l6g8pshcq9t8gqkl3e8xxrknsx0pc2fpn5werqnxwk8r5p3s8xal47';
const REWARD = 'stake_test1uqrsctuqz4n5qt0cunnrpmfcr8su9yse68v3sfn8tr36qcc9krsjd';

function sessionOn(network: 'preprod' | 'mainnet'): CardanoSession {
  return {
    config: resolveCardanoNetwork(network),
    addresses: { address: ADDRESS, rewardAddress: REWARD, stakeKeyHash: '', paymentKeyHash: '' },
  } as unknown as CardanoSession;
}

const POLICY = '5027bb764db1fdc73d78b936dedad6a165fc040cb6bfb8c2b904c0bf';

function utxo(outputIndex: number, lovelace: bigint) {
  return {
    txHash: '7052cbb8aa3236ce3f5535a8d71cee4048f4e071f0e4278f131fc73aa550fa71',
    outputIndex,
    address: ADDRESS,
    assets: { lovelace },
  };
}

/** A session whose only real behaviour is the UTXO set the wallet reports. */
function sessionWithUtxos(utxos: ReturnType<typeof utxo>[]): CardanoSession {
  return {
    config: resolveCardanoNetwork('preprod'),
    addresses: { address: ADDRESS, rewardAddress: REWARD, stakeKeyHash: '', paymentKeyHash: '' },
    lucid: { wallet: () => ({ getUtxos: async () => utxos }) },
  } as unknown as CardanoSession;
}

describe('getNetworkId', () => {
  it('is Cardano network ids, not Midnight ones', () => {
    expect(getNetworkId(sessionOn('mainnet'))).toBe(1);
    expect(getNetworkId(sessionOn('preprod'))).toBe(0);
  });
});

describe('address encoding', () => {
  it('hands dApps hex, and it round-trips back to the same address', async () => {
    // CIP-30 passes addresses as hex, not bech32. A dApp decoding this must
    // land on exactly the address the wallet meant.
    const { CML } = await import('@lucid-evolution/lucid');
    const hex = await addressToHex(ADDRESS);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(CML.Address.from_hex(hex).to_bech32(undefined)).toBe(ADDRESS);
  });

  it('reports the wallet address as used and none as unused', async () => {
    // moth derives one base address per account rather than scanning a gap
    // limit, so the used list is exhaustive and there is no unused address to
    // offer. Claiming otherwise would have dApps wait for an address that
    // never arrives.
    const session = sessionOn('preprod');
    expect(await getUsedAddresses(session)).toEqual([await addressToHex(ADDRESS)]);
    expect(getUnusedAddresses()).toEqual([]);
    expect(await getRewardAddresses(session)).toEqual([await addressToHex(REWARD)]);
  });
});

describe('paginate', () => {
  it('slices by page and limit', () => {
    expect(paginate([1, 2, 3, 4, 5], { page: 0, limit: 2 })).toEqual([1, 2]);
    expect(paginate([1, 2, 3, 4, 5], { page: 2, limit: 2 })).toEqual([5]);
  });

  it('returns everything when the dApp does not paginate', () => {
    expect(paginate([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('throws PaginateError past the end rather than returning empty', () => {
    // CIP-30 distinguishes "no more pages" from "this page is empty"; an empty
    // array for both makes an off-by-one silent. The thrown shape is
    // `{ maxSize }` with NO numeric code — an APIError-shaped `{ code, info }`
    // leaves the dApp nothing to correct its request with.
    try {
      paginate([1, 2, 3], { page: 9, limit: 2 });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toEqual({ maxSize: 3 });
      expect(err).not.toHaveProperty('code');
    }
  });

  it('never rejects page 0, even with nothing to page over', () => {
    // An empty wallet answering page 0 has genuinely nothing; that is an
    // answer, not an out-of-range request.
    expect(paginate([], { page: 0, limit: 10 })).toEqual([]);
  });
});

describe('getExtensions', () => {
  it('claims no extensions, matching supportedExtensions', () => {
    // Advertising a CIP moth does not implement is worse than advertising
    // none: a dApp would call into the namespace and get nothing back.
    expect(getExtensions()).toEqual([]);
  });
});

describe('valueFromCbor', () => {
  it('reads a bare Coin and a multi-asset Value', async () => {
    expect(await valueFromCbor('1a004c4b40')).toEqual({ lovelace: 5_000_000n });
    const { assetsToValue } = await import('@lucid-evolution/lucid');
    const hex = assetsToValue({ lovelace: 2_000_000n, [`${POLICY}`]: 1n }).to_cbor_hex();
    expect(await valueFromCbor(hex)).toEqual({ lovelace: 2_000_000n, [`${POLICY}`]: 1n });
  });

  it('does not guess a decimal string as an amount', async () => {
    // The hazard that makes a fallback unsafe: "10000000" is VALID CBOR for
    // the integer 16. Accepting decimals would hand a dApp collateral three
    // orders of magnitude too small, silently, instead of an error.
    expect(await valueFromCbor('10000000')).toEqual({ lovelace: 16n });
    // Odd-length decimal is not hex at all, so it is a clean rejection.
    await expect(valueFromCbor('5000000')).rejects.toMatchObject({
      code: CIP30_ERROR.InvalidRequest,
    });
  });
});

describe('getUsedAddresses paginates', () => {
  it('honours a paginate argument and reports maxSize past the end', async () => {
    const session = sessionOn('preprod');
    expect(await getUsedAddresses(session, { page: 0, limit: 5 })).toHaveLength(1);
    await expect(getUsedAddresses(session, { page: 3, limit: 5 })).rejects.toEqual({ maxSize: 1 });
  });
});

describe('getUtxos', () => {
  it('takes amount FIRST and paginate second, as CIP-30 orders them', async () => {
    // Both arrive as unknowns across the bridge, so a swapped order is not a
    // type error — a dApp asking for page 2 would silently get page 0 forever.
    const session = sessionWithUtxos([utxo(0, 10_000_000n), utxo(1, 3_000_000n)]);
    expect(await getUtxos(session, undefined, { page: 1, limit: 1 })).toHaveLength(1);
    await expect(getUtxos(session, undefined, { page: 9, limit: 1 })).rejects.toEqual({
      maxSize: 2,
    });
  });

  it('returns a covering subset when an amount is requested', async () => {
    const session = sessionWithUtxos([utxo(0, 10_000_000n), utxo(1, 3_000_000n)]);
    // Largest-first, so one input covers 5 ADA rather than two.
    expect(await getUtxos(session, '1a004c4b40')).toHaveLength(1);
  });

  it('returns null when the wallet cannot cover the amount', async () => {
    // null is how a dApp learns to stop waiting; [] would read as "still loading".
    const session = sessionWithUtxos([utxo(0, 1_000_000n)]);
    expect(await getUtxos(session, '1a004c4b40')).toBeNull();
  });

  it('returns null for an empty wallet', async () => {
    expect(await getUtxos(sessionWithUtxos([]))).toBeNull();
  });
});

describe('getCollateral', () => {
  it('takes { amount } as CBOR, not a bigint or a decimal string', async () => {
    const session = sessionWithUtxos([utxo(0, 10_000_000n)]);
    expect(await getCollateral(session, { amount: '1a004c4b40' })).toHaveLength(1);
  });

  it('skips UTXOs carrying native assets', async () => {
    // Collateral must be pure ADA: the ledger requires the collateral return to
    // be, so offering a token-bearing UTXO yields a transaction the node rejects.
    const withToken = { ...utxo(0, 10_000_000n), assets: { lovelace: 10_000_000n, [`${POLICY}`]: 1n } };
    expect(await getCollateral(sessionWithUtxos([withToken]))).toBeNull();
  });

  it('defaults to 5 ADA when asked for no particular amount', async () => {
    expect(await getCollateral(sessionWithUtxos([utxo(0, 10_000_000n)]))).toHaveLength(1);
    expect(await getCollateral(sessionWithUtxos([utxo(0, 4_000_000n)]))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertSendableAddress,
  formatAda,
  formatCnight,
  LOVELACE_PER_ADA,
  MIN_ADA_OUTPUT,
  minLovelaceForOutput,
  parseAda,
  parseCnight,
  sendCardanoAssets,
} from '../../../src/cardano/send.js';
import { resolveCardanoNetwork } from '../../../src/cardano/network.js';
import type { CardanoSession } from '../../../src/cardano/session.js';

const PREVIEW = 'addr_test1qryvgass5dsrf2kxl3vgfz76uhp83kv5lagzcp29tcana68ca5aqa6swlq6llfamln09tal7n5kvt4275ckwedpt4v7q48uhex';
const MAINNET = 'addr1q8yvgass5dsrf2kxl3vgfz76uhp83kv5lagzcp29tcana68ca5aqa6swlq6llfamln09tal7n5kvt4275ckwedpt4v7qk3ph4e';

/** Enough of a session for the checks that run before any chain access. */
function sessionOn(network: 'preview' | 'mainnet'): CardanoSession {
  return { config: resolveCardanoNetwork(network) } as unknown as CardanoSession;
}

describe('parseAda', () => {
  it('converts whole and fractional ADA to lovelace', () => {
    expect(parseAda('1')).toBe(LOVELACE_PER_ADA);
    expect(parseAda('1.5')).toBe(1_500_000n);
    expect(parseAda('0.000001')).toBe(1n);
    expect(parseAda(' 12.34 ')).toBe(12_340_000n);
  });

  it('rejects more precision than lovelace has', () => {
    // Silently truncating would send less than the user typed.
    expect(() => parseAda('1.0000001')).toThrow(/6 places/);
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', '-1', '1e6', 'abc', '1.', '.5', '1,5']) {
      expect(() => parseAda(bad), bad).toThrow();
    }
  });

  it('round-trips through formatAda', () => {
    for (const value of ['1', '1.5', '0.000001', '1000000.123456']) {
      expect(formatAda(parseAda(value))).toBe(value);
    }
  });
});

describe('assertSendableAddress', () => {
  it('accepts an address on the session network', async () => {
    await expect(assertSendableAddress(sessionOn('preview'), PREVIEW)).resolves.toBeUndefined();
  });

  it('refuses a mainnet address from a testnet wallet', async () => {
    // The expensive mistake: well-formed, accepted by the builder, unspendable.
    await expect(assertSendableAddress(sessionOn('preview'), MAINNET)).rejects.toThrow(/mainnet/);
  });

  it('refuses a testnet address from a mainnet wallet', async () => {
    await expect(assertSendableAddress(sessionOn('mainnet'), PREVIEW)).rejects.toThrow(/testnet/);
  });

  it('refuses a malformed address', async () => {
    await expect(assertSendableAddress(sessionOn('preview'), 'addr_test1nope')).rejects.toThrow(/valid Cardano address/);
  });

  it('refuses a Midnight address, which is the likely paste mistake', async () => {
    await expect(
      assertSendableAddress(sessionOn('preview'), 'mn_shield-addr_test1ehmxwu6u7vz8wjs5ddm0e409hk7p7kud3gz5e6'),
    ).rejects.toThrow();
  });
});

describe('sendCardanoAssets guards', () => {
  const session = sessionOn('preview');

  it('refuses a send of nothing', async () => {
    await expect(sendCardanoAssets(session, { to: PREVIEW })).rejects.toThrow(/Nothing to send/);
    await expect(sendCardanoAssets(session, { to: PREVIEW, lovelace: 0n, cnight: 0n }))
      .rejects.toThrow(/Nothing to send/);
  });

  it('refuses negative amounts', async () => {
    await expect(sendCardanoAssets(session, { to: PREVIEW, lovelace: -1n })).rejects.toThrow(/negative/);
  });

  it('validates the address before reading any balance', async () => {
    // The session here has no lucid at all, so reaching balance would throw a
    // TypeError instead — proving the address check runs first.
    await expect(sendCardanoAssets(session, { to: MAINNET, lovelace: 1n })).rejects.toThrow(/mainnet/);
  });
});

describe('cNIGHT scaling', () => {
  it('reads the on-chain quantity as STARs, six decimal places', async () => {
    const { formatCnight, parseCnight, STARS_PER_CNIGHT } = await import('../../../src/cardano/send.js');
    expect(STARS_PER_CNIGHT).toBe(1_000_000n);
    // The real preprod holding: 4,500,400,000,000 STARs is 4,500,400 cNIGHT,
    // not four and a half trillion. Nothing on chain publishes this scale —
    // Cardano has no protocol decimals and the asset has no registry entry —
    // so a wrong factor here is silent.
    expect(formatCnight(4_500_400_000_000n)).toBe('4500400');
    expect(formatCnight(50_000n)).toBe('0.05');
    expect(formatCnight(0n)).toBe('0');
  });

  it('parses an amount as cNIGHT, never as STARs', () => {
    // "10" must mean ten cNIGHT. Read as STARs it is a ten-thousandth of one,
    // and the transaction succeeds, which is the worst way to find out.
    expect(parseCnight('10')).toBe(10_000_000n);
    expect(parseCnight('0.05')).toBe(50_000n);
    expect(parseCnight('4500400')).toBe(4_500_400_000_000n);
  });

  it('round-trips and rejects sub-STAR precision', () => {
    for (const v of ['1', '0.000001', '4500400.5']) {
      expect(formatCnight(parseCnight(v))).toBe(v);
    }
    expect(() => parseCnight('0.0000001')).toThrow(/6 places/);
    expect(() => parseCnight('-1')).toThrow();
  });
});

describe('minimum output', () => {
  // Preview's coinsPerUtxoByte. The minimum itself comes from CML, as Lucid's does.
  const COINS_PER_UTXO_BYTE = 4310n;
  const config = resolveCardanoNetwork('preview');
  const cnightUnitId = config.cnightPolicyId + config.cnightAssetName;

  /** A session whose builder records what would be paid, then stops before signing. */
  function fundedSession() {
    const paid: Array<Record<string, bigint>> = [];
    const lucid = {
      config: () => ({ protocolParameters: { coinsPerUtxoByte: COINS_PER_UTXO_BYTE } }),
      wallet: () => ({
        getUtxos: async () => [{ assets: { lovelace: 100_000_000n, [cnightUnitId]: 50_000_000n } }],
      }),
      newTx: () => ({
        pay: { ToAddress: (_to: string, assets: Record<string, bigint>) => { paid.push(assets); } },
        complete: async () => { throw new Error('stop-before-signing'); },
      }),
    };
    return { session: { config, lucid } as unknown as CardanoSession, paid };
  }

  it('is at least one ADA, and more once the output carries cNIGHT', async () => {
    const { session } = fundedSession();
    const plain = await minLovelaceForOutput(session, PREVIEW, {});
    const withToken = await minLovelaceForOutput(session, PREVIEW, { [cnightUnitId]: 1n });
    expect(plain).toBe(MIN_ADA_OUTPUT);
    expect(withToken).toBeGreaterThan(MIN_ADA_OUTPUT);
  });

  // Lucid raises a smaller amount to the minimum without saying so, so the user
  // would have sent more than they approved.
  it('refuses an ADA amount below the minimum instead of raising it', async () => {
    const { session, paid } = fundedSession();
    await expect(sendCardanoAssets(session, { to: PREVIEW, lovelace: 100_000n })).rejects.toThrow(/needs at least 1 ADA/);
    const minimum = await minLovelaceForOutput(session, PREVIEW, { [cnightUnitId]: 1_000_000n });
    await expect(
      sendCardanoAssets(session, { to: PREVIEW, lovelace: MIN_ADA_OUTPUT, cnight: 1_000_000n }),
    ).rejects.toThrow(new RegExp(`needs at least ${formatAda(minimum).replace('.', '\\.')} ADA`));
    expect(paid).toEqual([]);
  });

  it('pays exactly the requested amount at or above the minimum', async () => {
    const { session, paid } = fundedSession();
    await expect(sendCardanoAssets(session, { to: PREVIEW, lovelace: 2_000_000n })).rejects.toThrow('stop-before-signing');
    expect(paid).toEqual([{ lovelace: 2_000_000n }]);
  });

  it('adds the real minimum for a cNIGHT-only send', async () => {
    const { session, paid } = fundedSession();
    const minimum = await minLovelaceForOutput(session, PREVIEW, { [cnightUnitId]: 1_000_000n });
    await expect(sendCardanoAssets(session, { to: PREVIEW, cnight: 1_000_000n })).rejects.toThrow('stop-before-signing');
    expect(paid).toEqual([{ lovelace: minimum, [cnightUnitId]: 1_000_000n }]);
  });
});

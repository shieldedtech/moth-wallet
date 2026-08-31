// Serialization and input-validation coverage for the MCP server.
//
// WalletBalances and ActivityEntry carry bigint and Date fields — a raw
// JSON.stringify throws on the former (this is exactly what these
// serializers exist to prevent from reaching the MCP transport), so the
// core assertion in every case is: the serialized shape stringifies,
// and money figures come out as decimal strings per the daemon wire
// convention (wallet-rpc-types.ts).

import { describe, expect, it } from 'vitest';
import {
  EMPTY_COINS,
  EMPTY_SUB_PROGRESS,
  NIGHT_TOKEN_ID,
  type ActivityEntry,
  type WalletBalances,
} from '@shieldedtech/moth-wallet';
import { serializeActivityEntry, serializeBalances } from '../../src/mcp/serialize.js';
import { resolveTransferAmount, validateRecipient } from '../../src/mcp/tools.js';

const TOKEN_A = 'a'.repeat(64);

// Real derived addresses (throwaway seed) — one per kind, all tagged
// `undeployed`. Bech32m validity is a pure string property, so these
// stay valid fixtures forever.
const UNSHIELDED_ADDR =
  'mn_addr_undeployed1zd3qknxl8u3lxu628lquryxah63xk84lu66fxzgce49xar3v895smxgasz';
const SHIELDED_ADDR =
  'mn_shield-addr_undeployed16d73m9mgj7h23xcqk3990f9ddhntf8mujd75fpd2gxj3jeezgqzc4ru3pwqwrqjrls5uzaullz0u8n7xgqd2qvq8g3mx732df88wfqgn8crxx';
const DUST_ADDR =
  'mn_dust_undeployed1wdrvdx87897u8glu4uz4pwx285z6t6sgjatvs9hc8u809l3nhngncsumq7x';

function makeBalances(overrides: Partial<WalletBalances> = {}): WalletBalances {
  return {
    shielded: { [NIGHT_TOKEN_ID]: 2_000_000n, [TOKEN_A]: 5n },
    unshielded: { [NIGHT_TOKEN_ID]: 5_000_000n },
    dust: 3_000_000_000_000_000n,
    dustGeneration: null,
    syncProgress: {
      percentage: 1,
      etaSeconds: null,
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: true,
      slowest: null,
    },
    synced: true,
    coins: {
      ...EMPTY_COINS,
      unshielded: {
        available: [{ value: 3_000_000n, type: NIGHT_TOKEN_ID, registeredForDustGeneration: false }],
        pending: [{ value: 2_000_000n, type: NIGHT_TOKEN_ID, registeredForDustGeneration: false }],
      },
    },
    subProgress: EMPTY_SUB_PROGRESS,
    ...overrides,
  };
}

describe('serializeBalances', () => {
  it('produces a JSON-stringifiable shape (raw stringify on WalletBalances throws)', () => {
    const b = makeBalances();
    expect(() => JSON.stringify(b)).toThrow(); // the hazard being guarded against
    const s = serializeBalances('w1', 'devnet', b);
    expect(() => JSON.stringify(s)).not.toThrow();
  });

  it('emits decimal strings and the spendable split', () => {
    const s = serializeBalances('w1', 'devnet', makeBalances());
    expect(s.night.unshielded).toBe('5000000');
    expect(s.night.shielded).toBe('2000000');
    expect(s.night.total).toBe('7000000');
    expect(s.night.unshieldedAvailable).toBe('3000000');
    expect(s.night.unshieldedReserved).toBe('2000000');
    expect(s.dust.speck).toBe('3000000000000000');
    expect(typeof s.night.totalFormatted).toBe('string');
    expect(typeof s.dust.formatted).toBe('string');
  });

  it('lists non-NIGHT tokens separately', () => {
    const s = serializeBalances('w1', 'devnet', makeBalances());
    expect(s.otherTokens).toEqual([{ tokenId: TOKEN_A, type: 'shielded', amount: '5' }]);
  });
});

describe('serializeActivityEntry', () => {
  const entry: ActivityEntry = {
    hash: '0xabc',
    kind: 'sent',
    status: 'SUCCESS',
    timestamp: new Date('2026-01-02T03:04:05.000Z'),
    deltas: [{ tokenType: NIGHT_TOKEN_ID, kind: 'unshielded', amount: -1_500_000n }],
    dustDelta: -5n,
    counterparty: 'mn_addr_test',
    fees: 123n,
    pending: false,
    outputs: 1,
  };

  it('converts bigint and Date fields to strings', () => {
    const s = serializeActivityEntry(entry);
    expect(() => JSON.stringify(s)).not.toThrow();
    expect(s.timestamp).toBe('2026-01-02T03:04:05.000Z');
    expect(s.deltas[0].amount).toBe('-1500000');
    expect(s.dustDelta).toBe('-5');
    expect(s.fees).toBe('123');
    expect(s.outputs).toBe(1);
  });

  it('preserves nulls (no timestamp, no fees) and omits absent outputs', () => {
    const s = serializeActivityEntry({ ...entry, timestamp: null, fees: null, outputs: undefined });
    expect(s.timestamp).toBeNull();
    expect(s.fees).toBeNull();
    expect('outputs' in s).toBe(false);
  });
});

describe('resolveTransferAmount', () => {
  it('requires exactly one of amountNight / amountRaw', () => {
    expect(resolveTransferAmount({ tokenId: NIGHT_TOKEN_ID })).toHaveProperty('error');
    expect(
      resolveTransferAmount({ amountNight: '1', amountRaw: '1', tokenId: NIGHT_TOKEN_ID }),
    ).toHaveProperty('error');
  });

  it('parses decimal NIGHT via parseNightAmount', () => {
    expect(resolveTransferAmount({ amountNight: '1.5', tokenId: NIGHT_TOKEN_ID })).toEqual({
      raw: 1_500_000n,
    });
  });

  it('rejects amountNight for non-NIGHT tokens', () => {
    const r = resolveTransferAmount({ amountNight: '1', tokenId: TOKEN_A });
    expect(r).toHaveProperty('error');
  });

  it('rejects malformed NIGHT amounts (locale separators, exponents)', () => {
    expect(resolveTransferAmount({ amountNight: '1,5', tokenId: NIGHT_TOKEN_ID })).toHaveProperty('error');
    expect(resolveTransferAmount({ amountNight: '1e6', tokenId: NIGHT_TOKEN_ID })).toHaveProperty('error');
  });

  it('accepts integer amountRaw for any token, rejects zero and non-integers', () => {
    expect(resolveTransferAmount({ amountRaw: '42', tokenId: TOKEN_A })).toEqual({ raw: 42n });
    expect(resolveTransferAmount({ amountRaw: '0', tokenId: TOKEN_A })).toHaveProperty('error');
    expect(resolveTransferAmount({ amountRaw: '1.5', tokenId: TOKEN_A })).toHaveProperty('error');
    expect(resolveTransferAmount({ amountRaw: 'abc', tokenId: TOKEN_A })).toHaveProperty('error');
  });
});

describe('validateRecipient', () => {
  it('accepts a matching kind on the matching network', () => {
    expect(validateRecipient(UNSHIELDED_ADDR, 'unshielded', 'undeployed')).toBeNull();
    expect(validateRecipient(SHIELDED_ADDR, 'shielded', 'undeployed')).toBeNull();
  });

  it('rejects a kind mismatch in both directions', () => {
    expect(validateRecipient(SHIELDED_ADDR, 'unshielded', 'undeployed')).toMatch(/unshielded transfer/);
    expect(validateRecipient(UNSHIELDED_ADDR, 'shielded', 'undeployed')).toMatch(/shielded transfer/);
  });

  it('rejects a DUST address for any transfer type', () => {
    expect(validateRecipient(DUST_ADDR, 'unshielded', 'undeployed')).toMatch(/DUST/);
    expect(validateRecipient(DUST_ADDR, 'shielded', 'undeployed')).toMatch(/DUST/);
  });

  it('rejects a network-tag mismatch (cross-network sends lose funds)', () => {
    expect(validateRecipient(UNSHIELDED_ADDR, 'unshielded', 'devnet')).toMatch(/tagged for network "undeployed"/);
  });

  it('rejects malformed input', () => {
    expect(validateRecipient('mn_addr_undeployed1qqqq', 'unshielded', 'undeployed')).toMatch(/well-formed/);
    expect(validateRecipient('', 'unshielded', 'undeployed')).toMatch(/well-formed/);
  });
});

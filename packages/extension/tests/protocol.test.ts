import { describe, it, expect } from 'vitest';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { serializeBalances, deserializeBalances } from '../lib/messaging/protocol';
import { decodeBigintJson, encodeBigintJson } from '../lib/messaging/bigint-json';

const NIGHT = '0'.repeat(64);

function sampleBalances(): WalletBalances {
  return {
    shielded: { [NIGHT]: 123_456_789n },
    unshielded: { [NIGHT]: 42n, deadbeef: 7n },
    dust: 999_999_999_999n,
    dustGeneration: {
      balance: 999_999_999_999n,
      designated: 100n,
      ratePerDay: 8_640_000n,
      limit: 5_000_000_000n,
      fillTime: new Date('2026-07-06T12:00:00.000Z'),
      numUtxos: 2,
      registered: true,
      registeredNight: 42n,
      newestRegisteredAt: new Date('2026-07-05T09:30:00.000Z'),
    },
    syncProgress: {
      percentage: 0.5,
      slowest: null,
      etaSeconds: 120,
      shieldedSynced: true,
      unshieldedSynced: false,
      dustSynced: false,
    },
    synced: false,
    coins: {
      shielded: { available: [{ value: 10n, type: NIGHT }], pending: [] },
      unshielded: {
        available: [{ value: 42n, type: NIGHT, registeredForDustGeneration: true }],
        pending: [],
      },
      dust: {
        available: [
          {
            generatedNow: 1n,
            maxCap: 100n,
            maxCapReachedAt: new Date('2026-08-01T00:00:00.000Z'),
            dtime: null,
          },
        ],
        pending: [
          {
            generatedNow: 0n,
            maxCap: 50n,
            maxCapReachedAt: new Date('2026-09-01T00:00:00.000Z'),
            dtime: new Date('2026-09-02T00:00:00.000Z'),
          },
        ],
      },
    },
    subProgress: {
      shielded: { applied: 5, total: 10 },
      unshielded: { applied: 10, total: 10 },
      dust: { applied: 0, total: 10 },
    },
  };
}

describe('balances serialization', () => {
  it('round-trips bigints, Dates and nulls', () => {
    const original = sampleBalances();
    const restored = deserializeBalances(serializeBalances(original));

    expect(restored).toEqual(original);
    expect(typeof restored.dust).toBe('bigint');
    expect(restored.shielded[NIGHT]).toBe(123_456_789n);
    expect(restored.dustGeneration?.fillTime).toBeInstanceOf(Date);
    expect(restored.coins.dust.available[0]?.maxCapReachedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(restored.coins.dust.available[0]?.dtime).toBeNull();
    expect(restored.coins.dust.pending[0]?.dtime).toBeInstanceOf(Date);
  });

  it('survives a null dustGeneration', () => {
    const original = { ...sampleBalances(), dustGeneration: null };
    expect(deserializeBalances(serializeBalances(original)).dustGeneration).toBeNull();
  });
});

describe('connector JSON serialization', () => {
  it('round-trips bigint and binary proving payloads', () => {
    const value = {
      input: new Uint8Array([0, 1, 127, 128, 255]),
      overwriteBindingInput: 12345678901234567890n,
      check: [1n, undefined, 3n],
    };
    expect(decodeBigintJson(encodeBigintJson(value))).toEqual(value);
  });
});

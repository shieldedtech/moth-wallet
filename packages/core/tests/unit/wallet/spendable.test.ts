import {describe, expect, it} from 'vitest';
import {describeReservation, unshieldedSplit} from '../../../src/wallet/spendable.js';
import type {WalletCoinDetails} from '../../../src/sync/wallet-sync.js';

const NIGHT = '0'.repeat(64);
const OTHER = 'a'.repeat(64);
const coin = (value: bigint, type = NIGHT) => ({value, type, registeredForDustGeneration: false});

const details = (available: bigint[], pending: bigint[], type = NIGHT): WalletCoinDetails => ({
  shielded: {available: [], pending: []},
  dust: {available: [], pending: []},
  unshielded: {
    available: available.map((v) => coin(v, type)),
    pending: pending.map((v) => coin(v, type)),
  },
}) as WalletCoinDetails;

const fmt = (raw: bigint) => `${raw} STARS`;

describe('unshieldedSplit', () => {
  it('separates what can be spent from what is reserved', () => {
    const split = unshieldedSplit(details([100n, 50n], [300n]), NIGHT);
    expect(split).toEqual({available: 150n, reserved: 300n, total: 450n});
  });

  // The case that cost an hour of misdiagnosis: 500 NIGHT reported, none of it
  // spendable, and both numbers true.
  it('reports zero available when everything is reserved', () => {
    const split = unshieldedSplit(details([], [500_000_000n]), NIGHT);
    expect(split.available).toBe(0n);
    expect(split.total).toBe(500_000_000n);
  });

  it('counts only the token asked about', () => {
    const mixed: WalletCoinDetails = {
      shielded: {available: [], pending: []},
      dust: {available: [], pending: []},
      unshielded: {available: [coin(10n, NIGHT), coin(99n, OTHER)], pending: []},
    } as WalletCoinDetails;
    expect(unshieldedSplit(mixed, NIGHT).available).toBe(10n);
    expect(unshieldedSplit(mixed, OTHER).available).toBe(99n);
  });

  it('is all zeroes for a wallet with no coins', () => {
    expect(unshieldedSplit(details([], []), NIGHT)).toEqual({available: 0n, reserved: 0n, total: 0n});
  });
});

describe('describeReservation', () => {
  it('explains the shortfall when a reservation caused it', () => {
    const msg = describeReservation({available: 0n, reserved: 500n, total: 500n}, 10n, fmt);
    expect(msg).toContain('500 STARS held');
    expect(msg).toContain('0 STARS available');
    expect(msg).toContain('reserved');
  });

  // Staying quiet matters as much as speaking: explaining a reservation that is
  // not the cause sends the reader after the wrong thing.
  it('says nothing when nothing is reserved', () => {
    expect(describeReservation({available: 5n, reserved: 0n, total: 5n}, 10n, fmt)).toBeNull();
  });

  it('says nothing when the available part already covers the amount', () => {
    // Reserved coins exist, but they are not why this failed.
    expect(describeReservation({available: 100n, reserved: 50n, total: 150n}, 10n, fmt)).toBeNull();
  });

  it('speaks when the total covers it but the available part does not', () => {
    expect(describeReservation({available: 5n, reserved: 100n, total: 105n}, 10n, fmt)).not.toBeNull();
  });
});

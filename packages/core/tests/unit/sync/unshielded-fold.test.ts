import {describe, expect, it} from 'vitest';
import {foldBookedInputs, utxoId} from '../../../src/sync/unshielded-fold.js';

const NIGHT = '0'.repeat(64);

describe('foldBookedInputs', () => {
  it('adds a booked input the SDK has moved out of available', () => {
    // The healthy case the fold exists for: without it the balance flashes to
    // zero while a registration is in flight.
    const r = foldBookedInputs(
      [],
      [{id: 'aa:0', type: NIGHT, value: 3_000_000_000n}],
      {},
    );
    expect(r.balances[NIGHT]).toBe(3_000_000_000n);
    expect(r.duplicated).toEqual([]);
  });

  it('counts a UTXO listed as both available and booked exactly once', () => {
    // The wedged state: a booking whose transaction never landed, plus a resync
    // that re-added the coin to available. The SDK's map already counts it, so
    // folding it again displayed 6,000 for a wallet holding 3,000.
    const r = foldBookedInputs(
      [{id: 'aa:0', type: NIGHT, value: 3_000_000_000n}],
      [{id: 'aa:0', type: NIGHT, value: 3_000_000_000n}],
      {[NIGHT]: 3_000_000_000n},
    );
    expect(r.balances[NIGHT]).toBe(3_000_000_000n);
    expect(r.duplicated).toEqual(['aa:0']);
  });

  it('still folds the genuinely booked inputs alongside a duplicated one', () => {
    const r = foldBookedInputs(
      [{id: 'aa:0', type: NIGHT, value: 3_000_000_000n}],
      [
        {id: 'aa:0', type: NIGHT, value: 3_000_000_000n},
        {id: 'bb:1', type: NIGHT, value: 500n},
      ],
      {[NIGHT]: 3_000_000_000n},
    );
    expect(r.balances[NIGHT]).toBe(3_000_000_500n);
    expect(r.duplicated).toEqual(['aa:0']);
  });

  it('keeps token types separate', () => {
    const OTHER = 'ab'.repeat(32);
    const r = foldBookedInputs([], [{id: 'cc:0', type: OTHER, value: 7n}], {[NIGHT]: 1n});
    expect(r.balances).toEqual({[NIGHT]: 1n, [OTHER]: 7n});
  });

  it('does not mutate the caller’s balance map', () => {
    const original = {[NIGHT]: 1n};
    foldBookedInputs([], [{id: 'dd:0', type: NIGHT, value: 1n}], original);
    expect(original[NIGHT]).toBe(1n);
  });

  it('builds the SDK’s own UTXO identity, and tolerates a missing one', () => {
    expect(utxoId({intentHash: '421c4146', outputNo: 0})).toBe('421c4146:0');
    expect(utxoId(undefined)).toBe('?:?');
  });
});

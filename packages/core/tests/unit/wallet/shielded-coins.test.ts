import { describe, it, expect } from 'vitest';
import { shieldedCoinInfo } from '../../../src/sync/wallet-sync.js';
import { shieldedCoinRows } from '../../../src/wallet/shielded-coins.js';

// The shapes wallet-sdk-shielded 4.x hands over: an AvailableCoin's coin is a
// QualifiedShieldedCoinInfo with mt_index; a PendingCoin's coin has none.
const available = {
  coin: { type: 'aa'.repeat(32), nonce: 'bb'.repeat(32), value: 1_000n, mt_index: 42n },
  commitment: 'cc'.repeat(32),
  nullifier: 'dd'.repeat(32),
};
const pending = {
  coin: { type: 'aa'.repeat(32), nonce: 'ee'.repeat(32), value: 7n },
  ttl: undefined,
  commitment: 'ff'.repeat(32),
  nullifier: '11'.repeat(32),
};

describe('shieldedCoinInfo', () => {
  it('keeps the nonce and Merkle index a spend needs', () => {
    expect(shieldedCoinInfo(available)).toEqual({
      value: 1_000n,
      type: 'aa'.repeat(32),
      nonce: 'bb'.repeat(32),
      mtIndex: 42n,
      commitment: 'cc'.repeat(32),
    });
  });

  it('never carries the nullifier, which would let a reader see the coin spent', () => {
    expect(shieldedCoinInfo(available)).not.toHaveProperty('nullifier');
  });

  it('leaves a pending coin without an index', () => {
    expect(shieldedCoinInfo(pending).mtIndex).toBeUndefined();
  });
});

describe('shieldedCoinRows', () => {
  it('lists spendable coins first, in QualifiedShieldedCoinInfo field names', () => {
    const rows = shieldedCoinRows({
      shielded: { available: [shieldedCoinInfo(available)], pending: [shieldedCoinInfo(pending)] },
    });
    expect(rows).toEqual([
      { type: 'aa'.repeat(32), value: 1_000n, nonce: 'bb'.repeat(32), mt_index: 42n, commitment: 'cc'.repeat(32), status: 'available' },
      { type: 'aa'.repeat(32), value: 7n, nonce: 'ee'.repeat(32), mt_index: null, commitment: 'ff'.repeat(32), status: 'pending' },
    ]);
  });

  it('marks what the SDK did not report as null rather than dropping the coin', () => {
    const [row] = shieldedCoinRows({ shielded: { available: [{ value: 1n, type: 't' }], pending: [] } });
    expect(row).toMatchObject({ nonce: null, mt_index: null, commitment: null, status: 'available' });
  });
});

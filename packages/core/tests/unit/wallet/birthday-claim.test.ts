import {beforeEach, describe, expect, it, vi} from 'vitest';
import {resolveBirthdayClaim, shieldedCaveat} from '../../../src/wallet/birthday-claim.js';

// A real seed, so address derivation runs for the checks that need it.
const SEED_HEX = 'a'.repeat(64);
const INDEXER = 'https://indexer.example/api/v4/graphql';

const activity = (height: number) => ({
  height,
  timestamp: Date.UTC(2026, 5, 26),
  transactionId: 1,
  hash: 'deadbeef',
});

const first = vi.hoisted(() => vi.fn());
vi.mock('../../../src/network/first-activity.js', () => ({firstUnshieldedActivity: first}));

const heightFor = vi.hoisted(() => vi.fn());
vi.mock('../../../src/network/block-time.js', () => ({heightForDate: heightFor}));

describe('resolveBirthdayClaim', () => {
  beforeEach(() => {
    first.mockReset();
    heightFor.mockReset();
  });

  it('returns no height at all when nothing was claimed', async () => {
    const out = await resolveBirthdayClaim({indexerUrl: INDEXER, networkId: 'preprod'});
    expect(out.height).toBeUndefined();
    expect(first).not.toHaveBeenCalled();
  });

  it('discovers the first unshielded transaction and always states the shielded caveat', async () => {
    first.mockResolvedValue(activity(1_388_662));
    const out = await resolveBirthdayClaim({
      indexerUrl: INDEXER,
      networkId: 'preprod',
      claim: {kind: 'discover'},
      seedHex: SEED_HEX,
    });
    expect(out.height).toBe(1_388_662);
    expect(out.notes.join(' ')).toContain(shieldedCaveat(1_388_662));
  });

  it('falls back to the tip when the chain has never seen the seed', async () => {
    first.mockResolvedValue(null);
    const out = await resolveBirthdayClaim({
      indexerUrl: INDEXER,
      networkId: 'preprod',
      claim: {kind: 'discover'},
      seedHex: SEED_HEX,
      tipHeight: 2_180_000,
    });
    // No history means the tip is sound for unshielded — and still says nothing
    // about shielded, so the caveat holds.
    expect(out.height).toBe(2_180_000);
    expect(out.notes.join(' ')).toContain('No unshielded transactions for this seed on preprod');
    expect(out.notes.join(' ')).toContain(shieldedCaveat(2_180_000));
  });

  // The check the user asked for: an asserted birthday must not sit above known
  // activity, because syncing from it would start past those funds.
  it('flags a conflict when an asserted height is later than the first transaction', async () => {
    first.mockResolvedValue(activity(1_388_662));
    const out = await resolveBirthdayClaim({
      indexerUrl: INDEXER,
      networkId: 'preprod',
      claim: {kind: 'height', value: 1_905_019},
      seedHex: SEED_HEX,
    });
    expect(out.conflict?.firstActivityHeight).toBe(1_388_662);
    // The message must not claim the unshielded funds are lost — they are not.
    // Issue #49: the check can only prove unshielded activity, and unshielded is
    // the one thing a late birthday cannot hide.
    expect(out.conflict?.message).toContain('was already active at block 1388662');
    expect(out.conflict?.message).toContain('unshielded funds would still be found');
    expect(out.conflict?.message).toContain('SHIELDED');
  });

  it('accepts an asserted height at or below the first transaction', async () => {
    first.mockResolvedValue(activity(1_388_662));
    for (const value of [1_388_662, 1_000_000]) {
      const out = await resolveBirthdayClaim({
        indexerUrl: INDEXER,
        networkId: 'preprod',
        claim: {kind: 'height', value},
        seedHex: SEED_HEX,
      });
      expect(out.conflict).toBeUndefined();
      expect(out.height).toBe(value);
    }
  });

  it('applies the same check to a date-derived height', async () => {
    heightFor.mockResolvedValue({height: 1_905_019});
    first.mockResolvedValue(activity(1_388_662));
    const out = await resolveBirthdayClaim({
      indexerUrl: INDEXER,
      networkId: 'preprod',
      claim: {kind: 'date', value: '2026-08-01T00:00:00.000Z'},
      seedHex: SEED_HEX,
    });
    expect(out.conflict?.firstActivityHeight).toBe(1_388_662);
  });

  // The most dangerous mistake: "this seed is brand new" when it is not.
  it('applies the same check to --birthday-tip', async () => {
    first.mockResolvedValue(activity(1_388_662));
    const out = await resolveBirthdayClaim({
      indexerUrl: INDEXER,
      networkId: 'preprod',
      claim: {kind: 'tip'},
      seedHex: SEED_HEX,
      tipHeight: 2_180_000,
    });
    expect(out.conflict?.firstActivityHeight).toBe(1_388_662);
  });

  it('imports unverified rather than blocking when the indexer cannot be reached', async () => {
    first.mockRejectedValue(new Error('indexer down'));
    const out = await resolveBirthdayClaim({
      indexerUrl: INDEXER,
      networkId: 'preprod',
      claim: {kind: 'height', value: 1_905_019},
      seedHex: SEED_HEX,
    });
    expect(out.height).toBe(1_905_019);
    expect(out.conflict).toBeUndefined();
    expect(out.notes.join(' ')).toContain('unverified');
  });

  it('skips the check when no seed is available to derive an address from', async () => {
    const out = await resolveBirthdayClaim({
      indexerUrl: INDEXER,
      networkId: 'preprod',
      claim: {kind: 'height', value: 1_905_019},
    });
    expect(out.height).toBe(1_905_019);
    expect(first).not.toHaveBeenCalled();
  });
});

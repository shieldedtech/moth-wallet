import {describe, expect, it} from 'vitest';
import {toGetStateResult, dustViewToWire} from '../../../src/daemon/state-wire.js';
import {EMPTY_COINS, EMPTY_DUST_VIEW, EMPTY_SUB_PROGRESS, type WalletBalances} from '../../../src/sync/wallet-sync.js';

const T0 = Date.parse('2026-09-22T14:40:00Z');
const NIGHT = '0'.repeat(64);

function balances(over: Partial<WalletBalances> = {}): WalletBalances {
  return {
    shielded: {},
    unshielded: {[NIGHT]: 1_000_000_000n},
    dust: 305_500_000_000_000n,
    dustGeneration: null,
    syncProgress: {percentage: 1, etaSeconds: 0, slowest: null, shieldedSynced: true, unshieldedSynced: true, dustSynced: true},
    synced: true,
    coins: EMPTY_COINS,
    subProgress: EMPTY_SUB_PROGRESS,
    ...over,
  };
}

describe('toGetStateResult', () => {
  it('keeps the original three totals and adds the per-coin dust breakdown as strings and ISO dates', () => {
    const r = toGetStateResult(
      balances({
        coins: {
          ...EMPTY_COINS,
          dust: {
            available: [
              {
                generatedNow: 522_500_000_000_000n,
                maxCap: 50_000_000_000_000_000n,
                maxCapReachedAt: new Date(T0 + 7 * 86_400_000),
                dtime: null,
                backingNight: '0ff2f705796e703d',
                seq: 16,
                initialValue: 180_040_799_999_984n,
                ctime: new Date(Date.parse('2026-09-22T14:12:54Z')),
              },
            ],
            pending: [],
          },
        },
      }),
      {walletName: 'spartacus-preprod-0', networkId: 'preprod'},
    );
    expect(r.ready).toBe(true);
    expect(r.balances).toEqual({shielded: {}, unshielded: {[NIGHT]: '1000000000'}, dust: '305500000000000'});
    expect(r.coins?.dust.available).toEqual([
      {
        generatedNow: '522500000000000',
        maxCap: '50000000000000000',
        maxCapReachedAt: new Date(T0 + 7 * 86_400_000).toISOString(),
        dtime: null,
        backingNight: '0ff2f705796e703d',
        seq: 16,
        initialValue: '180040799999984',
        ctime: '2026-09-22T14:12:54.000Z',
      },
    ]);
    expect(r.subProgress).toEqual(EMPTY_SUB_PROGRESS);
    // Survives JSON, which is the whole point of the wire shape.
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it('carries the dust view verdict, with the missing coins', () => {
    const r = toGetStateResult(
      balances({
        syncProgress: {percentage: 1, etaSeconds: 0, slowest: null, shieldedSynced: true, unshieldedSynced: true, dustSynced: false},
        dustView: {
          ...EMPTY_DUST_VIEW,
          status: 'incomplete',
          checkedAt: T0,
          verdictAt: T0,
          complete: false,
          missing: [{generationMtIndex: 397_204, night: 990_000_000n, backingNight: '1e0d0fc0', generatingSinceMs: T0 - 3_600_000, missingSinceMs: T0 - 600_000}],
          localApplied: 1_549_223,
          indexerMaxId: 1_549_339,
          behindBy: 116,
          liveEntries: 2,
          reason: '1 live generation entry backing 990 NIGHT have no coin in the local view',
        },
      }),
      {walletName: 'w', networkId: 'preprod'},
    );
    expect(r.syncProgress?.dustSynced).toBe(false);
    expect(r.dustView).toMatchObject({
      status: 'incomplete',
      checkedAt: new Date(T0).toISOString(),
      verdictAt: new Date(T0).toISOString(),
      complete: false,
      lastError: null,
      behindBy: 116,
      missing: [{generationMtIndex: 397_204, night: '990000000', missingSince: new Date(T0 - 600_000).toISOString()}],
    });
  });

  it('reports a null view for balances built outside a sync session', () => {
    expect(toGetStateResult(balances(), {walletName: 'w', networkId: 'devnet'}).dustView).toBeNull();
    expect(dustViewToWire(undefined)).toBeNull();
  });

  it('never throws on an invalid date', () => {
    const r = toGetStateResult(
      balances({coins: {...EMPTY_COINS, dust: {available: [{generatedNow: 0n, maxCap: 0n, maxCapReachedAt: new Date(NaN), dtime: null}], pending: []}}}),
      {walletName: 'w', networkId: 'devnet'},
    );
    expect(r.coins?.dust.available[0]!.maxCapReachedAt).toBe(new Date(0).toISOString());
  });
});

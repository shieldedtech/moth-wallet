import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import {
  etaDisplay,
  initialSyncDisplayState,
  REAL_REGRESSION_BELOW,
  SyncStatus,
  syncDisplayReducer,
} from '../components/moth/sync-status';
import { syncStatusView } from '../lib/ui/sync-view';

describe('SyncStatus', () => {
  it('names the network-independent DUST wallet in sync progress', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25, overall: 25, synced: false }} defaultOpen />,
    );

    expect(html).toContain('>DUST</span>');
    expect(html).not.toContain('tDUST');
  });

  // Seen on mainnet: the rows' average of 100, 100 and 99 is 99.67, which
  // rounded to a "Synced" the DUST wallet had not reached.
  it('does not call itself synced while a row is still short', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 100, dust: 99, overall: 99, synced: false }} defaultOpen />,
    );

    expect(html).toContain('aria-label="Syncing, 99%"');
    expect(html).not.toContain('>Synced</span>');
  });

  // Rows at 100 passed the old averaging whatever the verdict said.
  it('follows the verdict, not the rows, for synced', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 100, dust: 100, overall: 99, synced: false }} />,
    );

    expect(html).toContain('aria-label="Syncing, 99%"');
    expect(html).not.toContain('>Synced</span>');
  });

  it('shows an initial sync immediately', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25, overall: 25, synced: false }} />,
    );

    expect(html).toContain('aria-label="Syncing, 25%"');
    expect(html).not.toContain('>Synced</span>');
  });

  it('keeps a previously synced status during a brief tip regression', () => {
    const synced = initialSyncDisplayState(true);
    const catchingUp = syncDisplayReducer(synced, { type: 'source', synced: false });

    expect(catchingUp).toEqual({
      hasSynced: true,
      synced: true,
      waitingForRegression: true,
    });

    const caughtUp = syncDisplayReducer(catchingUp, { type: 'source', synced: true });
    expect(caughtUp).toEqual(initialSyncDisplayState(true));
  });

  it('shows syncing when a regression outlasts the grace period', () => {
    const catchingUp = syncDisplayReducer(initialSyncDisplayState(true), {
      type: 'source',
      synced: false,
    });

    expect(syncDisplayReducer(catchingUp, { type: 'regressionGraceElapsed' })).toEqual({
      hasSynced: true,
      synced: false,
      waitingForRegression: false,
    });
  });

  it('resets the grace history when balances are cleared', () => {
    expect(syncDisplayReducer(initialSyncDisplayState(true), { type: 'reset' })).toEqual(
      initialSyncDisplayState(false),
    );
  });
});
// A rebuild drops progress to near zero. Holding "Synced · 100%" over minutes of
// genuine rescanning answers a user who asked for the rescan with "nothing to
// do". Decided in the reducer so it is pure — and so the fraction never becomes
// an effect dependency, which re-armed the grace timer on every emission and
// meant a regression that kept making progress never elapsed at all.
describe('a real regression bypasses the grace', () => {
  const synced = initialSyncDisplayState(true);

  it('resets immediately when the fraction drops below the threshold', () => {
    const next = syncDisplayReducer(synced, { type: 'source', synced: false, fraction: 0.3 });

    expect(next.synced).toBe(false);
    expect(next.hasSynced).toBe(false);
    expect(next.waitingForRegression).toBe(false);
  });

  it('still waits out a small dip, which is an ordinary tip advance', () => {
    const next = syncDisplayReducer(synced, { type: 'source', synced: false, fraction: 0.995 });

    expect(next.synced).toBe(true);
    expect(next.waitingForRegression).toBe(true);
  });

  // The band the effect-dependency bug lived in: big enough to be a real
  // resync, small enough that the old code kept re-arming the timer forever.
  it('waits out a drop just above the threshold rather than resetting', () => {
    const next = syncDisplayReducer(synced, { type: 'source', synced: false, fraction: 0.95 });

    expect(next.synced).toBe(true);
    expect(next.waitingForRegression).toBe(true);
  });

  it('is exclusive at the threshold', () => {
    expect(
      syncDisplayReducer(synced, { type: 'source', synced: false, fraction: REAL_REGRESSION_BELOW }).synced,
    ).toBe(true);
    expect(
      syncDisplayReducer(synced, { type: 'source', synced: false, fraction: REAL_REGRESSION_BELOW - 0.001 }).synced,
    ).toBe(false);
  });

  it('falls back to the grace when there is no fraction to judge', () => {
    const next = syncDisplayReducer(synced, { type: 'source', synced: false });

    expect(next.synced).toBe(true);
    expect(next.waitingForRegression).toBe(true);
  });
});

describe('etaDisplay', () => {
  it('shows nothing when there is nothing worth showing', () => {
    expect(etaDisplay(null)).toBeNull();
    expect(etaDisplay(undefined)).toBeNull();
    expect(etaDisplay(0)).toBeNull();
    expect(etaDisplay(-5)).toBeNull();
  });

  it('buckets seconds by five, with a floor', () => {
    expect(etaDisplay(1)).toEqual({ unit: 'seconds', value: 5 });
    expect(etaDisplay(7)).toEqual({ unit: 'seconds', value: 5 });
    expect(etaDisplay(43)).toEqual({ unit: 'seconds', value: 45 });
  });

  // The old scale read "~90s" at 89 and "~2 min" at 90, and "~60s" one tick
  // before "~1 min". Handing over at 60, capped at 55, removes both.
  it('hands over to minutes at 60 without an overlapping second', () => {
    expect(etaDisplay(58)).toEqual({ unit: 'seconds', value: 55 });
    expect(etaDisplay(59)).toEqual({ unit: 'seconds', value: 55 });
    expect(etaDisplay(60)).toEqual({ unit: 'minutes', value: 1 });
    expect(etaDisplay(89)).toEqual({ unit: 'minutes', value: 1 });
    expect(etaDisplay(90)).toEqual({ unit: 'minutes', value: 2 });
  });

  it('never rounds a positive estimate down to zero minutes', () => {
    expect(etaDisplay(61)).toEqual({ unit: 'minutes', value: 1 });
  });

  it('splits hours from minutes only when there is a remainder', () => {
    expect(etaDisplay(3_600)).toEqual({ unit: 'hours', value: 1 });
    expect(etaDisplay(3_660)).toEqual({ unit: 'hoursMinutes', value: 1, minutes: 1 });
    expect(etaDisplay(7_200)).toEqual({ unit: 'hours', value: 2 });
  });
});

// `defaultOpen`, because the ETA sits beside the percentage in the expanded
// detail — the collapsed pill carries the percentage only in its aria-label.
describe('the ETA on screen', () => {
  it('appears beside the percentage while syncing', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25, overall: 25, synced: false, etaSeconds: 300 }} defaultOpen />,
    );

    expect(html).toContain('~5 min left');
  });

  it('is absent when core cannot estimate one', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25, overall: 25, synced: false, etaSeconds: null }} defaultOpen />,
    );

    expect(html).not.toContain('left');
  });

  // An ETA beside a completion state reads as a contradiction.
  it('is absent once synced', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 100, dust: 100, overall: 100, synced: true, etaSeconds: 300 }} defaultOpen />,
    );

    expect(html).toContain('>Synced</span>');
    expect(html).not.toContain('left');
  });
});

describe('syncStatusView', () => {
  const full = { applied: 500, total: 500 };
  const balances = (over: {
    synced: boolean;
    percentage: number;
    dust?: { applied: number; total: number };
    dustSynced?: boolean;
  }) =>
    ({
      synced: over.synced,
      subProgress: { shielded: full, unshielded: full, dust: over.dust ?? full },
      syncProgress: {
        percentage: over.percentage,
        etaSeconds: null,
        slowest: null,
        shieldedSynced: true,
        unshieldedSynced: true,
        dustSynced: over.dustSynced ?? true,
      },
    }) as unknown as WalletBalances;

  // The indexer connection dropped on a caught-up wallet: the facade's live
  // verdict goes false and core holds its percentage at 99, but the flags the
  // rows and the DUST panel read are carried forward. The badge stays with them
  // rather than spinning at 99% for as long as the outage lasts.
  it('stays synced with the rows and the DUST panel when only the live verdict drops', () => {
    const view = syncStatusView(balances({ synced: false, percentage: 0.99 }));

    expect(view).toMatchObject({ shielded: 100, unshielded: 100, dust: 100, synced: true });
    expect(renderToStaticMarkup(<SyncStatus view={view} />)).toContain('>Synced</span>');
  });

  it('is not synced while one sub-wallet has yet to complete', () => {
    const view = syncStatusView(
      balances({ synced: false, percentage: 0.99, dust: { applied: 4950, total: 5000 }, dustSynced: false }),
    );

    expect(view).toMatchObject({ shielded: 100, unshielded: 100, dust: 99, overall: 99, synced: false });
    expect(renderToStaticMarkup(<SyncStatus view={view} />)).toContain('aria-label="Syncing, 99%"');
  });

  it("takes the overall figure from core's slowest-sub-wallet percentage", () => {
    const view = syncStatusView(
      balances({ synced: false, percentage: 0.25, dust: { applied: 125, total: 500 }, dustSynced: false }),
    );

    expect(view.overall).toBe(25);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  etaDisplay,
  initialSyncDisplayState,
  REAL_REGRESSION_BELOW,
  SyncStatus,
  syncDisplayReducer,
} from '../components/moth/sync-status';

describe('SyncStatus', () => {
  it('names the network-independent DUST wallet in sync progress', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25 }} defaultOpen />,
    );

    expect(html).toContain('>DUST</span>');
    expect(html).not.toContain('tDUST');
  });

  it('shows an initial sync immediately', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25 }} />,
    );

    expect(html).toContain('aria-label="Syncing, 67%"');
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
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25, etaSeconds: 300 }} defaultOpen />,
    );

    expect(html).toContain('~5 min left');
  });

  it('is absent when core cannot estimate one', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 75, dust: 25, etaSeconds: null }} defaultOpen />,
    );

    expect(html).not.toContain('left');
  });

  // An ETA beside a completion state reads as a contradiction.
  it('is absent once synced', () => {
    const html = renderToStaticMarkup(
      <SyncStatus view={{ shielded: 100, unshielded: 100, dust: 100, etaSeconds: 300 }} defaultOpen />,
    );

    expect(html).toContain('>Synced</span>');
    expect(html).not.toContain('left');
  });
});

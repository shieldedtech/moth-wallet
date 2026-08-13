import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  initialSyncDisplayState,
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

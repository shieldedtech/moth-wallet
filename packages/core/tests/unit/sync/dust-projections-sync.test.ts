// From `forks.v9` moth's DUST wallet syncs from the indexer's projections
// rather than replaying every DUST ledger event. These pin which sync service
// each side of the fork is built with; ledger-v8 has no projections path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletFacade, type DefaultConfiguration } from '@midnightntwrk/wallet-sdk/facade';
import { ProtocolVersion } from '@midnightntwrk/wallet-sdk';
import { TerminatingDustWallet } from '../../../src/sync/dust-transacting.js';
import { deriveWalletKeys } from '../../../src/sync/operations.js';

const sync = vi.hoisted(() => ({ eventLess: vi.fn(), events: vi.fn() }));

vi.mock('@midnightntwrk/wallet-sdk/dust/v2', async (importOriginal) => {
  const original = await importOriginal<typeof import('@midnightntwrk/wallet-sdk/dust/v2')>();
  const { makeEventLessSyncService, makeDefaultSyncService } = original.SyncService;
  return {
    ...original,
    SyncService: {
      ...original.SyncService,
      makeEventLessSyncService: (...args: Parameters<typeof makeEventLessSyncService>) => {
        sync.eventLess();
        return makeEventLessSyncService(...args);
      },
      makeDefaultSyncService: (...args: Parameters<typeof makeDefaultSyncService>) => {
        sync.events();
        return makeDefaultSyncService(...args);
      },
    },
  };
});

const base = WalletFacade.resolveConfiguration<DefaultConfiguration>({
  networkId: 'preprod',
  indexerClientConnection: { indexerHttpUrl: 'http://127.0.0.1:9/api', indexerWsUrl: 'ws://127.0.0.1:9/api/ws' },
  relayURL: new URL('ws://127.0.0.1:9'),
  costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 0 },
});

/** A configuration whose chain answers that it is at `version`, so the start needs no indexer. */
const chainAt = (version: ProtocolVersion.ProtocolVersion) => ({ ...base, chainVersionProbe: async () => version });

const stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  sync.eventLess.mockClear();
  sync.events.mockClear();
});

describe("moth's DUST wallet sync", () => {
  const seed = deriveWalletKeys('01'.repeat(64)).dust;

  // Also guards the start key derivation `withSync` drops: without it the seed
  // start fails at runtime, and nothing in the types says so.
  it('reads projections on a chain past the fork', async () => {
    const wallet = await TerminatingDustWallet(chainAt(base.forks.v9)).startWithSeed(seed);
    stoppers.push(() => wallet.stop());
    expect(sync.eventLess).toHaveBeenCalled();
    expect(sync.events).not.toHaveBeenCalled();
  });

  it('keeps reading projections when restored from a snapshot written past the fork', async () => {
    const started = await TerminatingDustWallet(chainAt(base.forks.v9)).startWithSeed(seed);
    stoppers.push(() => started.stop());
    const snapshot = await started.serializeState();
    sync.eventLess.mockClear();

    const restored = TerminatingDustWallet(chainAt(base.forks.v9)).restore(snapshot);
    stoppers.push(() => restored.stop());
    expect(sync.eventLess).toHaveBeenCalled();
    expect(sync.events).not.toHaveBeenCalled();
  });
});

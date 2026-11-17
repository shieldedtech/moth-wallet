// From `forks.v9` moth's DUST wallet syncs from the indexer's projections
// rather than replaying every DUST ledger event. These pin which sync service
// each side of the fork is built with; ledger-v8 has no projections path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Option } from 'effect';
import { WalletFacade, type DefaultConfiguration } from '@midnightntwrk/wallet-sdk/facade';
import { ProtocolVersion } from '@midnightntwrk/wallet-sdk';
import { TerminatingDustWallet } from '../../../src/sync/dust-transacting.js';
import { deriveWalletKeys } from '../../../src/sync/operations.js';

const sync = vi.hoisted(() => ({ eventLess: vi.fn(), events: vi.fn(), timelineSearch: vi.fn() }));

vi.mock('@midnightntwrk/wallet-sdk/dust/v2', async (importOriginal) => {
  const original = await importOriginal<typeof import('@midnightntwrk/wallet-sdk/dust/v2')>();
  const { makeEventLessSyncService, makeDefaultSyncService } = original.SyncService;
  return {
    ...original,
    SyncService: {
      ...original.SyncService,
      // Answers "nothing found", the best-effort fallback: the start must then
      // be the one it would be without the option.
      findDustTimelineStart: (...args: Parameters<typeof original.SyncService.findDustTimelineStart>) => {
        sync.timelineSearch(...args);
        return Effect.succeed(Option.none());
      },
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
  sync.timelineSearch.mockClear();
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

  // wallet-sync turns skipLedgerV8DustHistory on for every wallet. It only
  // reaches the SDK through the probe TerminatingDustWallet adds, so a fresh
  // start must ask where the DUST timeline reaches the fork.
  it('asks where the DUST timeline reaches the fork on a fresh start that skips the ledger-v8 history', async () => {
    const config = { ...chainAt(base.forks.v9), skipLedgerV8DustHistory: true };
    const wallet = await TerminatingDustWallet(config).startWithSeed(seed);
    stoppers.push(() => wallet.stop());

    expect(sync.timelineSearch).toHaveBeenCalledWith(expect.anything(), base.forks.v9);
    // Nothing found: the start is the ordinary one, still on projections.
    expect(sync.eventLess).toHaveBeenCalled();
  });

  it('does not search the timeline when restoring, which resumes from its snapshot', async () => {
    const config = { ...chainAt(base.forks.v9), skipLedgerV8DustHistory: true };
    const started = await TerminatingDustWallet(config).startWithSeed(seed);
    stoppers.push(() => started.stop());
    const snapshot = await started.serializeState();
    sync.timelineSearch.mockClear();

    const restored = TerminatingDustWallet(config).restore(snapshot);
    stoppers.push(() => restored.stop());
    expect(sync.timelineSearch).not.toHaveBeenCalled();
  });

  it('does not search the timeline without the option', async () => {
    const wallet = await TerminatingDustWallet(chainAt(base.forks.v9)).startWithSeed(seed);
    stoppers.push(() => wallet.stop());
    expect(sync.timelineSearch).not.toHaveBeenCalled();
  });
});

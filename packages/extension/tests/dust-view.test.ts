import { describe, expect, it } from 'vitest';
import { dustView } from '../lib/ui/dust-view';
import { TESTNET_NATIVE_ASSET_LABELS } from '../lib/ui/token-labels';
import { makeBalances } from './balances-fixture';

const labels = TESTNET_NATIVE_ASSET_LABELS;

describe('dustView', () => {
  it('never claims fully generated while the dust sub-wallet is syncing', () => {
    // Mid-sync the balance can momentarily sit at (or above) a partial cap.
    const view = dustView(makeBalances({ dust: 5_000_000n, limit: 5_000_000n, dustSynced: false }), labels);

    expect(view.syncing).toBe(true);
    expect(view.percent).toBe(100);
    expect(view.etaText).toBe('Syncing…');
  });

  it('reports fully generated once synced at the cap', () => {
    const view = dustView(makeBalances({ dust: 5_000_000n, limit: 5_000_000n, dustSynced: true }), labels);

    expect(view.syncing).toBe(false);
    expect(view.etaText).toBe('Fully generated');
  });

  it('accepts a grace-period sync state while the raw wallet catches up', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, dustSynced: false });
    const view = dustView(balances, labels, true);

    expect(view.syncing).toBe(false);
    expect(view.etaText).toBe('Fully generated');
  });

  it('shows an ETA when synced below the cap', () => {
    const fillTime = new Date(Date.now() + 2 * 3_600_000);
    const view = dustView(makeBalances({ dust: 1_000_000n, limit: 5_000_000n, dustSynced: true, fillTime }), labels);

    expect(view.percent).toBe(20);
    expect(view.etaText).toMatch(/Full in about 2 hours/);
  });

  it('scales the ETA to days once it is more than ~2 days out', () => {
    const fillTime = new Date(Date.now() + 167 * 3_600_000);
    const view = dustView(makeBalances({ dust: 1_000_000n, limit: 5_000_000n, dustSynced: true, fillTime }), labels);

    expect(view.etaText).toBe('Full in about 7 days');
  });

  it('waits for NIGHT when there is nothing to generate from', () => {
    const view = dustView(makeBalances({ dustSynced: true }), labels);

    expect(view.etaText).toBe(`Waiting for ${labels.night}`);
  });

  describe('canRebuild', () => {
    const NIGHT = 4_424n * 10n ** 6n;
    // Older than the grace period, so the deficit is no longer explained by
    // records still settling.
    const stale = () => new Date(Date.now() - 5 * 3_600_000);

    it('offers a rebuild when registered NIGHT has no generation records', () => {
      const view = dustView(
        makeBalances({
          night: NIGHT,
          limit: 15_000n * 10n ** 15n,
          registered: true,
          registeredNight: NIGHT,
          generatingNight: 0n,
          newestRegisteredAt: stale(),
          dustSynced: true,
        }),
        labels,
      );

      expect(view.canRebuild).toBe(true);
    });

    it('does not offer one while records may still be settling', () => {
      const view = dustView(
        makeBalances({
          night: NIGHT,
          limit: 15_000n * 10n ** 15n,
          registered: true,
          registeredNight: NIGHT,
          generatingNight: 0n,
          newestRegisteredAt: new Date(Date.now() - 60_000),
          dustSynced: true,
        }),
        labels,
      );

      expect(view.canRebuild).toBe(false);
    });

    it('does not offer one without a deficit, or mid-sync', () => {
      const healthy = makeBalances({
        night: NIGHT,
        limit: 15_000n * 10n ** 15n,
        registered: true,
        registeredNight: NIGHT,
        generatingNight: NIGHT,
        newestRegisteredAt: stale(),
        dustSynced: true,
      });
      expect(dustView(healthy, labels).canRebuild).toBe(false);

      const syncing = makeBalances({
        night: NIGHT,
        limit: 15_000n * 10n ** 15n,
        registered: true,
        registeredNight: NIGHT,
        generatingNight: 0n,
        newestRegisteredAt: stale(),
        dustSynced: false,
      });
      expect(dustView(syncing, labels).canRebuild).toBe(false);
    });
  });
});

// "Waiting for tNIGHT" was shown whenever generation capacity was zero — which
// is also true of a funded wallet that simply has not registered. Being told to
// wait for something you already hold is worse than being told nothing.
describe('dustView registration state', () => {
  it('says "waiting" only when the wallet holds no NIGHT', () => {
    const view = dustView(makeBalances({ dust: 0n, limit: 0n, night: 0n, dustSynced: true }), labels);
    expect(view.etaText).toBe('Waiting for tNIGHT');
    expect(view.unregisteredNight).toBe(false);
  });

  it('says "not registered yet" when NIGHT is held but not registered', () => {
    const view = dustView(
      makeBalances({ dust: 0n, limit: 0n, night: 5_000n * 10n ** 6n, registered: false, dustSynced: true }),
      labels,
    );
    expect(view.etaText).toBe('tNIGHT not registered yet');
    expect(view.unregisteredNight).toBe(true);
    // The distinction the old copy could not draw.
    expect(view.etaText).not.toContain('Waiting');
  });

  it('reports an ETA once NIGHT is registered and generating', () => {
    const view = dustView(
      makeBalances({
        dust: 1_000_000n,
        limit: 5_000_000n,
        night: 5_000n * 10n ** 6n,
        registered: true,
        dustSynced: true,
      }),
      labels,
    );
    expect(view.unregisteredNight).toBe(false);
    expect(view.etaText).not.toContain('Waiting');
    expect(view.etaText).not.toContain('not registered');
  });

  it('prefers the syncing message over either, since amounts are provisional', () => {
    const view = dustView(
      makeBalances({ dust: 0n, limit: 0n, night: 5_000n * 10n ** 6n, registered: false, dustSynced: false }),
      labels,
    );
    expect(view.etaText).toBe('Syncing…');
  });
});

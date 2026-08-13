import { describe, expect, it } from 'vitest';
import {
  DUST_HEAL_COOLDOWN_MS,
  DUST_VIEW_STALE_AFTER_MS,
  dustHealKey,
  shouldRepairDustView,
} from '../lib/offscreen/dust-heal';
import { makeBalances } from './balances-fixture';

const NOW = Date.parse('2026-07-15T12:00:00Z');
const NIGHT = 4_424n * 10n ** 6n;
const GENERATING = 3_000n * 10n ** 6n;
const OLD_ENOUGH = new Date(NOW - DUST_VIEW_STALE_AFTER_MS - 60_000);

function staleView(overrides: Parameters<typeof makeBalances>[0] = {}) {
  return makeBalances({
    night: NIGHT,
    limit: 15_000n * 10n ** 15n,
    registered: true,
    registeredNight: NIGHT,
    generatingNight: GENERATING,
    newestRegisteredAt: OLD_ENOUGH,
    dustSynced: true,
    ...overrides,
  });
}

describe('shouldRepairDustView', () => {
  it('repairs a synced view whose old registered NIGHT has no generation records', () => {
    expect(shouldRepairDustView(staleView(), NOW, null)).toBe(true);
  });

  it('waits while records may still be settling (grace period + margin)', () => {
    const recent = staleView({ newestRegisteredAt: new Date(NOW - DUST_VIEW_STALE_AFTER_MS + 60_000) });
    expect(shouldRepairDustView(recent, NOW, null)).toBe(false);
  });

  it('never repairs mid-sync, unregistered, or without a deficit', () => {
    expect(shouldRepairDustView(staleView({ dustSynced: false }), NOW, null)).toBe(false);
    expect(shouldRepairDustView(staleView({ registered: false, registeredNight: 0n }), NOW, null)).toBe(false);
    expect(shouldRepairDustView(staleView({ generatingNight: NIGHT }), NOW, null)).toBe(false);
  });

  it('honors the cooldown between repairs', () => {
    expect(shouldRepairDustView(staleView(), NOW, NOW - DUST_HEAL_COOLDOWN_MS + 1)).toBe(false);
    expect(shouldRepairDustView(staleView(), NOW, NOW - DUST_HEAL_COOLDOWN_MS - 1)).toBe(true);
  });

  it('keys the cooldown per wallet and network', () => {
    expect(dustHealKey('preprod', 'alice')).not.toBe(dustHealKey('preprod', 'bob'));
    expect(dustHealKey('preprod', 'alice')).not.toBe(dustHealKey('devnet', 'alice'));
  });
});

import {describe, expect, it} from 'vitest';
import {
  spendableDust,
  summarizeDustGeneration,
  type DustCoinSnapshot,
  type RegisteredNightUtxo,
} from '../../../src/sync/dust-generation.js';

// Preprod-shaped parameters: 5 DUST per NIGHT (specks per STAR), a week to the cap.
const params = {nightDustRatio: 5n * 10n ** 9n, generationDecayRate: 8_267n, timeToCapSeconds: 604_800n};
const STAR = 10n ** 6n;
const DUST = 10n ** 15n;
const NOW = new Date('2026-09-22T09:00:00Z');

const night = (star: bigint, ctime: Date | null = NOW): RegisteredNightUtxo => ({value: star, ctime});

/** A DUST coin backed by `star` raw NIGHT, holding `generatedNow` specks. */
const coin = (star: bigint, generatedNow = 0n, dtime: Date | null = null): DustCoinSnapshot => ({
  maxCap: star * params.nightDustRatio,
  generatedNow,
  rate: star * params.generationDecayRate,
  dtime,
});

const atCap = (star: bigint): DustCoinSnapshot => coin(star, star * params.nightDustRatio);

const summarize = (
  registeredNight: RegisteredNightUtxo[],
  dustCoins: DustCoinSnapshot[],
  balance = 0n,
  now = NOW,
) => summarizeDustGeneration({balance, registeredNight, dustCoins, params, now});

const daysUntil = (fillTime: Date, from = NOW) => Math.round((fillTime.getTime() - from.getTime()) / 86_400_000);

describe('summarizeDustGeneration', () => {
  it('agrees with the dust coins once everything has settled', () => {
    const v = 50_000n * STAR;
    const g = summarize([night(v)], [coin(v, 113n * DUST)], 113n * DUST);

    expect(g.limit).toBe(v * params.nightDustRatio);
    expect(g.designated).toBe(v);
    expect(g.registeredNight).toBe(v);
    expect(g.registered).toBe(true);
    expect(g.numUtxos).toBe(1);
    expect(g.balance).toBe(113n * DUST);
  });

  // A submitted transaction books its NIGHT input and its DUST coin as pending.
  // Read off available coins alone the wallet showed "of 0 · not registered yet".
  it('keeps the cap while the transaction inputs are booked', () => {
    const v = 50_000n * STAR;
    const g = summarize([night(v)], [coin(v)]);

    expect(g.limit).toBe(v * params.nightDustRatio);
    expect(g.registered).toBe(true);
    expect(g.designated).toBe(v);
  });

  // Once the spend lands, the old coin's remainder keeps its full maxCap while
  // it decays, next to the fresh coin for the change UTXO: 250,000 + 249,500.
  it('does not count a coin whose backing NIGHT was spent', () => {
    const before = 50_000n * STAR;
    const after = 49_900n * STAR;
    const spent = coin(before, 0n, new Date(NOW.getTime() + 60_000));
    const g = summarize([night(after)], [spent, coin(after)]);

    expect(g.limit).toBe(after * params.nightDustRatio);
    expect(g.designated).toBe(after);
    expect(g.numUtxos).toBe(1);
  });

  it('follows the NIGHT while the dust sub-wallet still shows the old coin only', () => {
    const before = 50_000n * STAR;
    const after = 49_900n * STAR;
    const spent = coin(before, 0n, new Date(NOW.getTime() + 60_000));
    const g = summarize([night(after)], [spent]);

    expect(g.limit).toBe(after * params.nightDustRatio);
    expect(g.registered).toBe(true);
    // No generation record yet, which is what the heal policy keys on.
    expect(g.designated).toBe(0n);
  });

  it('trusts whichever sub-wallet already knows of the NIGHT', () => {
    const v = 4_424n * STAR;
    // Dust record seen, unshielded UTXO not yet.
    const g = summarize([], [coin(v)]);

    expect(g.limit).toBe(v * params.nightDustRatio);
    expect(g.registered).toBe(true);
    expect(g.registeredNight).toBe(0n);
  });

  it('reports nothing to generate from once all NIGHT is spent', () => {
    const v = 50_000n * STAR;
    const g = summarize([], [coin(v, 0n, NOW)], 90n * DUST);

    expect(g.limit).toBe(0n);
    expect(g.registered).toBe(false);
    expect(g.designated).toBe(0n);
    expect(g.numUtxos).toBe(0);
    expect(g.fillTime).toEqual(new Date(0));
    expect(g.newestRegisteredAt).toBeNull();
    expect(g.balance).toBe(90n * DUST);
  });

  it('sums several registered UTXOs and reports the newest', () => {
    const older = new Date(NOW.getTime() - 86_400_000);
    const g = summarize([night(1_000n * STAR, older), night(2_000n * STAR, NOW)], []);

    expect(g.registeredNight).toBe(3_000n * STAR);
    expect(g.limit).toBe(3_000n * STAR * params.nightDustRatio);
    expect(g.newestRegisteredAt).toEqual(NOW);
  });

  describe('fill time', () => {
    // The reported symptom, with the wallet from the screenshots: 6,603.615385
    // tNIGHT holding 12,959.88 of 33,018.07 tDUST, about 39% full. The SDK's
    // own maxCapReachedAt is ctime plus the whole 7 days whatever the coin
    // holds, and every spend resets ctime, so this read "about 7 days" after
    // each send. What remains is 61% of the climb, so it is about 4 days.
    const NIGHT_STAR = 6_603_615_385n;
    const held = 12_959_880_000_000_000_000n;

    it('counts only the climb that is left, not the whole climb', () => {
      const g = summarize([night(NIGHT_STAR)], [coin(NIGHT_STAR, held)], held);

      expect(g.limit).toBe(33_018_076_925_000_000_000n);
      expect(daysUntil(g.fillTime)).toBe(4);
      // The old reading, for contrast.
      expect(daysUntil(g.fillTime)).toBeLessThan(Number(params.timeToCapSeconds) / 86_400);
    });

    it('is now for a coin already at its cap', () => {
      const g = summarize([night(NIGHT_STAR)], [atCap(NIGHT_STAR)]);

      expect(g.fillTime).toEqual(NOW);
    });

    it('takes the slowest coin', () => {
      const v = 1_000n * STAR;
      const nearlyFull = coin(v, v * params.nightDustRatio - 1n);
      const empty = coin(v, 0n);
      const g = summarize([night(v), night(v)], [nearlyFull, empty]);

      expect(daysUntil(g.fillTime)).toBe(7);
    });

    it('allows registered NIGHT with no generation record the full climb', () => {
      const v = 4_424n * STAR;
      const ctime = new Date(NOW.getTime() - 3_600_000);
      const g = summarize([night(v, ctime)], []);

      expect(g.limit).toBe(v * params.nightDustRatio);
      expect(daysUntil(g.fillTime)).toBe(7);
      expect(g.newestRegisteredAt).toEqual(ctime);
    });

    it('measures from the moment it is asked, not from any coin timestamp', () => {
      const v = 1_000n * STAR;
      const later = new Date(NOW.getTime() + 3 * 86_400_000);
      const g = summarize([night(v)], [coin(v, 0n)], 0n, later);

      expect(daysUntil(g.fillTime, later)).toBe(7);
    });
  });
});

describe('spendableDust', () => {
  // Paying a fee moves the whole coin out of the ledger's spendable set until
  // the transaction lands: the balance fell 12,959.88 -> 9,354.74 -> 12,959.12
  // on a send whose fee was a fraction of a DUST.
  it('counts a coin booked to pay a fee', () => {
    const booked = [{generatedNow: 3_605_140_000_000_000_000n}];

    expect(spendableDust(9_354_740_000_000_000_000n, booked)).toBe(12_959_880_000_000_000_000n);
  });

  it('is the plain balance when nothing is in flight', () => {
    expect(spendableDust(12_959_880_000_000_000_000n, [])).toBe(12_959_880_000_000_000_000n);
  });

  it('counts every booked coin when the fee needed more than one', () => {
    const booked = [{generatedNow: 10n * DUST}, {generatedNow: 5n * DUST}];

    expect(spendableDust(100n * DUST, booked)).toBe(115n * DUST);
  });
});

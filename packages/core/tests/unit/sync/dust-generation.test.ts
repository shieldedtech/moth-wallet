import {describe, expect, it} from 'vitest';
import {
  secondsUntilFull,
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

/** A DUST coin backed by `star` raw NIGHT. */
const coin = (star: bigint, dtime: Date | null = null): DustCoinSnapshot => ({
  maxCap: star * params.nightDustRatio,
  dtime,
});

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
    const g = summarize([night(v)], [coin(v)], 113n * DUST);

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
    const spent = coin(before, new Date(NOW.getTime() + 60_000));
    const g = summarize([night(after)], [spent, coin(after)]);

    expect(g.limit).toBe(after * params.nightDustRatio);
    expect(g.designated).toBe(after);
    expect(g.numUtxos).toBe(1);
  });

  it('follows the NIGHT while the dust sub-wallet still shows the old coin only', () => {
    const before = 50_000n * STAR;
    const after = 49_900n * STAR;
    const spent = coin(before, new Date(NOW.getTime() + 60_000));
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
    const g = summarize([], [coin(v, NOW)], 90n * DUST);

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
    // tNIGHT holding 12,959.88 of 33,018.07 tDUST, about 39% full. Both the
    // SDK's maxCapReachedAt and the slowest-coin reading told it to wait the
    // seven days of a standing start. Only 61% of the climb is left.
    const NIGHT_STAR = 6_603_615_385n;
    const held = 12_959_880_000_000_000_000n;

    it('counts only the climb that is left', () => {
      const g = summarize([night(NIGHT_STAR)], [coin(NIGHT_STAR)], held);

      expect(g.limit).toBe(33_018_076_925_000_000_000n);
      expect(daysUntil(g.fillTime)).toBe(4);
      expect(daysUntil(g.fillTime)).toBeLessThan(Number(params.timeToCapSeconds) / 86_400);
    });

    // Every send leaves a fresh change UTXO whose own coin starts low, so a
    // per-coin reading is pinned near the full climb for any wallet in use —
    // which is what kept the meter at "about 7 days" through 39%, 42% and 45%.
    it('does not let the newest coin speak for a meter that is nearly full', () => {
      const v = 1_000n * STAR;
      const cap = v * params.nightDustRatio;
      const g = summarize([night(v), night(v)], [coin(v), coin(v)], 2n * cap - cap / 100n);

      expect(daysUntil(g.fillTime)).toBe(0);
    });

    it('is now once the meter reads full', () => {
      const cap = NIGHT_STAR * params.nightDustRatio;
      const g = summarize([night(NIGHT_STAR)], [coin(NIGHT_STAR)], cap);

      expect(g.fillTime).toEqual(NOW);
    });

    it('gives the full climb to a wallet holding no DUST yet', () => {
      const v = 4_424n * STAR;
      const ctime = new Date(NOW.getTime() - 3_600_000);
      const g = summarize([night(v, ctime)], [], 0n);

      expect(g.limit).toBe(v * params.nightDustRatio);
      expect(daysUntil(g.fillTime)).toBe(7);
      expect(g.newestRegisteredAt).toEqual(ctime);
    });

    it('measures from the moment it is asked, not from any coin timestamp', () => {
      const v = 1_000n * STAR;
      const later = new Date(NOW.getTime() + 3 * 86_400_000);
      const g = summarize([night(v)], [coin(v)], 0n, later);

      expect(daysUntil(g.fillTime, later)).toBe(7);
    });

    it('has nothing to say without capacity', () => {
      expect(summarize([], [], 0n).fillTime).toEqual(new Date(0));
    });
  });
});

// Still the right arithmetic for ONE coin's own countdown, which is what the
// TUI shows per row; only the wallet-wide meter reads the aggregate.
describe('secondsUntilFull', () => {
  it('is the remaining climb over the rate', () => {
    expect(secondsUntilFull({maxCap: 1_000n, generatedNow: 400n, rate: 2n})).toBe(300n);
  });

  it('rounds up, since a partial second still has to elapse', () => {
    expect(secondsUntilFull({maxCap: 1_000n, generatedNow: 999n, rate: 2n})).toBe(1n);
  });

  it('is zero at or past the cap', () => {
    expect(secondsUntilFull({maxCap: 1_000n, generatedNow: 1_000n, rate: 2n})).toBe(0n);
    expect(secondsUntilFull({maxCap: 1_000n, generatedNow: 2_000n, rate: 2n})).toBe(0n);
  });

  it('is unknown for a coin that generates nothing', () => {
    expect(secondsUntilFull({maxCap: 1_000n, generatedNow: 0n, rate: 0n})).toBeNull();
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

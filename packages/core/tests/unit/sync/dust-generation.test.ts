import {describe, expect, it} from 'vitest';
import {summarizeDustGeneration, type DustCoinSnapshot, type RegisteredNightUtxo} from '../../../src/sync/dust-generation.js';

// Devnet-shaped parameters: 5 DUST per NIGHT, a week to the cap.
const params = {nightDustRatio: 5n, generationDecayRate: 8_267n, timeToCapSeconds: 604_800n};
const STAR = 10n ** 6n;
const NOW = new Date('2026-09-22T09:00:00Z');
const WEEK_MS = 7 * 86_400_000;

const night = (value: bigint, ctime: Date | null = NOW): RegisteredNightUtxo => ({value, ctime});
const coin = (nightValue: bigint, ctime: Date = NOW, dtime: Date | null = null): DustCoinSnapshot => ({
  maxCap: nightValue * params.nightDustRatio,
  maxCapReachedAt: new Date(ctime.getTime() + WEEK_MS),
  dtime,
});

const summarize = (registeredNight: RegisteredNightUtxo[], dustCoins: DustCoinSnapshot[], balance = 0n) =>
  summarizeDustGeneration({balance, registeredNight, dustCoins, params});

describe('summarizeDustGeneration', () => {
  it('agrees with the dust coins once everything has settled', () => {
    const v = 50_000n * STAR;
    const g = summarize([night(v)], [coin(v)], 113n);

    expect(g.limit).toBe(v * 5n);
    expect(g.designated).toBe(v);
    expect(g.registeredNight).toBe(v);
    expect(g.registered).toBe(true);
    expect(g.numUtxos).toBe(1);
    expect(g.balance).toBe(113n);
    expect(g.fillTime).toEqual(new Date(NOW.getTime() + WEEK_MS));
    expect(g.ratePerDay).toBe(v * params.generationDecayRate * 86_400n);
  });

  // A submitted transaction books its NIGHT input and its DUST coin as pending.
  // Read off available coins alone the wallet showed "of 0 · not registered yet".
  it('keeps the cap while the transaction inputs are booked', () => {
    const v = 50_000n * STAR;
    // wallet-sync passes booked inputs alongside available ones.
    const g = summarize([night(v)], [coin(v)]);

    expect(g.limit).toBe(v * 5n);
    expect(g.registered).toBe(true);
    expect(g.designated).toBe(v);
  });

  // Once the spend lands, the old coin's remainder keeps its full maxCap while
  // it decays, next to the fresh coin for the change UTXO: 250,000 + 249,500.
  it('does not count a coin whose backing NIGHT was spent', () => {
    const before = 50_000n * STAR;
    const after = 49_900n * STAR;
    const spent = coin(before, NOW, new Date(NOW.getTime() + 60_000));
    const g = summarize([night(after)], [spent, coin(after)]);

    expect(g.limit).toBe(after * 5n);
    expect(g.designated).toBe(after);
    expect(g.numUtxos).toBe(1);
  });

  it('follows the NIGHT while the dust sub-wallet still shows the old coin only', () => {
    const before = 50_000n * STAR;
    const after = 49_900n * STAR;
    const spent = coin(before, NOW, new Date(NOW.getTime() + 60_000));
    const g = summarize([night(after)], [spent]);

    expect(g.limit).toBe(after * 5n);
    expect(g.registered).toBe(true);
    // No generation record yet, which is what the heal policy keys on.
    expect(g.designated).toBe(0n);
  });

  it('estimates the fill time from the NIGHT when its generation record is still missing', () => {
    const v = 4_424n * STAR;
    const ctime = new Date(NOW.getTime() - 3_600_000);
    const g = summarize([night(v, ctime)], []);

    expect(g.limit).toBe(v * 5n);
    expect(g.fillTime).toEqual(new Date(ctime.getTime() + WEEK_MS));
    expect(g.newestRegisteredAt).toEqual(ctime);
  });

  it('prefers the coin\'s own fill time, which restarts when DUST is spent on fees', () => {
    const v = 4_424n * STAR;
    const nightCtime = new Date(NOW.getTime() - 3 * 86_400_000);
    const g = summarize([night(v, nightCtime)], [coin(v, NOW)]);

    expect(g.fillTime).toEqual(new Date(NOW.getTime() + WEEK_MS));
  });

  it('trusts whichever sub-wallet already knows of the NIGHT', () => {
    const v = 4_424n * STAR;
    // Dust record seen, unshielded UTXO not yet.
    const g = summarize([], [coin(v)]);

    expect(g.limit).toBe(v * 5n);
    expect(g.registered).toBe(true);
    expect(g.registeredNight).toBe(0n);
  });

  it('reports nothing to generate from once all NIGHT is spent', () => {
    const v = 50_000n * STAR;
    const g = summarize([], [coin(v, NOW, NOW)], 90n);

    expect(g.limit).toBe(0n);
    expect(g.registered).toBe(false);
    expect(g.designated).toBe(0n);
    expect(g.numUtxos).toBe(0);
    expect(g.fillTime).toEqual(new Date(0));
    expect(g.newestRegisteredAt).toBeNull();
    expect(g.balance).toBe(90n);
  });

  it('sums several registered UTXOs and reports the newest', () => {
    const older = new Date(NOW.getTime() - 86_400_000);
    const g = summarize([night(1_000n * STAR, older), night(2_000n * STAR, NOW)], []);

    expect(g.registeredNight).toBe(3_000n * STAR);
    expect(g.limit).toBe(15_000n * STAR);
    expect(g.newestRegisteredAt).toEqual(NOW);
    expect(g.fillTime).toEqual(new Date(NOW.getTime() + WEEK_MS));
  });
});

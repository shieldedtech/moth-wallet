// Parity with the extension's DUST meter, which stopped reading the SDK's
// `maxCapReachedAt` for its countdown. That field is the coin's creation time
// plus the whole time-to-cap however full the coin already is, and paying a fee
// gives the change coin a fresh creation time, so a wallet sitting at 39% was
// told the from-nothing wait after every send.

import { describe, expect, it } from 'vitest';
import { formatDustFillRemaining } from '../../src/utils/display.js';

const NOW = new Date('2026-09-22T09:00:00Z');
const WEEK = 604_800n;

/** A coin backed by `star` raw NIGHT at the preprod ratio, holding `generatedNow`. */
const coin = (star: bigint, generatedNow: bigint) => {
  const maxCap = star * 5n * 10n ** 9n;
  return { maxCap, generatedNow, rate: maxCap / WEEK };
};

describe('formatDustFillRemaining', () => {
  it('counts only the climb that is left', () => {
    // The wallet from the report: 6,603.615385 tNIGHT at 12,959.88 of 33,018.07.
    const held = 12_959_880_000_000_000_000n;

    expect(formatDustFillRemaining(coin(6_603_615_385n, held), NOW)).toBe('4d 6h');
  });

  it('gives the full week to a coin starting from nothing', () => {
    expect(formatDustFillRemaining(coin(6_603_615_385n, 0n), NOW)).toBe('7d 0h');
  });

  it('reports a filled coin as complete', () => {
    const full = coin(1_000n * 10n ** 6n, 0n);

    expect(formatDustFillRemaining({ ...full, generatedNow: full.maxCap }, NOW)).toBe('Complete');
  });

  it('does not invent a countdown for a coin that generates nothing', () => {
    expect(formatDustFillRemaining({ maxCap: 100n, generatedNow: 1n, rate: 0n }, NOW)).toBe('Unknown');
  });
});

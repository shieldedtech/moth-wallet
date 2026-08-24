// The earliest height at which a wallet could hold DUST.
//
// DUST is non-transferable, so generation is the only way a wallet comes to hold
// any, and generation requires a registration. The first generation entry for a
// dust address is therefore a hard lower bound: below it, this wallet provably
// has no dust commitments, and a reference at or below it loses nothing.
//
// This is a stronger guarantee than the birthday gives. A shielded birthday can
// never be verified — coins are found by trial-decrypting outputs, so no query
// rules out an earlier receive. Generation entries are keyed by dust address, so
// this answer is queryable rather than asserted.
//
// Deliberately three-valued. "No entries returned" is not the same as "never
// generated": a truncated or timed-out subscription returns nothing either, and
// treating that as "no dust ever" would authorise seeding past real history.

import {dustGenerationsFor} from './dust-generations.js';
import {heightForDate} from './block-time.js';
import type {NetworkConfig} from '../types/network.js';

export type DustFloor =
  /** Never registered, so no dust can exist at any height. Any reference is safe. */
  | {readonly kind: 'never'}
  /** Provably no dust below this height. */
  | {readonly kind: 'height'; readonly height: number; readonly ctime: number}
  /** The question could not be answered; callers must fall back to the birthday. */
  | {readonly kind: 'unknown'; readonly reason: string};

export async function firstDustGenerationHeight(
  network: NetworkConfig,
  dustAddress: string,
  opts: {timeoutMs?: number} = {},
): Promise<DustFloor> {
  let result;
  try {
    result = await dustGenerationsFor(network.indexerUrl, dustAddress, {
      timeoutMs: opts.timeoutMs ?? 20_000,
      // Wide: too small a bound returns nothing and says nothing about why.
      endIndex: 2_000_000_000,
    });
  } catch (err) {
    return {kind: 'unknown', reason: `dust generation query failed: ${err}`};
  }

  if (result.entries.length === 0) {
    // A decay update proves generation exists even when no entry itself came
    // back, so it rules out "never" without giving a height.
    if (result.truncated || result.dtimeUpdates > 0) {
      return {
        kind: 'unknown',
        reason: result.truncated
          ? 'the dust generation query was cut short before it finished'
          : 'decay updates arrived but no generation entry, so the first one is unknown',
      };
    }
    return {kind: 'never'};
  }

  const earliest = result.entries.reduce((a, b) => (a.ctime <= b.ctime ? a : b));
  if (!Number.isFinite(earliest.ctime) || earliest.ctime <= 0) {
    return {kind: 'unknown', reason: 'the earliest generation entry carries no usable timestamp'};
  }

  try {
    // heightForDate resolves to a block at or BEFORE the timestamp, which is the
    // conservative direction: a floor that is slightly too low only makes the
    // gate stricter.
    const at = await heightForDate(network.indexerUrl, new Date(earliest.ctime * 1000));
    return {kind: 'height', height: at.height, ctime: earliest.ctime};
  } catch (err) {
    return {kind: 'unknown', reason: `could not map the first generation to a height: ${err}`};
  }
}

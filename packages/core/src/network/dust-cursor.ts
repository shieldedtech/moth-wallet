// Where in the dust event stream a given block sits.
//
// Building a reference that stops at a chosen height needs an answer to "which
// dust ledger event corresponds to block N", and the indexer does not expose
// one. What it does expose, per block, is `dustCommitmentEndIndex` and
// `dustGenerationEndIndex` — two different counters from the event stream the
// wallet's cursor indexes. Their sum tracks the cursor closely but not exactly.
// Measured against references whose cursors are known:
//
//   height 2064324  stored cursor 1415589  commit+gen 1417185  (+1596)
//   height 2104384  stored cursor 1431375  commit+gen 1431970  ( +595)
//
// The error is small but not constant, so the sum cannot be used as the cursor.
// It can be used as an upper bound with a margin subtracted, which is all a
// build needs: stopping EARLY is safe, because the reference then contains less
// than the height it claims. Claiming more than you contain is the direction
// that loses funds — a wallet whose birthday sits between the true content and
// the claim would be seeded past its own history.

import {IndexerClient} from './indexer-client.js';

/** Events of slack subtracted from the estimate. An order of magnitude above
 *  the largest error measured, and cheap: the reference simply stops a few
 *  hundred events sooner than it strictly had to. */
export const DUST_CURSOR_MARGIN = 5_000;

export interface DustCursorEstimate {
  /** The block this describes. */
  readonly height: number;
  /** `dustCommitmentEndIndex + dustGenerationEndIndex` at that block. */
  readonly approxCursor: number;
  /** Where a build should stop to be certainly at or below `height`. */
  readonly stopAt: number;
  readonly margin: number;
}

/**
 * Estimate the dust cursor at `height`, biased low.
 *
 * Returns null when the block cannot be read or carries no dust counters —
 * callers must treat that as "cannot build at this height" rather than
 * substituting a guess.
 */
export async function dustCursorAtHeight(
  indexerUrl: string,
  height: number,
  margin: number = DUST_CURSOR_MARGIN,
): Promise<DustCursorEstimate | null> {
  if (!Number.isInteger(height) || height <= 0) return null;
  const client = new IndexerClient(indexerUrl);
  const block = await client.getBlockCursors(height);
  if (!block) return null;

  const commit = numberOr(block.dustCommitmentEndIndex);
  const gen = numberOr(block.dustGenerationEndIndex);
  if (commit === null || gen === null) return null;

  const approxCursor = commit + gen;
  // A target so early that the margin swallows it is not buildable: there is no
  // cursor low enough to be sure about. Genesis is already the answer there.
  const stopAt = approxCursor - margin;
  if (stopAt <= 0) return null;

  return {height, approxCursor, stopAt, margin};
}

function numberOr(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

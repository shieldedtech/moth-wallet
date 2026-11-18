// Starts each of a DUST projections pass's nullifier lookups where the previous
// one matched, rather than at block zero as the SDK does; see
// docs/upstream-issues/dust-projections-nullifier-walk-rescans-chain.md.
// WASM-free, so the rule is unit-tested without the ledger.

import {Effect, Stream} from 'effect';

/** A nullifier lookup that can be told where to start. */
export type NullifierLookup<Nullifiers, Match extends {readonly blockHeight: number}, E, R> = (
  nullifiers: Nullifiers,
  fromBlock: number,
  toBlock: number | null,
  prefixLength: number,
) => Stream.Stream<Match, E, R>;

/**
 * One pass's nullifier lookups, each started at the earliest block the previous
 * one matched: a later lookup asks only for coins those matches created, and a
 * coin can be spent no earlier than the block that created it. Build one per pass.
 */
export const resumingFromLastSpend = <Nullifiers, Match extends {readonly blockHeight: number}, E, R>(
  lookup: NullifierLookup<Nullifiers, Match, E, R>,
): ((nullifiers: Nullifiers, toBlock: number | null, prefixLength: number) => Stream.Stream<Match, E, R>) => {
  let fromBlock = 0;
  return (nullifiers, toBlock, prefixLength) =>
    Stream.suspend(() => {
      let earliest: number | undefined;
      return lookup(nullifiers, fromBlock, toBlock, prefixLength).pipe(
        Stream.tap((match) =>
          Effect.sync(() => {
            earliest = Math.min(earliest ?? match.blockHeight, match.blockHeight);
            fromBlock = earliest;
          }),
        ),
      );
    });
};

/** A nullifier as the indexer encodes it: 32 bytes, little-endian, hex. */
export const nullifierLeHex = (nullifier: bigint): string =>
  Array.from({length: 32}, (_, i) =>
    Number((nullifier >> BigInt(8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  ).join('');

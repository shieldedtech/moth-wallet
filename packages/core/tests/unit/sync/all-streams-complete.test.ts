import { describe, expect, it } from 'vitest';
import { allStreamsComplete } from '../../../src/sync/progress.js';

// A wallet that has never held a shielded coin has an EMPTY shielded stream, and
// the SDK's isStrictlyComplete() is false for an empty stream — so `synced` never
// becomes true and every caller waiting on it waits out its timeout (300s in
// `moth balance`, a rejection in the extension). The display side already treats
// total === 0 as 100%, so the two disagreed about the same numbers.

const empty = { applied: 0, total: 0 };
const done = { applied: 4200, total: 4200 };
const behind = { applied: 100, total: 4200 };

describe('allStreamsComplete', () => {
  it('accepts an empty stream alongside streams that finished', () => {
    // The reported case: unshielded NIGHT only, never any shielded coin.
    expect(
      allStreamsComplete({
        shielded: empty,
        unshielded: done,
        dust: done,
        shieldedSynced: false, // isStrictlyComplete() on an empty stream
        unshieldedSynced: true,
        dustSynced: true,
      }),
    ).toBe(true);
  });

  it('refuses while any stream still has events to apply', () => {
    expect(
      allStreamsComplete({
        shielded: empty,
        unshielded: behind,
        dust: done,
        shieldedSynced: false,
        unshieldedSynced: false,
        dustSynced: true,
      }),
    ).toBe(false);
  });

  it('refuses at start-up, when every stream is empty only because nothing was reported yet', () => {
    // Field for field identical to three genuinely empty streams, which is why
    // completion needs a positive report from at least one of them. Resolving
    // here would print zeros as an authoritative balance.
    expect(
      allStreamsComplete({
        shielded: empty,
        unshielded: empty,
        dust: empty,
        shieldedSynced: false,
        unshieldedSynced: false,
        dustSynced: false,
      }),
    ).toBe(false);
  });

  it('accepts once one stream reports, even if the others are empty', () => {
    expect(
      allStreamsComplete({
        shielded: empty,
        unshielded: empty,
        dust: done,
        shieldedSynced: false,
        unshieldedSynced: false,
        dustSynced: true,
      }),
    ).toBe(true);
  });

  it('does not override an explicit not-complete verdict on a non-empty stream', () => {
    // applied >= total but isStrictlyComplete() says no: the SDK knows things the
    // counters do not (a lagging highestRelevantWalletIndex, events in flight).
    // Resolving here would hand `transfer` a balance to spend from.
    expect(
      allStreamsComplete({
        shielded: empty,
        unshielded: done,
        dust: empty,
        shieldedSynced: false,
        unshieldedSynced: false,
        dustSynced: false,
      }),
    ).toBe(false);
  });

  it('agrees with the facade when everything is genuinely complete', () => {
    expect(
      allStreamsComplete({
        shielded: done,
        unshielded: done,
        dust: done,
        shieldedSynced: true,
        unshieldedSynced: true,
        dustSynced: true,
      }),
    ).toBe(true);
  });
});

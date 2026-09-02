// The wedge-detection logic (docs/bugs-found.md-style report filed upstream):
// InvalidDustSpendProof is one client-visible signature covering a transient
// race, a ledger-version mismatch, and a permanently wedged devnet dust ledger.
// These tests pin the two gates that separate "wedged" from "unlucky": a
// streak of N independent rejections, AND blocks still being produced while
// it happens.

import {beforeEach, describe, expect, it} from 'vitest';
import {
  DEFAULT_WEDGE_THRESHOLD,
  DustLedgerWedgedError,
  DustSpendHealthTracker,
  diagnoseSubmissionFailure,
  isDustSpendProofRejection,
  dustSpendHealthTracker,
  resetDustSpendHealthTrackers,
} from '../../../src/sync/dust-ledger-health.js';
import {WalletError} from '../../../src/types/errors.js';

const V8_PROTOCOL = 1_000_000;
const V9_PROTOCOL = 2_000_000;
const NETWORK = {id: 'undeployed', indexerUrl: 'http://indexer.example'};

function proofRejection(): Error {
  return new Error('1010: Invalid Transaction: Custom error: 170');
}

function probeAt(height: number, protocolVersion = V8_PROTOCOL) {
  return async () => ({height, protocolVersion});
}

describe('isDustSpendProofRejection', () => {
  it('matches the client-visible custom-error-170 string', () => {
    expect(isDustSpendProofRejection(new Error('1010: Invalid Transaction: Custom error: 170'))).toBe(true);
  });

  it('matches the node-log spelling, case-insensitively', () => {
    expect(isDustSpendProofRejection(new Error('Malformed(InvalidDustSpendProof)'))).toBe(true);
  });

  it('does not match an unrelated rejection', () => {
    expect(isDustSpendProofRejection(new Error('1010: Invalid Transaction: Custom error: 231'))).toBe(false);
    expect(isDustSpendProofRejection(new Error('socket hang up'))).toBe(false);
  });
});

describe('DustSpendHealthTracker', () => {
  it('counts a consecutive streak and resets it on success', () => {
    const tracker = new DustSpendHealthTracker();
    expect(tracker.recordProofRejection(10)).toBe(1);
    expect(tracker.recordProofRejection(11)).toBe(2);
    tracker.recordSuccess();
    expect(tracker.consecutiveRejections).toBe(0);
    expect(tracker.recordProofRejection(20)).toBe(1);
  });

  it('resets on an unrelated failure, not just on success', () => {
    const tracker = new DustSpendHealthTracker();
    tracker.recordProofRejection(10);
    tracker.recordProofRejection(11);
    tracker.recordUnrelatedFailure();
    expect(tracker.consecutiveRejections).toBe(0);
  });

  it('reports blocksAdvancedSince relative to the height of the FIRST rejection in the streak, not the latest', () => {
    const tracker = new DustSpendHealthTracker();
    tracker.recordProofRejection(100);
    tracker.recordProofRejection(100); // same height as attempt 1 — still no progress
    expect(tracker.blocksAdvancedSince(100)).toBe(false);
    expect(tracker.blocksAdvancedSince(101)).toBe(true);
  });

  it('reports no advancement before any rejection has been recorded', () => {
    expect(new DustSpendHealthTracker().blocksAdvancedSince(999)).toBe(false);
  });
});

describe('dustSpendHealthTracker registry', () => {
  beforeEach(() => resetDustSpendHealthTrackers());

  it('returns the same tracker for the same network+wallet key', () => {
    expect(dustSpendHealthTracker('undeployed', 'alice')).toBe(dustSpendHealthTracker('undeployed', 'alice'));
  });

  it('keeps trackers for different wallets and networks independent', () => {
    expect(dustSpendHealthTracker('undeployed', 'alice')).not.toBe(dustSpendHealthTracker('undeployed', 'bob'));
    expect(dustSpendHealthTracker('undeployed', 'alice')).not.toBe(dustSpendHealthTracker('preprod', 'alice'));
  });
});

describe('diagnoseSubmissionFailure', () => {
  let tracker: DustSpendHealthTracker;

  beforeEach(() => {
    tracker = new DustSpendHealthTracker();
  });

  it('passes through an unrelated error untouched, without consuming the streak', async () => {
    const err = new Error('Insufficient Funds');
    const result = await diagnoseSubmissionFailure(tracker, err, {
      network: NETWORK,
      usingLedger: 'v8',
      probeBlock: probeAt(10),
    });
    expect(result).toBe(err);
    expect(tracker.consecutiveRejections).toBe(0);
  });

  it('never declares a wedge before the threshold, even with blocks advancing', async () => {
    let height = 100;
    for (let i = 0; i < DEFAULT_WEDGE_THRESHOLD - 1; i++) {
      const result = await diagnoseSubmissionFailure(tracker, proofRejection(), {
        network: NETWORK,
        usingLedger: 'v8',
        probeBlock: probeAt(height++),
      });
      expect(result).not.toBeInstanceOf(DustLedgerWedgedError);
    }
  });

  it('declares a wedge once the threshold is met and blocks kept advancing', async () => {
    let height = 100;
    let result: Error | undefined;
    for (let i = 0; i < DEFAULT_WEDGE_THRESHOLD; i++) {
      result = await diagnoseSubmissionFailure(tracker, proofRejection(), {
        network: NETWORK,
        usingLedger: 'v8',
        probeBlock: probeAt(height++),
      });
    }
    expect(result).toBeInstanceOf(DustLedgerWedgedError);
    expect((result as DustLedgerWedgedError).networkId).toBe('undeployed');
    expect((result as DustLedgerWedgedError).consecutiveRejections).toBe(DEFAULT_WEDGE_THRESHOLD);
    expect((result as DustLedgerWedgedError).message).toMatch(/reset/i);
  });

  it('does NOT declare a wedge if the chain height never moved — a stalled indexer looks identical from here', async () => {
    let result: Error | undefined;
    for (let i = 0; i < DEFAULT_WEDGE_THRESHOLD; i++) {
      result = await diagnoseSubmissionFailure(tracker, proofRejection(), {
        network: NETWORK,
        usingLedger: 'v8',
        probeBlock: probeAt(100), // same height every time
      });
    }
    expect(result).not.toBeInstanceOf(DustLedgerWedgedError);
  });

  it('resets the streak on a genuine success in between, so a lone flaky attempt never wedges', async () => {
    let height = 100;
    for (let i = 0; i < DEFAULT_WEDGE_THRESHOLD - 1; i++) {
      await diagnoseSubmissionFailure(tracker, proofRejection(), {
        network: NETWORK,
        usingLedger: 'v8',
        probeBlock: probeAt(height++),
      });
    }
    tracker.recordSuccess(); // the retry-with-a-fresh-timestamp that #6 documents succeeding
    const result = await diagnoseSubmissionFailure(tracker, proofRejection(), {
      network: NETWORK,
      usingLedger: 'v8',
      probeBlock: probeAt(height++),
    });
    expect(result).not.toBeInstanceOf(DustLedgerWedgedError);
    expect(tracker.consecutiveRejections).toBe(1);
  });

  it('reports a ledger-version mismatch instead of counting toward a wedge — that condition is recoverable by reconnecting', async () => {
    const result = await diagnoseSubmissionFailure(tracker, proofRejection(), {
      network: NETWORK,
      usingLedger: 'v8',
      probeBlock: probeAt(100, V9_PROTOCOL), // network is actually on v9
    });
    expect(result).not.toBeInstanceOf(DustLedgerWedgedError);
    expect(result).toBeInstanceOf(WalletError);
    expect(result.message).toMatch(/ledger v9/i);
    expect(tracker.consecutiveRejections).toBe(0);

    // And it never accumulates toward a wedge verdict, however many times it repeats.
    for (let i = 0; i < DEFAULT_WEDGE_THRESHOLD + 2; i++) {
      const again = await diagnoseSubmissionFailure(tracker, proofRejection(), {
        network: NETWORK,
        usingLedger: 'v8',
        probeBlock: probeAt(100 + i, V9_PROTOCOL),
      });
      expect(again).not.toBeInstanceOf(DustLedgerWedgedError);
    }
  });

  it('treats an unreachable indexer as inconclusive rather than as a wedge', async () => {
    let result: Error | undefined;
    for (let i = 0; i < DEFAULT_WEDGE_THRESHOLD; i++) {
      result = await diagnoseSubmissionFailure(tracker, proofRejection(), {
        network: NETWORK,
        usingLedger: 'v8',
        probeBlock: async () => {
          throw new Error('fetch failed');
        },
      });
    }
    expect(result).not.toBeInstanceOf(DustLedgerWedgedError);
    expect(tracker.consecutiveRejections).toBe(0);
  });

  it('honors a caller-supplied threshold', async () => {
    let height = 100;
    let result: Error | undefined;
    for (let i = 0; i < 2; i++) {
      result = await diagnoseSubmissionFailure(tracker, proofRejection(), {
        network: NETWORK,
        usingLedger: 'v8',
        threshold: 2,
        probeBlock: probeAt(height++),
      });
    }
    expect(result).toBeInstanceOf(DustLedgerWedgedError);
  });
});

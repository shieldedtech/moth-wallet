import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@shieldedtech/moth-browser';
import type { SyncStateStore } from '@shieldedtech/moth-wallet/sync/sync-store';
import {
  SUBMISSIONS_MAX,
  SUBMISSION_PENDING_TTL_MS,
  connectorSubmission,
  forgetSubmissions,
  loadSubmissions,
  mergeSubmissions,
  recordSubmission,
  submissionsKey,
  type SubmittedTx,
} from '../lib/offscreen/submissions';

const NOW = Date.parse('2026-07-13T12:00:00Z');
const TOKEN = '0'.repeat(64);

class MemoryStore implements SyncStateStore {
  private entries = new Map<string, string>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.entries.set(key, value);
  }
  async delete(key: string) {
    this.entries.delete(key);
  }
}

function submission(overrides: Partial<SubmittedTx>): SubmittedTx {
  return {
    hash: 'a'.repeat(64),
    submittedAt: NOW - 60_000,
    kind: 'send',
    to: 'mn_addr1recipient',
    tokenType: TOKEN,
    tokenKind: 'unshielded',
    amount: '120000000',
    ...overrides,
  };
}

function chainEntry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    hash: 'a'.repeat(64),
    kind: 'sent',
    status: 'SUCCESS',
    timestamp: new Date(NOW - 30_000),
    deltas: [],
    dustDelta: 0n,
    counterparty: null,
    fees: null,
    pending: false,
    ...overrides,
  };
}

describe('mergeSubmissions', () => {
  it('surfaces an unapplied fresh submission as a pending sent row', () => {
    const { entries, prune } = mergeSubmissions([], [submission({})], NOW);

    expect(prune).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      hash: 'a'.repeat(64),
      kind: 'sent',
      pending: true,
      counterparty: 'mn_addr1recipient',
    });
    expect(entries[0]?.deltas).toEqual([
      { tokenType: TOKEN, kind: 'unshielded', amount: -120_000_000n },
    ]);
  });

  it('enriches the applied chain entry with the recorded recipient instead of duplicating it', () => {
    const { entries } = mergeSubmissions([chainEntry({})], [submission({})], NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pending).toBe(false);
    expect(entries[0]?.counterparty).toBe('mn_addr1recipient');
  });

  it('reconciles a submitted identifier when the applied transaction has a different chain hash', () => {
    const submitted = submission({ hash: 'a'.repeat(64) });
    const applied = chainEntry({
      hash: 'b'.repeat(64),
      identifiers: [submitted.hash],
    });

    const { entries } = mergeSubmissions([applied], [submitted], NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      hash: 'b'.repeat(64),
      pending: false,
      counterparty: 'mn_addr1recipient',
    });
  });

  it('reconciles by the submitted transaction hash when history omits logical identifiers', () => {
    const appliedHash = 'b'.repeat(64);
    const submitted = submission({
      hash: 'a'.repeat(64),
      transactionHash: appliedHash,
    });

    const { entries } = mergeSubmissions(
      [chainEntry({ hash: appliedHash, identifiers: undefined })],
      [submitted],
      NOW,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ hash: appliedHash, pending: false });
  });

  it('never overwrites a counterparty the chain entry already reveals', () => {
    const { entries } = mergeSubmissions(
      [chainEntry({ counterparty: 'mn_addr1fromchain' })],
      [submission({})],
      NOW,
    );

    expect(entries[0]?.counterparty).toBe('mn_addr1fromchain');
  });

  it('grafts the sent token onto a fee-only chain entry (full-balance shielded send)', () => {
    // A full-balance shielded send returns no change output, so the sender's
    // only chain entry is the DUST fee spend — kind 'dust', no token deltas.
    const feeOnly = chainEntry({ kind: 'dust', deltas: [], dustDelta: -5n });
    const { entries } = mergeSubmissions(
      [feeOnly],
      [submission({ tokenKind: 'shielded', amount: '66666' })],
      NOW,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'sent', pending: false, counterparty: 'mn_addr1recipient' });
    expect(entries[0]?.deltas).toEqual([{ tokenType: TOKEN, kind: 'shielded', amount: -66_666n }]);
  });

  it('stamps a timestamp-less chain entry with the submit time so it sorts into the feed', () => {
    // Shielded/DUST history entries arrive without block timestamps; unstamped
    // they would sort below the entire feed and look like a missing transfer.
    const unstamped = chainEntry({ kind: 'dust', deltas: [], timestamp: null });
    const older = chainEntry({ hash: 'b'.repeat(64), timestamp: new Date(NOW - 120_000) });
    const { entries } = mergeSubmissions([unstamped, older], [submission({})], NOW);

    expect(entries.map((entry) => entry.hash)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(entries[0]?.timestamp).toEqual(new Date(NOW - 60_000));
  });

  it('keeps the chain timestamp when the entry has one', () => {
    const { entries } = mergeSubmissions([chainEntry({})], [submission({})], NOW);
    expect(entries[0]?.timestamp).toEqual(new Date(NOW - 30_000));
  });

  it('never double-counts a token the chain entry already reports', () => {
    const withDelta = chainEntry({
      deltas: [{ tokenType: TOKEN, kind: 'unshielded', amount: -120_000_000n }],
    });
    const { entries } = mergeSubmissions([withDelta], [submission({})], NOW);

    expect(entries[0]?.deltas).toEqual([
      { tokenType: TOKEN, kind: 'unshielded', amount: -120_000_000n },
    ]);
  });

  // The SDK writes its own pending entry for every submission, holding only a
  // hash. The record must fill that row in, never stand beside it as a second one.
  it('fills in the pending entry history already holds for the submission', () => {
    const pending = chainEntry({ kind: 'dust', pending: true });
    const { entries } = mergeSubmissions([pending], [submission({})], NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'sent', pending: true, counterparty: 'mn_addr1recipient' });
    expect(entries[0]?.deltas).toEqual([{ tokenType: TOKEN, kind: 'unshielded', amount: -120_000_000n }]);
  });

  it('keeps the amount on an entry history marked rejected, and its failure', () => {
    const rejected = chainEntry({ kind: 'dust', status: 'FAILURE' });
    const { entries } = mergeSubmissions([rejected], [submission({})], NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'sent', status: 'FAILURE', pending: false });
    expect(entries[0]?.deltas[0]?.amount).toBe(-120_000_000n);
  });

  it('prunes a submission unseen on chain past the pending TTL', () => {
    const stale = submission({ submittedAt: NOW - SUBMISSION_PENDING_TTL_MS - 1 });
    const { entries, prune } = mergeSubmissions([], [stale], NOW);

    expect(entries).toEqual([]);
    expect(prune).toEqual([stale.hash]);
  });

  it('shows a dust registration submission as a pending DUST row', () => {
    const { entries } = mergeSubmissions(
      [],
      [submission({ kind: 'dust', to: undefined, tokenType: undefined, amount: undefined })],
      NOW,
    );

    expect(entries[0]).toMatchObject({ kind: 'dust', pending: true, deltas: [] });
  });

  it('sorts pending submissions in with chain entries, newest first', () => {
    const older = chainEntry({ hash: 'b'.repeat(64), timestamp: new Date(NOW - 120_000) });
    const { entries } = mergeSubmissions([older], [submission({})], NOW);

    expect(entries.map((entry) => entry.hash)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });
});

describe('submission storage', () => {
  it('round-trips through the store, replacing a re-recorded hash', async () => {
    const store = new MemoryStore();
    await recordSubmission(store, 'devnet', 'alice', submission({}));
    await recordSubmission(store, 'devnet', 'alice', submission({ amount: '999' }));

    const loaded = await loadSubmissions(store, 'devnet', 'alice');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.amount).toBe('999');
  });

  it('caps stored submissions at the newest SUBMISSIONS_MAX', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < SUBMISSIONS_MAX + 5; i++) {
      await recordSubmission(store, 'devnet', 'alice', submission({ hash: `${i}`.padEnd(64, 'c') }));
    }

    const loaded = await loadSubmissions(store, 'devnet', 'alice');
    expect(loaded).toHaveLength(SUBMISSIONS_MAX);
    expect(loaded[0]?.hash).toBe('5'.padEnd(64, 'c'));
  });

  it('loses neither write when two interleave', async () => {
    // A store whose reads and writes each take a turn of the event loop, as
    // IndexedDB does, so unserialized load-then-save passes would overlap.
    class SlowStore extends MemoryStore {
      override async get(key: string) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return super.get(key);
      }
      override async put(key: string, value: string) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return super.put(key, value);
      }
    }
    const store = new SlowStore();
    await recordSubmission(store, 'devnet', 'alice', submission({ hash: 'a'.repeat(64) }));

    await Promise.all([
      forgetSubmissions(store, 'devnet', 'alice', ['a'.repeat(64)]),
      recordSubmission(store, 'devnet', 'alice', submission({ hash: 'b'.repeat(64) })),
      recordSubmission(store, 'devnet', 'alice', submission({ hash: 'c'.repeat(64) })),
    ]);

    const loaded = await loadSubmissions(store, 'devnet', 'alice');
    expect(loaded.map((tx) => tx.hash[0])).toEqual(['b', 'c']);
  });

  it('keeps writing after a store failure', async () => {
    const store = new MemoryStore();
    const put = store.put.bind(store);
    store.put = async () => {
      throw new Error('quota');
    };
    await expect(recordSubmission(store, 'devnet', 'alice', submission({}))).rejects.toThrow('quota');

    store.put = put;
    await recordSubmission(store, 'devnet', 'alice', submission({}));

    expect(await loadSubmissions(store, 'devnet', 'alice')).toHaveLength(1);
  });

  it('treats a corrupted payload as empty', async () => {
    const store = new MemoryStore();
    await store.put(submissionsKey('devnet', 'alice'), '{not json');
    expect(await loadSubmissions(store, 'devnet', 'alice')).toEqual([]);
  });

  it('keys submissions per wallet and network', () => {
    expect(submissionsKey('devnet', 'alice')).not.toBe(submissionsKey('preprod', 'alice'));
    expect(submissionsKey('devnet', 'alice')).not.toBe(submissionsKey('devnet', 'bob'));
  });
});

describe('connectorSubmission', () => {
  const HASH = 'c'.repeat(64);

  it('records only the hash when nothing was prepared', () => {
    expect(connectorSubmission(HASH, undefined, NOW)).toEqual({
      hash: HASH,
      transactionHash: HASH,
      submittedAt: NOW,
      kind: 'send',
    });
  });

  it('takes the amount from a lone non-DUST deficit the wallet covered', () => {
    // A contract call that takes 100 NIGHT: the balancing summary shows the
    // NIGHT deficit plus the DUST the fee needs. Only the NIGHT is the row.
    const tx = connectorSubmission(
      HASH,
      {
        spends: [
          { kind: 'unshielded', tokenId: TOKEN, amount: '100000000' },
          { kind: 'dust', tokenId: '', amount: '5' },
        ],
      },
      NOW,
    );

    expect(tx).toMatchObject({ kind: 'send', tokenType: TOKEN, tokenKind: 'unshielded', amount: '100000000' });
    expect(tx.to).toBeUndefined();
  });

  it('shows no single amount for a mixed-token spend', () => {
    const tx = connectorSubmission(
      HASH,
      {
        spends: [
          { kind: 'unshielded', tokenId: TOKEN, amount: '1' },
          { kind: 'shielded', tokenId: '1'.repeat(64), amount: '2' },
        ],
      },
      NOW,
    );

    expect(tx.amount).toBeUndefined();
    expect(tx.tokenType).toBeUndefined();
  });

  it('keeps the recipient and size of a transfer the wallet built itself', () => {
    const tx = connectorSubmission(
      HASH,
      {
        spends: [{ kind: 'shielded', tokenId: TOKEN, amount: '7' }],
        transfer: { to: 'mn_addr1recipient', outputs: 1 },
      },
      NOW,
    );

    expect(tx).toMatchObject({ to: 'mn_addr1recipient', outputs: 1, tokenKind: 'shielded', amount: '7' });
  });
});

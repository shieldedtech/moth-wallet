import { describe, expect, it } from 'vitest';
import type { WalletEntry } from '@midnightntwrk/wallet-sdk/facade';
import { deriveActivity, deriveActivityEntry } from '../../../src/sync/activity.js';
import { NIGHT_TOKEN_ID } from '../../../src/types/tokens.js';

const OWN = 'mn_addr_preprod1own';
const OTHER = 'mn_addr_preprod1other';

function entry(overrides: Partial<WalletEntry>): WalletEntry {
  return {
    hash: 'a'.repeat(64),
    protocolVersion: 1,
    status: 'SUCCESS',
    ...overrides,
  } as WalletEntry;
}

function utxo(owner: string, value: bigint, tokenType = NIGHT_TOKEN_ID) {
  return { value, owner, tokenType, intentHash: 'i'.repeat(64), outputIndex: 0 };
}

function dustUtxo(initialValue: bigint, seq = 0) {
  return { initialValue, nonce: BigInt(seq + 1), seq, backingNight: 'b'.repeat(64), mtIndex: BigInt(seq) };
}

describe('deriveActivityEntry', () => {
  it('classifies a pure incoming transfer as received', () => {
    const activity = deriveActivityEntry(
      entry({
        timestamp: new Date('2026-07-12T09:12:00Z'),
        unshielded: { id: 1, createdUtxos: [utxo(OWN, 120_000_000n)], spentUtxos: [] },
      }),
      OWN,
    );

    expect(activity.kind).toBe('received');
    expect(activity.deltas).toEqual([
      { tokenType: NIGHT_TOKEN_ID, kind: 'unshielded', amount: 120_000_000n },
    ]);
    expect(activity.counterparty).toBeNull();
    expect(activity.pending).toBe(false);
  });

  it('reveals the sender when the entry includes their spent UTXO', () => {
    const activity = deriveActivityEntry(
      entry({
        unshielded: {
          id: 1,
          createdUtxos: [utxo(OWN, 120_000_000n)],
          spentUtxos: [utxo(OTHER, 150_000_000n)],
        },
      }),
      OWN,
    );

    expect(activity.kind).toBe('received');
    expect(activity.deltas[0]?.amount).toBe(120_000_000n);
    expect(activity.counterparty).toBe(OTHER);
  });

  it('nets spend and change into a sent amount with the recipient as counterparty', () => {
    const activity = deriveActivityEntry(
      entry({
        unshielded: {
          id: 1,
          createdUtxos: [utxo(OWN, 55_000_000n), utxo(OTHER, 45_000_000n)],
          spentUtxos: [utxo(OWN, 100_000_000n)],
        },
      }),
      OWN,
    );

    expect(activity.kind).toBe('sent');
    expect(activity.deltas).toEqual([
      { tokenType: NIGHT_TOKEN_ID, kind: 'unshielded', amount: -45_000_000n },
    ]);
    expect(activity.counterparty).toBe(OTHER);
    expect(activity.outputs).toBe(1);
  });

  it('counts each external output as a transfer (batch send)', () => {
    const activity = deriveActivityEntry(
      entry({
        unshielded: {
          id: 1,
          // Change back to self plus three distinct recipient outputs.
          createdUtxos: [
            utxo(OWN, 10_000_000n),
            utxo(OTHER, 45_000_000n),
            utxo('mn_addr_preprod1second', 20_000_000n),
            utxo('mn_addr_preprod1third', 25_000_000n),
          ],
          spentUtxos: [utxo(OWN, 100_000_000n)],
        },
      }),
      OWN,
    );

    expect(activity.kind).toBe('sent');
    expect(activity.outputs).toBe(3);
    // First-seen external owner remains the counterparty.
    expect(activity.counterparty).toBe(OTHER);
  });

  it('falls back to counting every UTXO as the wallet own when no owner matches', () => {
    // The wallet stored this entry, so it IS wallet-relevant; if no owner
    // matches, the address encoding differs and per-owner attribution is
    // impossible — amounts must still come out right.
    const activity = deriveActivityEntry(
      entry({
        unshielded: {
          id: 1,
          createdUtxos: [utxo('unrecognized-encoding', 55_000_000n)],
          spentUtxos: [utxo('unrecognized-encoding', 100_000_000n)],
        },
      }),
      OWN,
    );

    expect(activity.kind).toBe('sent');
    expect(activity.deltas[0]?.amount).toBe(-45_000_000n);
    expect(activity.counterparty).toBeNull();
  });

  it('classifies opposite movements as a swap', () => {
    const activity = deriveActivityEntry(
      entry({
        unshielded: {
          id: 1,
          createdUtxos: [],
          spentUtxos: [utxo(OWN, 45_000_000n)],
        },
        shielded: {
          receivedCoins: [{ type: 'musd0000', nonce: 'n', value: 224_800_000n, mtIndex: 1n }],
          spentCoins: [],
        },
      }),
      OWN,
    );

    expect(activity.kind).toBe('swap');
    // Largest magnitude first — the received side leads.
    expect(activity.deltas[0]).toEqual({ tokenType: 'musd0000', kind: 'shielded', amount: 224_800_000n });
    expect(activity.deltas[1]?.amount).toBe(-45_000_000n);
  });

  it('classifies a night-neutral entry with DUST movement as dust', () => {
    const activity = deriveActivityEntry(
      entry({
        unshielded: {
          id: 1,
          createdUtxos: [utxo(OWN, 100_000_000n)],
          spentUtxos: [utxo(OWN, 100_000_000n)],
        },
        dust: {
          receivedUtxos: [
            { initialValue: 5n, nonce: 1n, seq: 0, backingNight: 'b'.repeat(64), mtIndex: 1n },
          ],
          spentUtxos: [],
        },
      }),
      OWN,
    );

    expect(activity.kind).toBe('dust');
    expect(activity.deltas).toEqual([]);
    expect(activity.dustDelta).toBe(5n);
    expect(activity.paidFee).toBe(false);
  });

  // A contract call moves none of the wallet's tokens: its only trace is the DUST
  // that paid the fee. The change UTXO's initial value includes everything the
  // spent one generated since it was created, so the "delta" reads positive.
  it('marks a DUST spend as a paid fee even when the DUST delta reads positive', () => {
    const activity = deriveActivityEntry(
      entry({
        fees: 1n,
        dust: {
          receivedUtxos: [dustUtxo(13_082_987_999_999_995n, 5)],
          spentUtxos: [dustUtxo(6_041_891_999_999_996n, 4)],
        },
      }),
      OWN,
    );

    expect(activity.kind).toBe('dust');
    expect(activity.dustDelta).toBeGreaterThan(0n);
    expect(activity.paidFee).toBe(true);
  });

  it('keeps failure status, fees and timestamp visible', () => {
    const when = new Date('2026-07-11T18:34:00Z');
    const activity = deriveActivityEntry(
      entry({ status: 'FAILURE', fees: 400n, timestamp: when }),
      OWN,
    );

    expect(activity.status).toBe('FAILURE');
    expect(activity.fees).toBe(400n);
    expect(activity.timestamp).toEqual(when);
    expect(activity.kind).toBe('dust');
  });

  // An entry the wallet recorded itself has no block time, and an undated row
  // sinks below the whole feed: the newest transaction would be the last one shown.
  it('dates a pending entry by when it was submitted', () => {
    const submittedAt = new Date('2026-11-19T10:00:00Z');
    const activity = deriveActivityEntry(
      entry({ status: undefined, lifecycle: { status: 'pending', submittedAt } }),
      OWN,
    );

    expect(activity.pending).toBe(true);
    expect(activity.timestamp).toEqual(submittedAt);
  });

  it('dates a rejected entry by when the wallet gave up on it', () => {
    const rejectedAt = new Date('2026-11-19T10:30:00Z');
    const activity = deriveActivityEntry(
      entry({ status: undefined, lifecycle: { status: 'rejected', rejectedAt } }),
      OWN,
    );

    expect(activity.status).toBe('FAILURE');
    expect(activity.pending).toBe(false);
    expect(activity.timestamp).toEqual(rejectedAt);
  });

  it('keeps logical transaction identifiers for pending-submission reconciliation', () => {
    const identifiers = ['logical-id-1', 'logical-id-2'];
    const activity = deriveActivityEntry(entry({ identifiers }), OWN);

    expect(activity.identifiers).toEqual(identifiers);
  });
});

describe('deriveActivity', () => {
  it('sorts newest first with undated entries last', () => {
    const entries = [
      entry({ hash: 'old'.padEnd(64, '0'), timestamp: new Date('2026-07-01T00:00:00Z') }),
      entry({ hash: 'undated'.padEnd(64, '0') }),
      entry({ hash: 'new'.padEnd(64, '0'), timestamp: new Date('2026-07-12T00:00:00Z') }),
    ];

    const hashes = deriveActivity(entries, OWN).map((activity) => activity.hash);
    expect(hashes).toEqual(['new'.padEnd(64, '0'), 'old'.padEnd(64, '0'), 'undated'.padEnd(64, '0')]);
  });

  // The feed tracks what the wallet spends. DUST that simply arrives (generation
  // starting, or restarting at a protocol upgrade) is not something it did.
  it('leaves out DUST that arrived with nothing else of the wallet in the transaction', () => {
    const entries = [
      entry({ hash: 'receipt'.padEnd(64, '0'), dust: { receivedUtxos: [dustUtxo(0n)], spentUtxos: [] } }),
      entry({
        hash: 'fee'.padEnd(64, '0'),
        dust: { receivedUtxos: [dustUtxo(9n, 1)], spentUtxos: [dustUtxo(5n)] },
      }),
      entry({
        hash: 'registration'.padEnd(64, '0'),
        unshielded: { id: 1, createdUtxos: [utxo(OWN, 100n)], spentUtxos: [utxo(OWN, 100n)] },
        dust: { receivedUtxos: [dustUtxo(0n)], spentUtxos: [] },
      }),
    ];

    const byHash = new Map(deriveActivity(entries, OWN).map((activity) => [activity.hash.replace(/0+$/, ''), activity]));
    expect([...byHash.keys()].sort()).toEqual(['fee', 'registration']);
    expect(byHash.get('fee')?.paidFee).toBe(true);
    expect(byHash.get('registration')?.paidFee).toBe(false);
  });
});

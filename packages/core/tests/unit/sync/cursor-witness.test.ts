import {describe, expect, it} from 'vitest';
import {compareWitness, readEventWitnessRetrying, type CursorWitness} from '../../../src/sync/cursor-witness.js';
import {witnessStreamFor} from '../../../src/sync/preseed.js';

const witness = (id: number, digest: string): CursorWitness => ({stream: 'dustLedgerEvents', id, digest});

describe('compareWitness', () => {

  it('accepts the same event at the same id', async () => {
    expect(compareWitness(witness(1_431_375, 'aaaa'), witness(1_431_375, 'aaaa'))).toEqual({kind: 'valid'});
  });

  // The preprod case. A cursor written when id 1431375 named one event, re-checked
  // against a stream where that id names an event 22 positions later. Measured
  // live: expected 11c8cf9fd5a736f2, actual 3f3576deb45ad350.
  it('reports renumbered when a different event now sits at the id', async () => {
    expect(
      compareWitness(witness(1_431_375, '11c8cf9fd5a736f2'), witness(1_431_375, '3f3576deb45ad350')),
    ).toEqual({kind: 'renumbered', expected: '11c8cf9fd5a736f2', actual: '3f3576deb45ad350'});
  });

  it('accepts an id that advanced into a gap, so long as the event matches', async () => {
    // Subscribing inside a hole returns the next existing event. That is normal
    // and must not invalidate: the question is which event is there, not which
    // number it carries.
    expect(compareWitness(witness(989_781, 'aaaa'), witness(989_803, 'aaaa'))).toEqual({kind: 'valid'});
  });

  // A cursor past the end of a shorter stream produces an ack then silence — no
  // error. That is exactly what a cursor from a longer numbering looks like, so
  // it must never read as valid.
  it('treats a cursor past the end of the stream as unknown, never valid', async () => {
    const verdict = compareWitness(witness(99_999_999, 'aaaa'), null);
    expect(verdict.kind).toBe('unknown');
    expect(verdict.kind === 'unknown' && verdict.reason).toMatch(/shorter than this cursor/);
  });
});

// Only cursors that index an event stream can be renumbered under a reference.
// A DUST snapshot the projections sync wrote saves a block height instead, so it
// has nothing to witness.
describe('witnessStreamFor', () => {
  const snapshot = (syncKind?: string) => JSON.stringify({version: 'v2', offset: '42', ...(syncKind && {syncKind})});

  it('witnesses a dust cursor that event replay wrote against the dust events', () => {
    expect(witnessStreamFor('dust', snapshot('events'))).toBe('dustLedgerEvents');
  });

  it('witnesses a dust snapshot that names no sync, since only event replay wrote those', () => {
    expect(witnessStreamFor('dust', snapshot())).toBe('dustLedgerEvents');
  });

  it('witnesses nothing for a dust state the projections sync wrote', () => {
    expect(witnessStreamFor('dust', snapshot('projections'))).toBeNull();
  });

  it('keeps witnessing a dust snapshot it cannot read', () => {
    expect(witnessStreamFor('dust', 'not-json')).toBe('dustLedgerEvents');
  });

  it('witnesses shielded, and never unshielded', () => {
    expect(witnessStreamFor('shielded', snapshot())).toBe('zswapLedgerEvents');
    expect(witnessStreamFor('unshielded', snapshot())).toBeNull();
  });
});

// The pre-seed re-check. One dropped socket used to refuse a valid reference and
// send a new wallet to scan from genesis; see readEventWitnessRetrying.
describe('readEventWitnessRetrying', () => {
  const stored = witness(24_599, '0452a6bb8302ab69');

  /** A read that plays back `outcomes` in order: a witness, null, or an Error to throw. */
  function scripted(outcomes: Array<CursorWitness | null | Error>) {
    const calls: number[] = [];
    const read = async (_url: string, _stream: unknown, id: number) => {
      calls.push(id);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    };
    return {read: read as never, calls};
  }
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const run = (read: never, onRetry?: (attempt: number, outcome: string) => void) =>
    readEventWitnessRetrying('https://indexer.example/api/v4/graphql', 'dustLedgerEvents', stored.id, {
      read, sleep, onRetry, delaysMs: [2_000, 5_000],
    });

  it('returns the first event without retrying', async () => {
    const {read, calls} = scripted([stored]);
    await expect(run(read)).resolves.toEqual(stored);
    expect(calls).toHaveLength(1);
  });

  it('recovers from a socket that errors, waiting between attempts', async () => {
    sleeps.length = 0;
    const retries: string[] = [];
    const {read, calls} = scripted([new Error('Could not reach wss://x/ws'), stored]);
    await expect(run(read, (n, o) => retries.push(`${n}: ${o}`))).resolves.toEqual(stored);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2_000]);
    expect(retries).toEqual(['1: Could not reach wss://x/ws']);
  });

  it('recovers from a read that went quiet', async () => {
    const {read, calls} = scripted([null, null, stored]);
    await expect(run(read)).resolves.toEqual(stored);
    expect(calls).toHaveLength(3);
  });

  // A different event at the id is a verdict, not a dropped connection: retrying
  // it would only delay the refusal.
  it('returns a mismatching event at once, so a renumbering is still caught', async () => {
    const other = witness(24_599, 'ffffffffffffffff');
    const {read, calls} = scripted([other, stored]);
    const observed = await run(read);
    expect(calls).toHaveLength(1);
    expect(compareWitness(stored, observed).kind).toBe('renumbered');
  });

  it('still throws when every attempt fails, so the caller refuses', async () => {
    const {read, calls} = scripted([new Error('a'), new Error('b'), new Error('c')]);
    await expect(run(read)).rejects.toThrow('c');
    expect(calls).toHaveLength(3);
  });

  it('still yields null when every attempt is silent, which never reads as valid', async () => {
    const {read} = scripted([null, null, null]);
    const observed = await run(read);
    expect(observed).toBeNull();
    expect(compareWitness(stored, observed).kind).toBe('unknown');
  });
});

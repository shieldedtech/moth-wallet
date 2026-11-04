import {describe, expect, it} from 'vitest';
import {compareWitness, type CursorWitness} from '../../../src/sync/cursor-witness.js';
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

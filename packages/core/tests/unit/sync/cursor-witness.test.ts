import {describe, expect, it} from 'vitest';
import {compareWitness, type CursorWitness} from '../../../src/sync/cursor-witness.js';

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

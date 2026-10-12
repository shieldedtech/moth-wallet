import {describe, expect, it} from 'vitest';
import {partsToSeed, shouldAttemptPreSeed, preSeedPlan, birthdayAdmits} from '../../../src/sync/preseed-parts.js';

describe('partsToSeed', () => {
  it('seeds everything for a wallet with no state', () => {
    expect(partsToSeed({})).toEqual(['shielded', 'unshielded', 'dust']);
  });

  // The regression. A DUST rebuild evicts the dust cache and nothing else. The
  // gate used to test the SHIELDED cache as a proxy for "no state yet", so with
  // shielded still present it stayed shut and dust walked all 1.4M events from
  // genesis — 78.6 min on preprod — with a usable reference sitting unused.
  it('seeds dust alone after a DUST rebuild, with the others still cached', () => {
    expect(partsToSeed({shielded: 'state', unshielded: 'state', dust: null})).toEqual(['dust']);
    expect(shouldAttemptPreSeed({shielded: 'state', unshielded: 'state', dust: null})).toBe(true);
  });

  it('never re-seeds a part that already has state', () => {
    // A cached part is at least as far along as the reference, so seeding over
    // it would discard progress.
    expect(partsToSeed({shielded: 'state', unshielded: 'state', dust: 'state'})).toEqual([]);
    expect(shouldAttemptPreSeed({shielded: 'state', unshielded: 'state', dust: 'state'})).toBe(false);
  });

  it('handles each part going missing on its own', () => {
    expect(partsToSeed({unshielded: 'state', dust: 'state'})).toEqual(['shielded']);
    expect(partsToSeed({shielded: 'state', dust: 'state'})).toEqual(['unshielded']);
    expect(partsToSeed({shielded: 'state', unshielded: 'state'})).toEqual(['dust']);
  });

  it('treats an empty string as absent, since that is not restorable state', () => {
    expect(partsToSeed({shielded: '', unshielded: 'state', dust: 'state'})).toEqual(['shielded']);
  });

  it('keeps a stable order, so the progress message reads the same way each time', () => {
    expect(partsToSeed({unshielded: null, shielded: null, dust: null})).toEqual([
      'shielded',
      'unshielded',
      'dust',
    ]);
  });
});

describe('preSeedPlan', () => {
  const REF = 2_203_416;
  const all = ['shielded', 'unshielded', 'dust'] as const;

  it('seeds every missing part for a wallet born at or after the reference', () => {
    expect(preSeedPlan({missing: [...all], birthday: REF, referenceHeight: REF, dustHistory: null})).toEqual({
      kind: 'all',
      parts: [...all],
    });
    expect(preSeedPlan({missing: ['dust'], birthday: REF + 5, referenceHeight: REF, dustHistory: null})).toEqual({
      kind: 'all',
      parts: ['dust'],
    });
  });

  // The whole point: a restored wallet has no birthday, so it used to walk dust from
  // genesis (78.6 min on preprod) even when it had never generated any DUST.
  it('seeds dust alone when the indexer proves no DUST history before the reference', () => {
    expect(preSeedPlan({missing: [...all], birthday: undefined, referenceHeight: REF, dustHistory: {kind: 'none'}})).toEqual({
      kind: 'dust-only',
    });
    // A wallet created before the reference (or with its cache cleared) qualifies too.
    expect(preSeedPlan({missing: ['dust'], birthday: REF - 1, referenceHeight: REF, dustHistory: {kind: 'none'}})).toEqual({
      kind: 'dust-only',
    });
  });

  it('refuses when the wallet has DUST history before the reference', () => {
    const plan = preSeedPlan({missing: [...all], birthday: undefined, referenceHeight: REF, dustHistory: {kind: 'some', entries: 1}});
    expect(plan.kind).toBe('none');
    expect(plan.kind === 'none' && plan.reason).toMatch(/DUST history before the reference/);
  });

  it('fails closed when the history could not be confirmed', () => {
    const plan = preSeedPlan({
      missing: [...all],
      birthday: undefined,
      referenceHeight: REF,
      dustHistory: {kind: 'unknown', reason: 'no answer within 20000ms'},
    });
    expect(plan.kind).toBe('none');
    expect(plan.kind === 'none' && plan.reason).toMatch(/could not confirm DUST history/);
  });

  it('never seeds shielded or unshielded for a wallet without a usable birthday', () => {
    // Dust already cached, the others missing: nothing the indexer can prove here.
    const plan = preSeedPlan({missing: ['shielded', 'unshielded'], birthday: undefined, referenceHeight: REF, dustHistory: null});
    expect(plan.kind).toBe('none');
    expect(plan.kind === 'none' && plan.reason).toMatch(/no wallet birthday/);
    const newer = preSeedPlan({missing: ['shielded'], birthday: REF - 1, referenceHeight: REF, dustHistory: null});
    expect(newer.kind === 'none' && newer.reason).toMatch(/reference is newer than this wallet/);
  });

  it('has nothing to do when every part is cached', () => {
    expect(preSeedPlan({missing: [], birthday: undefined, referenceHeight: REF, dustHistory: null}).kind).toBe('none');
  });
});

describe('birthdayAdmits', () => {
  it('admits a birthday at or after the reference height only', () => {
    expect(birthdayAdmits(10, 10)).toBe(true);
    expect(birthdayAdmits(11, 10)).toBe(true);
    expect(birthdayAdmits(9, 10)).toBe(false);
    expect(birthdayAdmits(undefined, 10)).toBe(false);
  });
});

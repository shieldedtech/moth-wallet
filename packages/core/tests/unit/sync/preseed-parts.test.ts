import {describe, expect, it} from 'vitest';
import {partsToSeed, shouldAttemptPreSeed} from '../../../src/sync/preseed-parts.js';

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

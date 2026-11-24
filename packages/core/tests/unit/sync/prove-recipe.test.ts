import {describe, expect, it, vi} from 'vitest';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import {proveRecipe} from '../../../src/sync/operations.js';

// A recipe whose proof fails is never submitted, so only this revert releases the coins
// building it booked; they used to stay booked across reloads and stall every later send.
describe('proveRecipe', () => {
  const recipe = {type: 'UNPROVEN_TRANSACTION'} as never;
  const signed = {type: 'UNPROVEN_TRANSACTION', signed: true} as never;
  const sign = vi.fn() as never;

  function facadeWith(overrides: Partial<Record<'signRecipe' | 'finalizeRecipe' | 'revert', ReturnType<typeof vi.fn>>>) {
    const methods = {
      signRecipe: vi.fn(async () => signed),
      finalizeRecipe: vi.fn(async () => 'finalized'),
      revert: vi.fn(async () => undefined),
      ...overrides,
    };
    return {facade: methods as unknown as WalletFacade, ...methods};
  }

  it('signs, proves and returns the finalized transaction without reverting', async () => {
    const {facade, signRecipe, finalizeRecipe, revert} = facadeWith({});
    await expect(proveRecipe(facade, recipe, sign)).resolves.toBe('finalized');
    expect(signRecipe).toHaveBeenCalledWith(recipe, sign);
    expect(finalizeRecipe).toHaveBeenCalledWith(signed);
    expect(revert).not.toHaveBeenCalled();
  });

  it('proves an unsigned recipe as is when no signer is given', async () => {
    const {facade, signRecipe, finalizeRecipe} = facadeWith({});
    await proveRecipe(facade, recipe);
    expect(signRecipe).not.toHaveBeenCalled();
    expect(finalizeRecipe).toHaveBeenCalledWith(recipe);
  });

  it('reverts the recipe and rethrows when proving fails', async () => {
    const failure = new Error('Proof job 3 (prove) gave no result within 300 s; it was proving');
    const {facade, revert} = facadeWith({finalizeRecipe: vi.fn().mockRejectedValue(failure)});
    await expect(proveRecipe(facade, recipe, sign)).rejects.toBe(failure);
    // The built recipe, not the signed copy: it carries the bookings either way.
    expect(revert).toHaveBeenCalledWith(recipe, 'not proved');
  });

  it('reverts when signing fails', async () => {
    const {facade, revert, finalizeRecipe} = facadeWith({signRecipe: vi.fn().mockRejectedValue(new Error('locked'))});
    await expect(proveRecipe(facade, recipe, sign)).rejects.toThrow('locked');
    expect(finalizeRecipe).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledWith(recipe, 'not proved');
  });

  it('keeps the proving error when the revert itself fails', async () => {
    const failure = new Error('prover crashed');
    const {facade} = facadeWith({
      finalizeRecipe: vi.fn().mockRejectedValue(failure),
      revert: vi.fn().mockRejectedValue(new Error('revert failed')),
    });
    await expect(proveRecipe(facade, recipe, sign)).rejects.toBe(failure);
  });
});

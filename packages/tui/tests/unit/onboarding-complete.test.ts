import { describe, expect, it } from 'vitest';
import {
  completeOnboarding,
  IncompleteOnboardingError,
} from '../../src/screens/onboarding/complete.js';
import type { OnboardingState } from '../../src/navigation/index.js';

const base: Partial<OnboardingState> = {
  network: 'preprod',
  source: 'mnemonic',
  name: 'alice',
  passphrase: 'test-1234',
};

describe('completeOnboarding', () => {
  // The bug: the birthday step collected a claim, put it in the wizard's
  // partial, and the final step rebuilt the state field by field without it. So
  // every import recorded no birthday and synced from genesis, while the TUI had
  // just told the user it had found one. Optional fields make this invisible to
  // the type checker, which is why it is asserted here.
  it('carries the birthday claim through to the completed state', () => {
    const done = completeOnboarding({ ...base, birthday: { kind: 'discover' } });
    expect(done.birthday).toEqual({ kind: 'discover' });
  });

  it.each([
    [{ kind: 'tip' }],
    [{ kind: 'discover' }],
    [{ kind: 'height', value: 2_100_000 }],
    [{ kind: 'date', value: '2026-08-01T00:00:00.000Z' }],
  ])('carries the %j claim', (birthday) => {
    expect(completeOnboarding({ ...base, birthday } as Partial<OnboardingState>).birthday).toEqual(
      birthday,
    );
  });

  it('leaves the birthday absent when the user did not claim one', () => {
    expect(completeOnboarding(base).birthday).toBeUndefined();
  });

  // The guard that keeps this from happening again: everything the wizard
  // collected must arrive, so a field added to OnboardingState cannot be lost by
  // forgetting to list it here.
  it('loses nothing the wizard collected', () => {
    const collected: Partial<OnboardingState> = {
      ...base,
      seedInput: 'abandon abandon about',
      generatedMnemonic: undefined,
      birthday: { kind: 'height', value: 42 },
    };
    const done = completeOnboarding(collected) as Record<string, unknown>;
    for (const [key, value] of Object.entries(collected)) {
      expect(done[key]).toEqual(value);
    }
  });

  it('carries the seed input, which the import needs', () => {
    expect(completeOnboarding({ ...base, seedInput: 'deadbeef' }).seedInput).toBe('deadbeef');
  });

  it.each(['network', 'source', 'name', 'passphrase'] as const)(
    'refuses to finish without %s',
    (key) => {
      const {[key]: _dropped, ...rest} = base;
      expect(() => completeOnboarding(rest)).toThrow(IncompleteOnboardingError);
      expect(() => completeOnboarding(rest)).toThrow(new RegExp(key));
    },
  );

  it('treats an empty name as missing rather than creating an unnamed wallet', () => {
    expect(() => completeOnboarding({ ...base, name: '' })).toThrow(IncompleteOnboardingError);
  });
});

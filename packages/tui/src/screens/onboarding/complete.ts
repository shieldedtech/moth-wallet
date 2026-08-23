// Assembling the finished onboarding state.
//
// This was inline in PassphraseScreen, written field by field, and it silently
// dropped `birthday`: the claim the birthday step collected went into the
// wizard's `partial` and never reached `onComplete`. Every import therefore
// recorded no birthday, the pre-seed gate (`isNewWallet || birthday`) stayed
// shut for imported wallets, and the sync walked the chain from genesis — with
// no warning, because from the sync's point of view no claim had been made.
//
// TypeScript could not catch it. `birthday` is optional on CompletedOnboarding,
// so an object literal that omits it is well-typed.
//
// So the assembly lives here, spreads the partial rather than listing fields,
// and is tested. A field added to OnboardingState now arrives at onComplete
// without anyone having to remember this step.

import type { CompletedOnboarding, OnboardingState } from '../../navigation/index.js';

/** The fields no wallet can be created without. */
const REQUIRED = ['network', 'source', 'name', 'passphrase'] as const;

export class IncompleteOnboardingError extends Error {
  constructor(missing: readonly string[]) {
    super(`Onboarding is missing: ${missing.join(', ')}`);
    this.name = 'IncompleteOnboardingError';
  }
}

/**
 * Turn the wizard's accumulated state into the completed state, keeping
 * everything it collected.
 *
 * Throws when a required field never got answered — a wizard that reaches the
 * last step without a network or a name is a navigation bug, and failing loudly
 * beats creating a wallet on a default nobody chose.
 */
export function completeOnboarding(partial: Partial<OnboardingState>): CompletedOnboarding {
  const missing = REQUIRED.filter((key) => partial[key] === undefined || partial[key] === '');
  if (missing.length > 0) throw new IncompleteOnboardingError(missing);

  return {
    ...partial,
    network: partial.network as string,
    source: partial.source as CompletedOnboarding['source'],
    name: partial.name as string,
    passphrase: partial.passphrase as string,
  };
}

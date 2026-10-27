import { describe, expect, it } from 'vitest';
import { t } from '../lib/i18n';
import { CAPSULE_FAILURE_TOASTS } from '../lib/ui/capsule-failure';
import type { CapsuleWalletFailure } from '../lib/capsule/protocol';

// The runtime names three failures of a site's transaction that are the wallet's own; the panel
// owes the user a sentence for each, naming the site and, where there is one, the way out.
describe('the wallet’s failure of a site’s transaction, in the user’s words', () => {
  const failures: CapsuleWalletFailure[] = ['notSynced', 'insufficientFunds', 'submission'];

  it('has a sentence for every failure, with the site named in it', () => {
    for (const failure of failures) {
      const text = t(CAPSULE_FAILURE_TOASTS[failure], ['vote.example']);
      expect(text).toContain('vote.example');
      expect(text).not.toMatch(/\$\d/);
    }
  });

  it('tells the user what to do next where there is something to do', () => {
    expect(t(CAPSULE_FAILURE_TOASTS.notSynced, ['s'])).toMatch(/press again/i);
    expect(t(CAPSULE_FAILURE_TOASTS.submission, ['s'])).toMatch(/Clear cache and resync/);
  });
});

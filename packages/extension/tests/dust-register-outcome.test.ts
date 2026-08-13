import { describe, expect, it } from 'vitest';
import { registerOutcome, isSuccessOutcome, registerTimingLabel } from '../lib/ui/dust-register-outcome';

describe('registerOutcome', () => {
  it('a returned hash is a real registration', () => {
    expect(registerOutcome({ txHash: '0xabc', registered: false, nightBalance: 10n })).toBe('submitted');
  });

  it('no hash but NIGHT genuinely registered is the honest no-op', () => {
    expect(registerOutcome({ txHash: null, registered: true, nightBalance: 10n })).toBe('already-registered');
  });

  it('no hash, nothing registered, no NIGHT: there was simply nothing to do', () => {
    expect(registerOutcome({ txHash: null, registered: false, nightBalance: 0n })).toBe('no-night');
  });

  // The preprod case. The node was refusing connections (403), an earlier
  // registration was built and proved but never landed, and its NIGHT stayed
  // booked. The wallet showed 10 tNIGHT — the displayed balance folds in booked
  // coins — while having none available, so registration found nothing and
  // returned null. Reporting that as "already registered" told the user
  // something false about their own funds, on the same screen whose detail row
  // said "Not registered".
  it('no hash, nothing registered, but NIGHT on the books is UNAVAILABLE — never success', () => {
    expect(registerOutcome({ txHash: null, registered: false, nightBalance: 10n })).toBe('unavailable');
  });

  it('distinguishes unavailable from already-registered on the registered flag alone', () => {
    const balance = 10_000_000n;
    expect(registerOutcome({ txHash: null, registered: true, nightBalance: balance })).toBe('already-registered');
    expect(registerOutcome({ txHash: null, registered: false, nightBalance: balance })).toBe('unavailable');
  });

  it('treats any positive balance as unavailable, however small', () => {
    expect(registerOutcome({ txHash: null, registered: false, nightBalance: 1n })).toBe('unavailable');
  });
});

describe('isSuccessOutcome', () => {
  it('counts a submission and an honest no-op as success', () => {
    expect(isSuccessOutcome('submitted')).toBe(true);
    expect(isSuccessOutcome('already-registered')).toBe(true);
  });

  it('refuses to call a non-registration a success', () => {
    // Both of these registered nothing. Showing the green check for either is
    // the defect; the user needs to know why nothing happened.
    expect(isSuccessOutcome('unavailable')).toBe(false);
    expect(isSuccessOutcome('no-night')).toBe(false);
  });
});

// "tx: register complete" was logged whenever the call did not throw — including
// when it resolved having submitted nothing. Two of those in a timings log read
// as two registrations, and cost an afternoon.
describe('registerTimingLabel', () => {
  it('says submitted only when there is a transaction', () => {
    expect(registerTimingLabel({ txHash: 'abc123' })).toBe('submitted');
  });

  it('names the no-op when nothing was registerable', () => {
    const label = registerTimingLabel({ txHash: null });
    expect(label).toContain('no-op');
    expect(label).toContain('unregistered NIGHT');
  });

  it('distinguishes the affordability no-op from the availability one', () => {
    // Different causes, different fixes: one resolves by waiting, the other by
    // settling a stuck transaction.
    expect(registerTimingLabel({ txHash: null, notYet: { feeSpecks: '1' } })).toContain('affordable');
    expect(registerTimingLabel({ txHash: null })).not.toContain('affordable');
  });

  it('never records a transaction hash', () => {
    // The timings page promises labels and durations only.
    expect(registerTimingLabel({ txHash: 'deadbeefcafe' })).not.toContain('deadbeef');
  });
});

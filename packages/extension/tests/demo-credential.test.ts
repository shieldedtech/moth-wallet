import { describe, expect, it } from 'vitest';
import { DEMO_CAPABILITIES, DEMO_CREDENTIAL_BIRTH_DATE, DEMO_CREDENTIAL_ISSUER_HEX } from '../lib/capsule/demo-credential';

describe('the demo credential as an answers document', () => {
  it('is the Node host’s answers file: the birth date in seconds, the issuer the Ballot dApp deploys with, an empty signature', () => {
    const credential = DEMO_CAPABILITIES['identus:verification/age@1.2.0']?.['ageCredential'];
    expect(credential).toEqual({
      date: String(Date.parse(DEMO_CREDENTIAL_BIRTH_DATE) / 1000),
      issuer: DEMO_CREDENTIAL_ISSUER_HEX,
      signature: '00'.repeat(64),
    });
    expect(credential).toMatchObject({ date: '631152000' });
  });
});

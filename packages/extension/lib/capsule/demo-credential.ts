// The demo's one installed capability, answered to the Ballot contract's `identus:verification/age`
// host function: a credential for a fixed birth date from the issuer the Ballot dApp deploys with.
// Demo glue, named as such: a real wallet answers from a credential it was issued, and the issuer
// is the dApp's constant only because both sides of the demo must agree on one.
//
// IMPORTANT: no runtime imports — the worker and a test read this.

export const DEMO_CREDENTIAL_BIRTH_DATE = '1990-01-01';
/** 32 bytes, hex: the same constant `apps/ballot-dapp` passes to the Ballot constructor. */
export const DEMO_CREDENTIAL_ISSUER_HEX = '15'.repeat(32);

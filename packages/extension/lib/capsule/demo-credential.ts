// The demo's one installed capability, answered to the Credential contract's `authority:credential/age`
// host function: a credential for a fixed birth date from the issuer the Credential is deployed with.
// Demo glue, named as such: a real wallet answers from a credential it was issued, and the issuer
// is the operator's constant only because both sides of the demo must agree on one. The account's
// own document, kept in the capsule database and edited under Settings, replaces this one.
//
// IMPORTANT: no runtime imports — the worker and a test read this.

import type { AnswersDocument } from '@shieldedtech/capsule-core';

export const DEMO_CREDENTIAL_BIRTH_DATE = '1990-01-01';
/** 32 bytes, hex: the same constant the operator deploys the Credential with (`pnpm wallet deploy Credential --arg 1515…15`). */
export const DEMO_CREDENTIAL_ISSUER_HEX = '15'.repeat(32);

/** The credential as an answers document: the shape every host keeps a credential in, typed by each contract when it asks. */
export const DEMO_CAPABILITIES: AnswersDocument = {
  'authority:credential/age@1.0.0': {
    ageCredential: {
      date: String(Math.floor(Date.parse(DEMO_CREDENTIAL_BIRTH_DATE) / 1000)),
      issuer: DEMO_CREDENTIAL_ISSUER_HEX,
      signature: '00'.repeat(64),
    },
  },
};

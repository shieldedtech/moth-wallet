// Stub witnesses for the fpc-registry contract. The Witnesses<PS>
// type is declared at firstperson/compiled/fpc-registry/contract/
// index.d.ts:3 and lists four names: issuer_secret, holder_pk,
// issuance_nonce, revocation_nullifier. Each returns
// [PS, Uint8Array]. The Contract constructor only requires these
// to be function-valued; deploy doesn't invoke them. Circuit
// execution would, so this fixture is sufficient for daemon-deploy
// integration but NOT for a circuit run that reads witness output.

const stub = (ctx) => [ctx.privateState, new Uint8Array(32)];

export default {
  issuer_secret: stub,
  holder_pk: stub,
  issuance_nonce: stub,
  revocation_nullifier: stub,
};

// Deterministic per-(origin, domain) app secret for DApps — the wallet-side
// primitive behind the connector's `deriveAppSecret`. HKDF-SHA-256 over a
// non-spending HD role key gives a secret that is simultaneously:
//   (1) private-key-bound  — not recomputable from any public value,
//   (2) deterministic/portable — reproducible from the seed on any device,
//   (3) stateless — nothing to back up beyond the seed.
// See specs/003-derive-app-secret/spec.md.
//
// The v1 salt/info strings are NORMATIVE and vendor-neutral ("midnight:", not
// "moth:") on purpose: this prototype and a future @midnightntwrk/wallet-sdk
// version must produce BYTE-IDENTICAL secrets so adopters never re-derive. Do
// NOT change any of them within v1 — a change is a new version tag (v2), never
// an in-place edit. See specs/003-derive-app-secret/wallet-sdk-upstream.md §3.

import { Roles, deriveRawKeys } from './address.js';

/** Normative v1 domain-separation tag. Pinned — see file header. */
const APP_SECRET_V1 = 'midnight:dapp-app-secret:v1';
const APP_SECRET_SALT = new TextEncoder().encode(APP_SECRET_V1);

/**
 * Derive a 32-byte hex app secret for `(seedHex, origin, domain)`. Same inputs
 * always yield the same secret.
 *
 * SECURITY:
 * - `origin` MUST be supplied by the wallet from the connection session, never
 *   from DApp params — that is what stops one site deriving another's secret.
 * - IKM is the Metadata role key: non-spending and used elsewhere only to
 *   derive a *public* identity address, so a leaked app secret can never expose
 *   the seed, the unshielded signing key, or the Zswap/Dust spend keys. HKDF's
 *   one-way extract-then-expand over the private role key also makes the output
 *   independent of (and non-correlatable to) that public address.
 */
export async function deriveAppSecret(
  seedHex: string,
  origin: string,
  domain: string,
): Promise<string> {
  const keys = deriveRawKeys(seedHex);
  // Copy into a fresh ArrayBuffer-backed view: deriveRawKeys returns
  // Uint8Array<ArrayBufferLike>, which WebCrypto's BufferSource type rejects.
  const ikm = new Uint8Array(keys[Roles.Metadata]);
  // origin + domain fold into `info` so different sites and different labels
  // yield independent, non-correlatable secrets.
  const info = new TextEncoder().encode(`${APP_SECRET_V1}|${origin}|${domain}`);

  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: APP_SECRET_SALT, info },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

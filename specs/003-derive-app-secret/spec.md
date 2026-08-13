# 003 — `deriveAppSecret`: deterministic per-app secret derivation for DApps

**Status:** implemented on `feat/derive-app-secret` (was: implementation brief). See docs/adr/0001.
**Author:** handed off from the Attested Names (`.shielded`) dapp session
**Owner:** moth-wallet session
**Security sensitivity:** HIGH — exposes a seed-derived secret to web content. Treat like
a new connector capability; run the VULNHUNT pass before shipping.

---

## 1. Problem

DApps that need a stable, private, per-user identity secret (for commitments, deriving an
in-app keypair, blinding, etc.) currently have no good primitive from the wallet:

- Deriving from a **public** value (`shieldedCoinPublicKey`, exposed via `getShieldedAddresses`)
  is **recomputable by anyone who knows the user's address** — so it isn't secret. This is the
  actual flaw in the consumer today: it derives `owner_secret`/`issuer_secret`/`governor_secret`
  as `SHA-256(coinPk ‖ domain)`.
- `signData` is **randomized** on this wallet (the unshielded `keystore.signData` produces a
  fresh signature each call — empirically verified: same message, same `verifyingKey`, different
  signatures). So a signature can't seed a **reproducible** secret.

We want a secret that is simultaneously **(1) private-key-bound** (not recomputable from public
data), **(2) deterministic/portable** (reproducible from the seed on any device), and
**(3) stateless** (nothing to back up beyond the seed). Signatures give up (2); public-key
derivation gives up (1). A **deterministic KDF from the seed** gives all three — and the wallet
is the only place that can do it, because it holds the seed.

## 2. Interface (connector method)

Add a new DApp Connector method on the `WalletConnectedAPI` surface:

```ts
deriveAppSecret(domain: string): Promise<{ secret: string }>   // secret = 32-byte hex
```

- `domain` — a caller-chosen label selecting *which* secret (e.g. `"names-deed:v1"`). Lets one
  DApp derive multiple independent secrets.
- Returns a **32-byte hex** secret. Same `(seed, origin, domain)` ⇒ **same** secret, always.

The method is **not** in `@midnight-ntwrk/dapp-connector-api` v4.0.1. Ship it as a wallet
extension method (DApps call it via a cast for now). Consider proposing it upstream to the
connector spec afterwards — see §8.

## 3. Derivation (core)

New file `packages/core/src/wallet/app-secret.ts`, following the shape of
`packages/core/src/wallet/sign-message.ts`:

```ts
import { deriveRawKeys, Roles } from './address.js';

// NORMATIVE v1 constants — vendor-neutral ("midnight:", not "moth:") on purpose, so this
// prototype and the future wallet-sdk version produce BYTE-IDENTICAL secrets and adopters
// never have to re-derive. Do not change within v1. See wallet-sdk-upstream.md §3 / §6.
const APP_SECRET_SALT = new TextEncoder().encode('midnight:dapp-app-secret:v1');

// HKDF-SHA-256 → 32 bytes. `origin` and `domain` are folded into `info` so different
// sites and different labels yield independent, non-correlatable secrets.
export async function deriveAppSecret(
  seedHex: string,
  origin: string,
  domain: string,
): Promise<string> {
  const keys = deriveRawKeys(seedHex);
  const ikm = keys[Roles.Metadata];            // ← see §7 (resolved: isolated, non-spending)
  const info = new TextEncoder().encode(`midnight:dapp-app-secret:v1|${origin}|${domain}`);

  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: APP_SECRET_SALT, info },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

Notes:
- **HKDF**, not a bare hash — proper extract-then-expand over the role key as IKM.
- Uses WebCrypto (works in the extension's browser context). If `@noble/hashes` is already a
  dep, its `hkdf(sha256, ikm, salt, info, 32)` is an acceptable equivalent — pick what the repo
  already uses.
- Export from `packages/core/src/index.ts` alongside the other `derive*` exports.

## 4. Connector wiring (extension)

In `packages/extension/lib/background/connector-handlers.ts`:

1. Add `'deriveAppSecret'` to the **allowed methods** and to the **`APPROVAL_METHODS`** set
   (it must show an approval, same as `signData`).
2. Add a dispatch case mirroring the `signData` case:

```ts
case 'deriveAppSecret': {
  const session = await requireConnected(origin);          // gives session.seedHex + the origin
  const domain = params[0];
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 128
      || /[^\x20-\x7e]/.test(domain)) {
    throw connectorError('InvalidRequest', 'deriveAppSecret requires a short printable-ASCII domain string');
  }
  const approved = await requestApproval(
    'deriveAppSecret', origin, { domain }, senderTabId, preparedPanel,
  );
  if (!approved) throw connectorError('Rejected', 'User rejected the derivation request');

  // origin is bound by the wallet from the session — NEVER taken from params.
  return await offscreen.deriveAppSecret({ seedHex: session.seedHex, origin, domain });
}
```

3. Add the corresponding `offscreen.deriveAppSecret` host method wherever `offscreen.signData`
   is implemented (offscreen owns `seedHex` handling), returning `{ secret }`.
4. **Approval UI**: reuse/extend the `signData` approval panel. Copy must make clear this grants
   the site a **persistent app-identity secret** for `origin` (not a transaction, not funds).

### CRITICAL invariant
`origin` **must** come from the connector **session**, never from DApp-supplied params. This is
what stops site B from deriving site A's secret. Do not add an `origin` parameter.

## 5. Security properties this must guarantee

- **Origin-bound** — a site can only derive secrets under its own origin.
- **Isolated IKM** — derived from a non-spending role key via HKDF; leaking an app secret must
  never expose the seed, the unshielded signing key, or spending/Zswap keys.
- **Approval-gated** — user sees `origin` + `domain` before granting.
- **Deterministic & private** — reproducible from the seed; independent of any public value
  (must NOT equal `SHA-256(coinPk‖domain)` or any exposed public key).

## 6. Acceptance tests (`packages/core` + an extension integration test)

1. **Determinism** — `deriveAppSecret(seed, origin, domain)` returns the identical value across
   repeated calls.
2. **Portability** — a second wallet instance built from the **same seed** yields the identical
   value (this is the cross-device case that motivated the feature).
3. **Domain separation** — different `domain` ⇒ different secret.
4. **Origin isolation** — different `origin` ⇒ different secret; and a DApp cannot influence the
   origin used (params can't override it).
5. **Privacy** — output is independent of `coinPk`/address, and `!==` any key exposed by
   `getShieldedAddresses`/`signData.verifyingKey`.
6. **Key isolation** — output `!==` and does not reveal `keys[Roles.NightExternal]` or
   `keys[Roles.Zswap]`.

## 7. IKM decision — RESOLVED (`Roles.Metadata`)

**Resolved.** Implemented with `keys[Roles.Metadata]`, confirmed against source to be
non-spending: that role's private key is used only to derive a public identity bech32m address
(`packages/core/src/wallet/address.ts`), never for signing (`NightExternal`) or spending
(`Zswap`/`Dust`). Its public address is exposed, but the private key (the IKM) is not, and HKDF's
one-way extract-then-expand over it makes the output non-correlatable to that address — so the §5
privacy/key-isolation guarantees hold. See docs/adr/0001 "Open decisions" for the full record.

**Residual (upstream, not a blocker):** cross-*wallet* portability needs a standardized dedicated
HD role (see `wallet-sdk-upstream.md` §3.1); until the SDK assigns one, these secrets are
moth-scoped and may need a one-time re-derivation when the standard lands. The frozen v1
`salt`/`info` are unaffected.

Original framing (kept for context): the brief chose `keys[Roles.Metadata]` as an existing,
non-spending role. If ever revisited, prefer a **dedicated HD role/subpath** for app secrets, or
HKDF from a **dedicated hardened child** of the seed. The requirement is only that the IKM be
**stable, private, and isolated from spend/sign keys**.

## 8. Non-goals / notes

- Does **not** replace `signData` (still needed for message signing).
- Does **not** expose the seed or any spending/signing key.
- Optional follow-up: propose `deriveAppSecret` to the `@midnight-ntwrk/dapp-connector-api`
  spec so it's a first-class, typed method rather than an extension method called via cast.

## 9. Consumer contract (what the dapp will do — for context, not your work)

The Attested Names dapp will replace its three `SHA-256(coinPk‖domain)` derivations with:

```ts
const ownerSecret    = (await (api as any).deriveAppSecret('attested.me:names-deed:v1')).secret;
const issuerSecret   = (await (api as any).deriveAppSecret('attested.me:issuer:v1')).secret;
const governorSecret = (await (api as any).deriveAppSecret('attested.me:names-governor:v1')).secret;
```

then redeploy the credential registry + name-registry under the new (now-private) keys. The
dapp side is handled by the Attested Names session; the only cross-session contract is the §2
interface + §5 guarantees. As long as those hold, the two sessions can proceed in parallel.

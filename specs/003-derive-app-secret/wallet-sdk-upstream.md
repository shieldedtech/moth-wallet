# `deriveAppSecret` — Wallet SDK & Connector standardization (future upstream proposal)

**Status:** future / not scheduled. Companion to `spec.md` (the moth-wallet implementation
that ships first). This document is the plan for making `deriveAppSecret` a **standard**
capability — canonical derivation in `@midnightntwrk/wallet-sdk`, standard method in
`@midnight-ntwrk/dapp-connector-api` — so it works identically across wallets.

Written to be self-contained: it can be lifted out of this repo and taken to the SDK /
connector-api maintainers as-is.

---

## 1. What & why

A per-app, per-user secret that is **private-key-bound** (not recomputable from public data),
**deterministic/portable** (reproducible from the seed on any device), and **stateless** (no
backup beyond the seed). Privacy DApps need it for commitments, blinds, and deriving in-app
keypairs. It is the direct analogue of WebAuthn's **PRF** extension / FIDO **hmac-secret** — a
standardized "give me a stable secret for this origin," not a per-vendor add-on.

The moth-wallet implementation (`spec.md`) proves it end-to-end. This document exists because
**one property is only achievable via standardization: cross-*wallet* portability.** If each
wallet derives its own way, the same seed on a different wallet yields a different secret. To
make "same seed ⇒ same app identity, regardless of wallet software" true, the derivation must
be **one canonical, byte-identical function** — which is an SDK/spec concern, not a per-wallet
one.

## 2. Two layers, two homes

| Layer | Home | Responsibility |
|-------|------|----------------|
| **Derivation algorithm** | `@midnightntwrk/wallet-sdk` | The normative, byte-exact KDF. Audited once; identical output across every wallet that calls it → cross-wallet portability. |
| **Connector method** | `@midnight-ntwrk/dapp-connector-api` | The typed `WalletConnectedAPI` method + the non-negotiable security requirements (origin-binding, approval, key isolation). |
| **Wallet (moth, Lace, …)** | each wallet repo | Thin adapter: connector method → SDK function → approval UI. Almost no crypto of its own. |

## 3. Normative derivation (v1)

The SDK exposes a pure function, e.g.:

```ts
// @midnightntwrk/wallet-sdk
export function deriveAppSecret(
  ikm: Uint8Array,        // isolated, non-spending HD role key (see §3.1)
  origin: string,         // the DApp origin, supplied by the wallet from the session
  domain: string,         // caller-chosen label
): Uint8Array /* 32 bytes */;
```

**Algorithm (v1) — these constants are NORMATIVE and MUST NOT change within v1:**

- KDF: **HKDF-SHA-256** (RFC 5869), output length **32 bytes**.
- `salt` = `utf8("midnight:dapp-app-secret:v1")`
- `info` = `utf8("midnight:dapp-app-secret:v1|" + origin + "|" + domain)`
- Output is the raw 32 bytes (hex-encoded at the connector boundary).

Vendor-neutral strings (`midnight:…`, **not** `moth:…`) so every wallet produces identical
output. Any change to salt/info/length/KDF ⇒ a new version tag (`v2`), never an in-place edit.

### 3.1 IKM — the one thing that must be standardized

Cross-wallet determinism requires every wallet to feed the **same** IKM. That means a
**standardized HD path** dedicated to app secrets — e.g. a reserved `Roles.AppSecrets` role
(SLIP-0010/BIP-32-style), isolated from spend (`Zswap`) and sign (`NightExternal`) keys so a
leaked app secret can never expose funds.

**This is the primary open item for the standard.** Until the SDK assigns a dedicated role, the
moth-wallet prototype uses an existing non-spending role (`Roles.Metadata`) as a stand-in. That
is portable across **devices of moth-wallet** immediately, but its secrets are **moth-scoped**:
when the standard fixes a dedicated IKM path, prototype users may need a **one-time
re-derivation** (and, for anything committed on-chain, a redeploy). See §6.

## 4. Connector API addition

Add to `WalletConnectedAPI`:

```ts
/** Derive a deterministic, private, per-(origin, domain) 32-byte app secret. */
deriveAppSecret(domain: string): Promise<{ secret: string /* 32-byte hex */ }>;
```

Normative requirements the spec MUST state:

- **Origin is bound by the wallet** from the connection session; it is NOT a parameter. A site
  can only derive secrets under its own origin.
- **Approval-gated** — the wallet MUST obtain user consent, surfacing `origin` + `domain`, and
  making clear it grants a *persistent app-identity secret* (not a transaction, not funds).
- **Key isolation** — derived from an IKM that is not a spend/sign key; the returned secret MUST
  NOT reveal or equal any spending key, signing key, or the seed.
- **Determinism** — same `(seed, origin, domain)` ⇒ same result, across sessions and devices.
- `domain` validation — short printable-ASCII (recommend ≤128 chars).

## 5. Versioning & portability guarantee

- The `v1` tag in `salt`/`info` fixes the contract. Wallets advertise support; DApps that see a
  conforming wallet get identical secrets everywhere.
- Rotation/segregation is done by the DApp via `domain` (e.g. `names-deed:v1` → `names-deed:v2`),
  not by changing the algorithm.
- A future `v2` (different KDF/params) would be an additive, separately-tagged capability.

## 6. Migration / compatibility notes

- **Pin constants from the prototype.** The moth-wallet implementation SHOULD adopt the §3
  vendor-neutral `salt`/`info` **now** so those never change on upstreaming. (If the prototype
  ships `moth:…` strings, every adopter re-derives when it standardizes — avoidable.)
- **The IKM path is the residual migration risk** (§3.1). Flag clearly to early adopters that
  app secrets are provisional until the dedicated role is standardized.
- Because these secrets seed on-chain commitments (`owner_pk`, `issuer_pk`, `governor_pk` in the
  Attested Names consumer), any derivation change is a **redeploy** for that consumer — which is
  exactly why the constants must be treated as a stable contract from v1.

## 7. Security considerations

- **Blast radius** — shared SDK crypto means one bug affects all wallets; the mitigation is
  audit-once at the SDK layer rather than N divergent per-wallet implementations.
- **New exposure surface** — exposing any seed-derived secret to web content is sensitive;
  origin-binding + approval + key-isolation are the controls. Prior art: WebAuthn PRF, FIDO
  hmac-secret (both standardized with equivalent guarantees).
- **No raw key export** — the connector only ever returns the derived child secret for the
  requesting origin, never the IKM, role key, or seed.

## 8. Prior art

- **WebAuthn PRF extension / FIDO CTAP `hmac-secret`** — per-credential deterministic secrets,
  standardized (the closest analogue).
- **SLIP-0010 / BIP-32** — hardened child-key derivation from a seed along a dedicated path.
- **HKDF (RFC 5869)** — the extract-then-expand construction used here.

## 9. Open questions for the SDK/connector maintainers

1. The dedicated **IKM HD role/path** (§3.1) — the one blocker for true cross-wallet portability.
2. Whether to bind **`networkId`** into `info` (isolate secrets per network) — leaning no, since
   an app identity is usually network-independent, but worth an explicit decision.
3. Approval UX guidance — recommended copy + a "remember for this origin" option.
4. Discovery — how a DApp detects support (capability flag vs. try/catch on the method).

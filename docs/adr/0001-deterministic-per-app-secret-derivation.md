# ADR 0001 — Deterministic per-app secret derivation (`deriveAppSecret`)

- **Status:** Accepted and implemented; IKM (`Roles.Metadata`) confirmed for the prototype — see "Open decisions" for the cross-wallet residual
- **Date:** 2026-07-24
- **Deciders:** moth-wallet session; handed off from the Attested Names (`.shielded`) dapp session
- **Security sensitivity:** HIGH — exposes a seed-derived secret to web content. Gate like a new connector capability; run the VULNHUNT pass before shipping.
- **Related:** `specs/003-derive-app-secret/spec.md` (implementation brief), `specs/003-derive-app-secret/wallet-sdk-upstream.md`

## Context

DApps need a stable, private, per-user identity secret (for commitments, deriving an in-app keypair, blinding). The wallet exposes no primitive that provides one safely. Two derivation strategies were tried by the consumer dapp and both fail a required property:

- **Public-value derivation** — `SHA-256(coinPk ‖ domain)`, where `coinPk` (`shieldedCoinPublicKey`) is encoded in the user's shared shielded address. It is therefore **recomputable by anyone who knows the address** — not secret. This is the actual flaw shipping today: `owner_secret` / `issuer_secret` / `governor_secret` are all derived this way.
- **Signature seed** — `signData` is **randomized** on this wallet (same message + same `verifyingKey`, different signatures each call; empirically verified). A signature cannot seed a **reproducible** secret.

A per-app secret must be simultaneously:
1. **Private-key-bound** — not recomputable from any public/shareable value;
2. **Deterministic / portable** — reproducible from the seed on any device;
3. **Stateless** — nothing to back up beyond the seed the user already has.

Public-key derivation gives up (1); signatures give up (2); a "random secret + backup" gives up (3). Only a **deterministic KDF from the seed** yields all three — and the wallet is the only component that can do it, because it alone holds the seed.

## Decision drivers

- Close a real, root-level identity flaw (a "secret" derivable from a public address undermines identity binding no matter how sound the downstream ZK circuits are).
- Give the seed-derived secret **all three** properties above.
- Contain blast radius: leaking an app secret must never expose the seed or any spend/sign key.
- Prevent one origin from deriving another origin's secret.

## Considered options

| Option | Private-key-bound | Deterministic/portable | Stateless | Verdict |
|---|:--:|:--:|:--:|---|
| A. Public-key derivation `SHA-256(coinPk‖domain)` | ❌ | ✅ | ✅ | **Rejected** — not secret (current flaw) |
| B. Signature seed `SHA-256(domain‖sig)` | ✅ | ❌ | ✅ | **Rejected** — `signData` non-deterministic |
| C. Random secret + explicit backup | ✅ | ❌ (export/import) | ❌ | Fallback only, where seed-only recovery isn't required |
| **D. HKDF-SHA-256 over a non-spending seed role key** | ✅ | ✅ | ✅ | **Chosen** |

## Decision

Add a wallet connector capability:

```ts
deriveAppSecret(domain: string): Promise<{ secret: string }>   // 32-byte hex
```

- **Derivation:** HKDF-SHA-256 (extract-then-expand, not a bare hash) with IKM = a **non-spending HD role key**; `salt = "midnight:dapp-app-secret:v1"`; `info = "midnight:dapp-app-secret:v1|${origin}|${domain}"`. Output 32 bytes. Same `(seed, origin, domain)` ⇒ same secret, always. Lives in `packages/core/src/wallet/app-secret.ts`, exported alongside the other `derive*`.
- **Vendor-neutral v1 constants (`midnight:`, not `moth:`) are NORMATIVE and frozen for v1** so this extension implementation and a future wallet-sdk implementation produce **byte-identical** secrets and adopters never re-derive.
- **Origin is bound by the wallet from the connector session — NEVER taken from DApp params.** This is the control that stops site B deriving site A's secret. There is no `origin` parameter.
- **Approval-gated:** `deriveAppSecret` joins `APPROVAL_METHODS`; the approval panel (reusing the `signData` panel) shows `origin` + `domain` and makes clear it grants a persistent app-identity secret — not a transaction, not funds.
- **Ship as a wallet extension method** (DApps call via a cast); it is **not** in `@midnight-ntwrk/dapp-connector-api` v4.0.1. Proposing it upstream as a typed connector method is a follow-up (spec §8).

## Consequences

**Positive**
- DApps get a secret that is private-key-bound, deterministic/portable, and stateless — the foundation for sound per-app identity (commitments, in-app keypairs).
- Fixes the shipping flaw at its root without new user-managed backups.
- Frozen v1 constants make the extension ↔ wallet-sdk migration a byte-compatible no-op.

**Negative / risks**
- **HIGH sensitivity:** a seed-derived secret crosses into web content. Mitigated by origin-binding, approval-gating, isolated non-spending IKM, and a mandatory VULNHUNT pass.
- **Consumer coupling:** adopting this changes `owner_pk`/`issuer_pk`/`governor_pk`, so the consumer dapp must **redeploy** its registries under the new keys. Not hot-swappable; the wallet ship + dapp redeploy must be coordinated.
- Extension-method (cast) ergonomics until/unless it lands in the connector spec.

### Post-quantum considerations

No post-quantum change is warranted here, and none would help:

- **The crypto this feature adds is already quantum-appropriate.** HKDF-SHA-256
  is a hash/symmetric construction; against a quantum adversary it loses only
  ~half its bits (Grover), so the 256-bit output retains ~128-bit security. There
  is no "PQ KDF" to swap to — HKDF-SHA-256 *is* the standard quantum-resistant
  choice. Do NOT change the KDF for PQ reasons; it would break the frozen v1
  constant for zero benefit. (SHA-512 would only widen an already-sufficient
  margin, and is likewise disallowed within v1.)
- **The quantum-vulnerable crypto is entirely Midnight's asymmetric primitives**
  — Ed25519 signatures, Zswap ZK/commitments, the HD key derivation — which this
  wallet cannot change.
- **Residual, and why hardening the secret alone is pointless:** the IKM is a
  *private* HD role key whose *public* key is derivable/exposed. A quantum
  adversary that could invert Ed25519 to recover that private key could recompute
  the secret — but the same adversary would already hold the wallet's
  NightExternal/Zswap spend keys and drain it. The app secret's quantum exposure
  is therefore never worse than the wallet's overall exposure (Midnight's classical
  crypto). The design's real protection — HKDF over a *private* key with a secret
  salt, output independent of any public value — is the correct classical posture,
  and classical is the threat model that governs until Midnight itself goes PQ.

## Open decisions

- **Which IKM role (spec §7) — RESOLVED for the prototype.** Implemented with
  `keys[Roles.Metadata]`. Verified against source that this role is non-spending
  and not security-load-bearing: its private key is used *only* to derive a
  public identity bech32m address (`packages/core/src/wallet/address.ts`), never
  for signing (`NightExternal`) or spending (`Zswap`/`Dust`). Its *public*
  address is exposed, but the *private* key (the IKM) is not, and HKDF's one-way
  extract-then-expand over that private key with the frozen salt makes the output
  independent of and non-correlatable to the public address — so the §5 privacy
  and key-isolation guarantees hold.
  - **Residual (upstream, not a blocker here):** cross-*wallet* portability needs
    a standardized dedicated HD path (a reserved `Roles.AppSecrets`), per
    `wallet-sdk-upstream.md` §3.1. Until the SDK assigns one, these secrets are
    **moth-scoped**; when the standard fixes the IKM path, prototype users may
    need a one-time re-derivation (and, for on-chain commitments, a redeploy).
    Flag this to early adopters. The frozen v1 `salt`/`info` are unaffected.

## Confirmation (acceptance tests — spec §6)

1. **Determinism** — repeated calls return the identical value.
2. **Portability** — a second wallet from the same seed yields the identical value.
3. **Domain separation** — different `domain` ⇒ different secret.
4. **Origin isolation** — different `origin` ⇒ different secret; DApp params cannot override origin.
5. **Privacy** — output independent of `coinPk`/address; `!==` any key from `getShieldedAddresses`/`signData.verifyingKey`.
6. **Key isolation** — output `!==` and does not reveal `Roles.NightExternal` / `Roles.Zswap` keys.

Landing these tests (in `packages/core` + an extension integration test) plus a clean VULNHUNT pass discharges this ADR.

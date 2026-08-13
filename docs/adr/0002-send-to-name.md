# ADR 0002 — Send-to-name (`.shielded` name resolution)

- **Status:** Accepted and implemented (Phase 1) on `feat/send-to-name`
- **Date:** 2026-07-24
- **Related:** Attested Names dapp ADR 0002 (wallet-provider integration guidance — the consumer-side spec this responds to); moth-wallet ADR 0001 (`deriveAppSecret`, which the registry's Phase 2 uses)

## Context

The `.shielded` name registry gives human-readable names with privacy-preserving
ownership. The Attested Names session published integration guidance (their ADR
0002) describing a three-phase wallet integration. This ADR covers the wallet
side of **Phase 1 — resolution & send-to-name** (read-only; no keys, no proving).

Two facts from the registry constrain the design, confirmed by reading the
resolver + contract, not assumed:

- **No hosted resolver yet** — only a local dev backend (`http://localhost:4000`).
  The registry's own "resolution transport" decision is unpinned.
- **The `address` public record is not yet canonicalized** — the resolver's
  seed data uses placeholder values (`midnight1qxyz…`), not the Midnight bech32m
  form the wallet validates/sends to. This is the registry's open decision on
  record-type formats.

## Decision

Ship Phase 1 now with a **configurable resolver and safe-degrade**, so the
wallet is ready the moment the registry hosts a resolver and canonicalizes the
address format, and behaves safely until then.

- **`.shielded` suffix convention.** A recipient typed as `alice.shielded` is
  treated as a name; the suffix is stripped and the bare name (NFC + trim +
  lowercase, matching the resolver's `normalizeName`) is forward-resolved. A
  raw address is never treated as a name. There is **no reverse (address→name)
  lookup** — ownership is private by design.
- **Configurable resolver URL** (`ExtensionSettings.nameResolverUrl`, set in
  Settings → Addresses). Null disables send-to-name (opt-in). The fetch runs in
  the background service worker, where `host_permissions` apply (localhost and
  `*.midnight.network` are already granted; an arbitrary-host resolver would
  need a manifest entry).
- **Forward resolution, debounced + cached by name.** `name → records.address`
  via `GET {resolver}/api/names/:name/resolve`.
- **Safe-degrade on the send.** The resolved value is used only when it is a
  valid Midnight address of the recipient token's kind; otherwise the line
  isn't sendable and the UI says the name has no usable address. Every resolver
  failure (unreachable / 404 / bad response / no address record) returns a
  typed miss, never throws.
- **Verification stated precisely.** The badge reads "resolved via .shielded"
  (+ the registry's `verified`/`unverified` level) — meaning *this name
  publishes this record*, NOT "this address belongs to person X". Resolution is
  not identity.
- **Confusable/homograph warning.** Send-to-name is a phishing surface; a name
  with any non-ASCII character is flagged before sending. Pure-ASCII names never
  warn.

## Consequences

- The high-value feature (send-to-name) is buildable and testable now against
  the dev resolver, and ships-ready without rework once transport + address
  format land.
- Until the address record is canonical, resolving against the current spike
  data yields a non-sendable result — surfaced clearly, not silently.
- **Not implemented here:** Phase 2 (owning/managing names, which uses
  `deriveAppSecret` for the deed key) and Phase 3 (trust-gated names). No
  reverse lookup, ever (privacy model).

## Open (owned by the registry, not the wallet)

- Hosted resolver + a stable resolver contract (their "resolution transport").
- Canonical `address` record format (their record-type-semantics decision).
- Private-record viewing-grant mechanism (Phase 1.5).

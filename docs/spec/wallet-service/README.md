# Wallet Service — Living Spec

This is the design document for evolving `moth-wallet` from a local-machine developer tool into a service that Web2 applications can call to transact on Midnight without ever touching spending keys themselves.

The doc lives next to the code it describes. **Pull requests that change behaviour in the service path must update the relevant section here in the same PR.** A spec that lies about what the code does is worse than no spec.

## Questions and corrections

Open a GitHub issue. These sections have no named owner on purpose — the
repository is the point of contact, so a question reaches whoever is maintaining
the area rather than one person's inbox, and the answer stays where the next
reader will find it.

**One exception.** Anything describing a *vulnerability* — in this spec's threat
model, in the key-management design, or in the code implementing them — must not
go in a public issue. Use GitHub's private vulnerability reporting, as
[`SECURITY.md`](../../../SECURITY.md) sets out. A public issue is a disclosure,
and for a wallet that is a disclosure to whoever is watching the repository.

## Status board

| #  | Section                                                       | Status   | Last updated  |
|----|---------------------------------------------------------------|----------|---------------|
| 01 | [Architecture](./01-architecture.md)                          | draft    | 2026-06-21    |
| 02 | [Authentication](./02-authentication.md)                      | draft    | 2026-06-23    |
| 03 | [Authorization & policy](./03-authorization-policy.md)        | draft    | 2026-06-23    |
| 04 | [Approval pipeline](./04-approval-pipeline.md)                | draft    | 2026-06-23    |
| 05 | [Key management](./05-key-management.md)                      | **accepted** | 2026-06-21 |
| 06 | [Audit & observability](./06-audit-observability.md)          | draft    | 2026-06-22    |
| 07 | [Failure modes](./07-failure-modes.md)                        | draft    | 2026-06-23    |
| 08 | [Multi-tenant roadmap](./08-multi-tenant-roadmap.md)          | draft    | 2026-06-23    |
| 09 | [Threat model](./09-threat-model.md)                          | draft    | 2026-06-23    |
| —  | [Commands reference](./COMMANDS.md)                           | draft    | 2026-06-22    |
| —  | [Testing guide](../../TESTING.md) (`docs/TESTING.md`)         | draft    | 2026-06-23    |

Statuses:
- **draft** — written, looking for review
- **accepted** — review complete, implementation may begin / has begun
- **superseded** — a newer section replaces it (link in front-matter)
- **tbd** — placeholder, not yet drafted

See [CHANGELOG.md](./CHANGELOG.md) for date-stamped changes.

## Scope

In scope:

- A wallet host process that holds Midnight spending keys, exposes RPC verbs over a Unix socket (today) and over TCP+TLS (later), and performs the full transaction lifecycle (build → balance → prove → sign → submit) on behalf of authenticated callers.
- A path from the current local-machine daemon (`moth daemon serve`) to a single-tenant network-accessible service, then to a multi-tenant custodial deployment.
- The security model that lets each step happen without making the previous one less safe.

Out of scope:

- The TUI's own UX (covered by the repo's normal product evolution).
- Midnight protocol-level changes (proof server APIs, ledger semantics, indexer schema). Where the service depends on these we reference them; we do not propose changes here.
- General Cardano ↔ Midnight bridge security.

## Non-goals

- Replacing the in-process `moth` CLI. The standalone CLI continues to work for users who run a wallet on their own laptop.
- Self-custodial multi-user wallets. Multi-tenant in this doc means a custodian holds funds for users; the users do not hold their own keys. Self-custody requires a fundamentally different design (key derivation per user, threshold signing, recovery flows).
- Bridging to non-Midnight chains.

## Glossary

| Term         | Meaning |
|--------------|---------|
| **Daemon**   | The process that hosts the wallet and serves RPC. Today: `moth daemon serve` or the TUI hosting in-process. Future: a systemd unit or container. |
| **Wallet host** | Synonymous with daemon. |
| **Service mode** | Daemon listening on the network with AuthN/AuthZ, accepting traffic from Web2 apps. |
| **Verb**     | An RPC method exposed by the daemon. Examples: `getState`, `transferTokens`, `callCircuit`, `submitTransaction`. |
| **L1**       | Filesystem permissions on the Unix socket (mode 0600 in a 0700 directory). Kernel-enforced same-UID access. |
| **L3**       | Per-operation human confirmation. In the TUI: the modal. In service mode: a policy decision that may or may not page a human. |
| **STAR**     | Smallest NIGHT unit. 10^6 STAR = 1 NIGHT. |
| **SPECK**    | Smallest DUST unit. 10^15 SPECK = 1 DUST. DUST is non-transferable (it pays fees, generates from NIGHT, decays). |
| **Single-tenant** | One operator's wallet, possibly many Web2 callers, all served by one wallet host. |
| **Multi-tenant** | Many wallets (one per user), one wallet host (the custodian). |

## How to read this doc

Start with [09-threat-model.md](./09-threat-model.md) (when written) to understand what the design is defending against. Then [05-key-management.md](./05-key-management.md) — the most consequential decisions live there. Then the architecture / authn / authz / approval sections in order. The roadmap (08) shows the staged path from today's local daemon to a production-grade service; each intermediate step is something we'd actually ship rather than a big-bang rewrite.

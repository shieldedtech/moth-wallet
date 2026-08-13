---
status: draft
last-updated: 2026-06-22
---

# 06 — Audit & Observability

## Stage-1.5 (today)

A persistent JSONL audit log lives at `~/.moth/daemon-audit.log`, mode `0600` in a `0700` directory. Every RPC request flowing through `buildWalletHandlers` and every daemon lifecycle event in `moth daemon serve` / `moth tui` appends one line to it. The host process (CLI serve or TUI) doesn't need any extra wiring beyond passing an `AuditLog` instance into the handler dependency bundle — the `withAudit` wrapper inside `wallet-handlers.ts` captures decisions and outcomes for free.

Implementation: `packages/core/src/daemon/audit-log.ts`.

### Entry shape

One JSON object per line. Two discriminated variants by `kind`.

**RPC entries** (`kind: "rpc"`):

```json
{
  "ts": "2026-06-22T22:29:48.310Z",
  "kind": "rpc",
  "wallet": "alice",
  "network": "undeployed",
  "verb": "transferTokens",
  "summary": "Send 0.5 NIGHT to mn_addr_…",
  "details": ["Wallet: alice", "Network: undeployed", "Recipient: …"],
  "decision": "auto-approve",
  "txHash": "0x…",
  "status": "SUCCESS"
}
```

`decision` is one of `auto-approve` (headless mode, queue auto-approved), `user-approve` (TUI host, human Enter), or `user-denied` (TUI host, human N or `drainAsDenied` on shutdown). On error, `error: { code, message }` replaces the result fields.

**Lifecycle entries** (`kind: "lifecycle"`):

```json
{
  "ts": "2026-06-22T22:29:48.310Z",
  "kind": "lifecycle",
  "wallet": "alice",
  "network": "undeployed",
  "event": "daemon-start",
  "message": "PID 19631"
}
```

`event` values: `daemon-start`, `socket-bound`, `sync-complete`, `shutdown-signal`, `daemon-stop`.

### Daily rotation

On first write each day, the existing file (if any) is renamed to `daemon-audit.log.YYYY-MM-DD` and a fresh `daemon-audit.log` starts. The rotation check is one `stat()` per write — cheap. No size-based rotation today; if a single day's log exceeds reasonable disk, the operator rotates manually or moves to stage-2 transport-level audit.

### Redaction

The audit log writes exactly what the `queue.request` modal would have shown the operator. By construction those summary + details strings are operator-facing and contain no plaintext secrets (no mnemonics, no seedHex, no witness payloads). They DO contain operator-meaningful identifiers (full recipient addresses, contract addresses, full tx hashes) — those are public information once the tx lands and are part of what makes the log useful.

### Best-effort writes

`AuditLog.record()` swallows every error. An audit failure must never crash the daemon. If an entry can't be written, you'll notice the missing line later and investigate; the alternative — a daemon that refuses RPCs when the disk is full — is worse.

## Stage 2 (next)

- **Per-key correlation**: an `apiKeyId` field on every RPC entry once stage-2 AuthN lands. Today every entry is implicitly the host's UID.
- **Outcome details**: capture per-tx fees, block height of finalization, proof-server latency.
- **Operator query tool**: `moth audit query --wallet X --since 2026-06-01 --verb transferTokens`. Reads the rotated files transparently.

## Stage 3+ (later)

- **Tamper evidence**: hash-chain successive entries (Trillian-style append-only Merkle tree). Mitigates "root erased a line" attacks.
- **Forwarding**: optional `--audit-forward syslog://…` / `loki://…` / `vector://…` so the audit stream lands in a SIEM alongside the local file.
- **Metrics**: requests-per-verb, success/failure rates, p50/p95/p99 latency, queue depth on the approval pipeline, daemon resident memory. Exposed at `/metrics` for Prometheus pull.
- **Dashboards**: shipped Grafana JSON for the standard verb-by-verb view.

## Open questions

- **Retention**: how long do we keep `daemon-audit.log.YYYY-MM-DD` files? Forever is the safe default and disk is cheap; for regulated deployments we likely need an operator-configurable policy. Park until a deployment actually asks.
- **Caller-side request IDs**: should the daemon return a `requestId` echoed back in the audit entry so a CLI invocation's stderr can be correlated to a daemon-side audit line without shared secrets? Yes, almost certainly — defer to stage 2 alongside the API-key work.
- **`getState` and other read verbs**: today the audit log only captures the L3-gated write verbs (everything that runs through `withAudit`). Should reads be audited too? Probably yes once we have per-key correlation (so we can answer "which API key polled `getState` 10k times last night"). Not useful in stage 1.

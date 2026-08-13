---
status: draft
last-updated: 2026-06-23
---

# 07 — Failure Modes

How the daemon behaves when each part of the stack misbehaves. Every entry below pairs the symptom with the operator-visible consequence, the recovery path, and whether the consumer's RPC call gets a structured error or a hang.

## Transaction lifecycle failures

The daemon's write-verb pipeline is `parse → approve → build → balance → prove → sign → submit → finalize`. Failure at each step:

| Step | Failure | What the consumer sees | What the daemon does |
|---|---|---|---|
| parse | params don't match the verb's schema | `INVALID_PARAMS` with the field name | log via audit, return |
| approve | L3 modal denied / scope check fails / timeout | `UNAUTHORIZED` or `TIMEOUT` | audit the denial, no chain side-effects |
| build | facade can't construct the tx (e.g. unknown contract address, invalid args) | `INVALID_PARAMS` or `INTERNAL_ERROR` from the SDK | audit, return |
| balance | `Insufficient Funds: could not balance dust` (or NIGHT) | `WALLET_ERROR` with the SDK message preserved | audit, return |
| prove | proof-server unreachable | `NETWORK_ERROR` after retry budget exhausts | retry-with-backoff (see below) |
| prove | proof-server returns a malformed / rejected proof | `INTERNAL_ERROR` with the SDK's reason | audit, return |
| sign | key state inconsistent (should be impossible post D-KM-3) | `INTERNAL_ERROR` | audit, return |
| submit | node WS dropped mid-call | `NETWORK_ERROR` | retry once with fresh connection, then return |
| submit | node rejected (nonce conflict / weight / authority) | `WALLET_ERROR` with chain-side reason | audit, return |
| finalize | block-finalization timeout (chain stalled) | `TIMEOUT` after configurable deadline | audit, return — the tx may still finalize; consumer must probe |

The `withAudit` wrapper in `wallet-handlers.ts` catches every throw and stamps the result/error onto the corresponding audit entry, regardless of which step failed. No silent skips.

## Per-wallet concurrency

The wallet facade is not safe for concurrent `build → submit` cycles. UTXO selection is stateful — two simultaneous calls would race on the same UTXOs and one would submit a tx the chain rejects as a double-spend.

The daemon serialises all write verbs on a per-wallet mutex inside `WalletFacade`. Consequences:

- Two `transferTokens` RPCs from the same connection (or two connections) queue behind each other. Throughput is single-tx, prove-time-bound — roughly one write op per 20–30 seconds against `undeployed`.
- A long-running deploy blocks a fast transfer behind it. Operators who want concurrency need multiple wallets, not multiple connections.
- Read verbs (`getState`, `version`, `auth`) do not contend on the mutex.

This is documented behaviour, not a bug. Multi-tenant deployments get parallelism via D-ARCH-2 (one daemon per wallet); within a wallet, serialisation is correct.

## Approval timeout mid-pipeline

The L3 modal (TUI) and the stage-3 async approval can both stall arbitrarily. Behaviour:

- `queue.request` holds the build/balance/prove/sign/submit sequence at the very start of the verb — before any chain-visible state is committed and before any UTXO is reserved. A timeout there cleanly throws `UNAUTHORIZED`; no rollback needed.
- Once approval returns, the rest of the pipeline runs unattended. The operator cannot "cancel" mid-prove via the modal — there's no UI for it and proof generation is non-cancellable in the SDK today.
- If the consumer's RPC `timeoutMs` fires while the daemon is mid-prove, the daemon keeps proving and submitting — the client's `TIMEOUT` error is local to the connection. The audit log will show the eventual result. The consumer should treat its TIMEOUT as "result unknown; query state" rather than "tx didn't happen."

## Proof server unreachable

Proof generation talks HTTP to `proof-server` (default `http://localhost:6300`). When unreachable:

- The SDK's HTTP client retries internally with exponential backoff up to its own budget (~30s, configurable via SDK options).
- After the SDK gives up, the daemon's verb throws; `withAudit` records `error: { code: 'INTERNAL_ERROR', message: '<SDK message>' }`; the consumer sees a `WALLET_ERROR` from `renderDaemonError`.
- No UTXO is reserved, no chain state changed. Retry the RPC after the proof server is back.

## Node submission rejection

After proof + sign, the daemon calls `facade.submitTransaction()` which submits over WS to the substrate node. Rejection reasons:

| Reason | Recovery |
|---|---|
| `InvalidNonce` / `Future` | Sync caught up between balance and submit; rare. Retry. |
| Block weight / fee underestimated | Tx was too large; split into smaller ops. Maintenance batch verb handles this case automatically. |
| Ledger-side: bad witness / authority mismatch / state-root drift | Contract or wallet state changed in a way the proof no longer matches. Re-build from current state. |
| Node disconnected mid-submit | The daemon retries once with a fresh WS connection. After that, it reports `NETWORK_ERROR` and the consumer must probe — the tx may have landed before the disconnect. |

The daemon does NOT auto-retry a rejected tx with re-proving. The consumer or the operator decides.

## Daemon crash mid-submit

The window between "submitTransaction returns success" and "audit entry is written" is small but real. If the daemon SIGKILL's in that window:

- The tx is on-chain; the audit log doesn't know.
- On restart, the daemon doesn't replay or reconcile. The operator can query the indexer for txs from this wallet around the crash time to reconstruct.
- Audit log writes are `appendFileSync` (synchronous), so under normal SIGINT/SIGTERM the daemon completes the write before exiting. Only an OOM kill or a panic mid-syscall leaves the gap.

Future: a `crashRecoveryProbe` daemon-start step that reads the last N audit entries and queries the indexer for each verb that doesn't have a finalised txHash. Out of scope today; the crash window is narrow enough that operators can spot anomalies in the audit log.

## Wallet sync drift between concurrent calls

`getState`, `transferTokens`, and `getState` again from the same consumer should see a monotonically-advancing view: balances only go down between t0 and t1 if the consumer spent in between, never up except via chain progress.

This holds because:

- Sync events flow into `latestBalances` continuously; the per-call snapshot read in `withAudit` captures a single point in time.
- After `submitTransaction` returns, the wallet's view includes the just-submitted tx (the SDK applies the unconfirmed effect optimistically). The next `getState` reflects it.
- Re-org tolerance: the SDK accepts that a finalised block can revert (rare on production chains, expected on devnet). The daemon's audit log captures the original tx; a re-org that orphans it shows up as a balance reversion in `getState` but no explicit "tx undone" event. Consumers that care about finality should wait for N confirmations before treating a tx as final.

## Storage failures

| Path | Symptom | Daemon behaviour |
|---|---|---|
| `~/.moth/daemon-audit.log` | Disk full / permission error | Best-effort: `appendFileSync` catches the throw and discards the entry. The daemon does NOT crash. The operator should monitor disk; missing audit lines are a real audit gap. |
| `~/.moth/api-keys/<id>.key` | File unreadable mid-verify | Treated as "unknown id" — auth fails, request rejected. Operator must `chmod` and retry. |
| `~/.moth/sync/<network>/<wallet>/` | Cache write fails | Sync continues from chain on next start; no in-flight failure. |
| `~/.moth/wallets/<wallet>.keystore` | Read fails at `WalletManager.unlock` | Daemon refuses to start. Operator restores from backup. |

## Stale Unix socket from a crashed daemon

`startDaemon` probes the existing socket file before binding:

1. If `connect()` succeeds → another daemon is alive at that path; refuse to start (`another moth daemon is already listening at <path>; refusing to bind`).
2. If `connect()` refuses → stale socket from a crash; unlink and re-bind.

Within the probe's 2s timeout, an in-flight `moth daemon serve` can't race itself — the second one observes the first's listener and bails.

## TCP transport: connection lifecycle quirks

- **Half-open TCP**: a consumer's machine pulls its network cable mid-RPC. The daemon's TCP socket stays in the kernel's send queue until the keepalive interval expires (Linux default 2h). The consumer's local RPC will time out on its `timeoutMs`; the daemon's resources stay tied up until the keepalive cleans them. Mitigation: set a sensible `setKeepAlive(true, 30_000)` on each accept (TODO; tracked).
- **Client crashed mid-call**: the daemon sees EOF on the socket; the in-flight request resolves with `CLOSED`; subsequent state-mutating side-effects already committed (proof/submit) are unaffected. The audit log captures the tx hash regardless.
- **Rapid connect-disconnect storm**: no per-IP rate limit today. Trusted-deployment assumption; stage-3 deployments behind a reverse proxy get rate-limiting from the proxy.

## Indexer down

- Sync stops making progress. `synced` flag may go stale; `getState` still returns the last-known balances.
- Write verbs depend on `state.shielded.progress` and friends; with the indexer down they freeze. Eventually they time out in the SDK and report `NETWORK_ERROR`.
- The daemon does NOT health-check the indexer on a timer. Operators monitor at the indexer layer.

## Node down

- Submit fails immediately with `NETWORK_ERROR`. Consumers retry once the node is back.
- No state is committed locally. The audit log records the attempt + failure.

## Open questions

- **Cold-backup recovery**: today recovery is "the BIP-39 mnemonic on a piece of paper." For multi-tenant deployments at stage 4, an HSM or KMS-rooted recovery procedure is required. Scope to [08](./08-multi-tenant-roadmap.md).
- **Healthcheck endpoint for load balancers**: when stage 3+ puts the daemon behind a proxy, the proxy needs a non-RPC HTTP GET to probe liveness. The daemon doesn't expose one today; adding `/health` returning HTTP 200 with `{ ready, syncedHeight, version }` is straightforward but worth speccing alongside the reverse-proxy design (section 04 / future section).
- **Re-org tolerance threshold**: how many confirmations does a "finalised" tx in the audit log need before consumers treat it as canonical? Chain-default behaviour varies. Probably a wallet-config option, not a daemon hardcode.
- **Replay attempt limits**: should a `NETWORK_ERROR`-classified submit be auto-retried at the daemon layer? Today no — consumers retry. The risk of double-submit on flaky transport vs the consumer-side simplicity favours single-attempt + report-back.

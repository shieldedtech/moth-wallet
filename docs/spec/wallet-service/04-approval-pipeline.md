---
status: draft
last-updated: 2026-06-23
---

# 04 — Approval Pipeline

## Stage 1 (today): synchronous in-process modal

Every write verb the daemon receives calls `queue.request(summary, details)`. The TUI host renders the head of that queue as a modal; the user answers `Enter` (approve) or `N` (deny); the daemon's handler unblocks with the verdict and proceeds or throws `UNAUTHORIZED`.

Properties:

- **Synchronous**: the RPC hangs until the human answers. Stage-1 CLIs use a generous default per-op timeout (5–10 min for prove-heavy ops) to leave room for the operator to walk away and come back.
- **In-process**: the queue lives in the same TUI process that hosts the daemon. No external service.
- **Single-decision**: every modal is a binary y/n. The user can't say "approve up to 100 NIGHT" or "approve once then ask me again next week."

Adequate for the developer-laptop case the TUI was originally built for. Falls over the moment the daemon runs anywhere a human isn't watching.

## Stage 2 (today): headless auto-approve with audit

`moth daemon serve --auto-approve` (also requires `MOTH_DAEMON_AUTO_APPROVE=1` — two-flag arming so a stray history entry doesn't disable consent) replaces the modal with synchronous-but-automated approval. Every request that reaches `queue.request` resolves true immediately; the `onAutoApprove` callback emits a `[daemon-serve auto-approve] <summary>` line to stderr plus details, and the same summary lands in `~/.moth/daemon-audit.log` via the `withAudit` helper.

This is **trusted automation**, not authentication: the operator who started the daemon is taking responsibility for every op it performs. Combined with the TCP-AuthN gate from stage 2 ([02](./02-authentication.md)), it's safe in CI / private service deployments because the AuthN check happens *before* auto-approve and the audit log captures who triggered each op.

What stage 2 does NOT have:

- A way to say "auto-approve transfers below 100 NIGHT but page a human above that."
- A way to ask a human asynchronously without blocking the RPC for the modal's full lifetime.
- A way to revoke approval after the fact (the on-chain tx is already finalized).

Stage 3 is the next layer that adds those.

## Stage 3 (proposed): tiered approval

Three tiers, decided per-request by the policy engine from [03 — Authorization & Policy](./03-authorization-policy.md). Every request gets exactly one of these dispositions:

1. **Within policy → auto-approve** synchronously, audit, proceed. Same code path as stage-2's auto-approve queue.
2. **Outside policy by a margin → fail closed.** Daemon returns `UNAUTHORIZED` with a hint message (e.g. "tx amount 5000 NIGHT exceeds key cd2f8af0's per-day cap of 1000 NIGHT, request is 5× over"). No human is paged because the op is so far over the line that pinging an operator would just be noise.
3. **Outside policy by less (gray zone) → async escalation.** Daemon enqueues an approval request, returns a `PENDING` status with a request id, and the operator gets a notification on a configured channel (Slack DM / email / PagerDuty / webhook). The original RPC blocks (with a long timeout) waiting for the operator's answer; the consumer's CLI / SDK polls or listens for completion.

### Policy → tier mapping

Decided from the rule that fires when matching the request against the key's policy:

| Rule shape | Disposition |
|---|---|
| All caps satisfied with > 50% headroom | auto-approve |
| All caps satisfied but tx is > 50% of the daily cap | gray-zone (escalate) |
| Per-call cap exceeded by ≤ 2× | gray-zone (escalate) |
| Per-call cap exceeded by > 2× | fail-closed |
| Daily aggregate cap exceeded by any amount | fail-closed |
| Recipient/contract not in allowlist | fail-closed (the operator pre-declared "these are the only safe targets") |
| Outside `allowedHours` window | gray-zone (off-hours ops are suspicious but legitimate) |

The thresholds (50% headroom, 2× per-call) are operator-tunable per-key. The defaults are conservative; an operator running tight automation can ratchet them down.

### Async channel: webhook-first

The operator declares a `notify` endpoint on the key (or globally):

```jsonc
{
  "notify": {
    "kind": "webhook",
    "url":  "https://ops.example.com/moth/approval",
    "signingKey": "<32-byte hex>"
  }
}
```

The daemon POSTs an HMAC-signed JSON body to that URL:

```json
{
  "requestId":   "8f3c6a…",
  "wallet":      "alice",
  "network":     "preprod",
  "apiKeyId":    "df4eb46c",
  "verb":        "transferTokens",
  "summary":     "Send 5000 NIGHT to mn_addr_…",
  "details":     ["…"],
  "policyRule":  "gray-zone: 5000 is 50% of daily cap (10000)",
  "expiresAt":   "2026-06-23T13:30:00Z"
}
```

The operator's downstream system (their own Slack bot, on-call rota, web form) reviews and answers by hitting a separate daemon endpoint:

```http
POST /approval/<requestId>     Authorization: Bearer <admin-key>
{ "decision": "approve" | "deny", "operator": "alice@…" }
```

Built-in helpers ship for the common channels (Slack incoming webhook, email via SMTP) but they're all thin wrappers over the webhook primitive. Operators with a SIEM/PagerDuty stack should wire through their existing routing.

### Timeout behavior

`expiresAt` is per-request, defaulting to 15 minutes for gray-zone ops. On timeout:

- **Auto-deny**: the safe choice and the default. The original RPC reject with `TIMEOUT`. The operator can retry with a fresh request id.
- Never auto-approve. There is no configuration that flips this default — that would defeat the purpose of the escalation.
- A future "hold and retry" mode (operator's downstream answers later, daemon replays the op) is plausible for non-time-sensitive ops, but the current default is fail-closed.

### Approval-back endpoint

A new built-in RPC on the daemon: `approval.resolve`. Requires a separate "admin" scope (or a dedicated approval key) so a compromised consumer key cannot grant itself approvals:

```jsonc
{
  "method": "approval.resolve",
  "params": {
    "requestId": "8f3c6a…",
    "decision":  "approve",
    "operatorRef": "alice@ops.example.com"   // for audit
  }
}
```

The daemon validates the request id is in `pending` state, that the bearer key has `approve` scope (new scope, parallel to read/write), and audits the approval alongside the original RPC.

### UX of the notification

The notification body carries everything an operator needs to make the call without going back to the audit log:

- `summary` (what the daemon would have shown in the L3 modal)
- `details` (verb-specific structured context)
- `policyRule` (which rule fired and what the headroom looks like)
- `recentSimilar` (optional, opt-in: "this is the 3rd transfer to this recipient in the last 24h")
- A direct link to the operator console / SIEM where the approve/deny buttons live

The summary stays the same string the queue would have rendered in the TUI modal — no fork.

### Storage of pending requests

`~/.moth/pending-approvals/<requestId>.json`, mode 0600, with the same record shape as the audit log plus a `state: 'pending' | 'approved' | 'denied' | 'expired'` field. The expiration sweep is a goroutine inside the daemon that runs every 30s.

A separate `moth daemon approval list` / `moth daemon approval show <id>` / `moth daemon approval resolve <id> --decision approve|deny` CLI mirrors the RPC for local debugging without standing up the webhook stack.

## Stage 4 (proposed): multi-tenant

The same tier model, but per-tenant. Each tenant has their own policy file, their own notify endpoint, their own pending-approval store. The router (see [08 — Multi-tenant roadmap](./08-multi-tenant-roadmap.md)) maps the JWT/API-key claim to the right tenant's daemon before any of stage-3's policy engine runs.

## Open questions

- **M-of-N approval for large ops**: should a tx above $10k-equivalent require two operator acks, not one? The webhook protocol could support this — `approval.resolve` accepts multiple operator answers, daemon resolves when N of M have answered. Worth implementing once a real deployment has the operator count to justify it.
- **Cool-down period as approval substitute**: rate-limit as a form of escalation — "key X just transferred to recipient Y; block any further transfer to Y for 1h." Pure policy concern; folds into [03](./03-authorization-policy.md), not here.
- **Forensic linkage**: when a tx settles on-chain, the audit-log entry has the txHash. The approval log entry needs the same so an investigator can answer "this on-chain tx — who approved it, when?" Audit log already carries the txHash; approval log should reference the audit's `requestId`. Park until stage 3 implementation; design is cheap, plumbing matters.
- **Approver authentication via separate identity**: should the approver be a different person (different API key) from the consumer? Stage-3 default is yes — an `approve` scope distinct from `write`. But for solo operators that's needless ceremony; a `--allow-self-approval` opt-in mode could exist. Park.

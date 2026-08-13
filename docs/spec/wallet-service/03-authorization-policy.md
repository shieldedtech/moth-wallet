---
status: draft
last-updated: 2026-06-23
---

# 03 — Authorization & Policy

## Stage 2.5 (today): per-key scopes

The simplest useful AuthZ. Each API key declares which set of methods it may invoke. The daemon enforces at the per-call gate, immediately after the AuthN check from [02](./02-authentication.md).

### Scope set

Two scopes today:

| Scope | Verbs allowed | Use case |
|---|---|---|
| `read` | `version`, `auth`, `getState` | Dashboards, balance pollers, sync-progress monitors |
| `write` | Every L3-gated write verb (transfer, deploy, call, dust register/deregister, maintenance insert-vk[s], submitTransaction, clearSyncCache) | CI bots, the operator's own automation |

A key can hold either, both, or neither. `version` and `auth` are always reachable regardless of scope — they're the handshake.

### Declaration

The scope set lives on the key record:

```json
{ "id": "df4eb46c", "scopes": ["read"], ... }
```

CLI:

```bash
moth daemon key gen --label "dashboard"      --scopes read
moth daemon key gen --label "ci-bot"         --scopes read,write
moth daemon key gen --label "transfer-only"  --scopes write          # default
```

Default is `write` (full access) so a `key gen` without `--scopes` keeps the stage-2 default. Read-only keys are an explicit opt-in.

### Server-side gate

`buildWalletHandlers` annotates each handler with its required scope:

- `handlers.getState.scope = 'read'`
- Every other handler defaults to `'write'` via the server gate's fallback.

The gate in `startDaemon`:

1. Method is `version` or `auth` → allow.
2. No auth handler configured → allow (Unix without AuthN).
3. `ctx.apiKeyId` absent → `UNAUTHORIZED: requires authentication`.
4. `ctx.scopes` doesn't include the method's required scope → `UNAUTHORIZED: requires the "<scope>" scope; key X has [<their scopes>]`.
5. Otherwise → dispatch to the handler.

The `[their scopes]` in the error message helps debug "I generated a read-only key and now my write call fails" without leaking which methods exist (the operator already knows the verbs).

### Default-deny by design

A handler without an explicit `.scope` annotation is treated as `'write'`. New verbs are write by default until someone explicitly opts them into `read`. A typo in the annotation goes the safe direction.

## Stage 3 (proposed): spend caps + allowlists

The next AuthZ layer. Scopes alone don't help if a write-class key is compromised — the attacker can drain the wallet. Bound the blast radius per-key.

### Spend caps

Per-key, per-day, per-token:

```jsonc
{
  "spendCaps": {
    "NIGHT":         { "perDay": "1000",      "perCall": "100"    },
    "0xabc…":        { "perDay": "5000",      "perCall": "500"    }
  }
}
```

Aggregated by the daemon over the audit log (the canonical source of "what did this key spend"). Calendar-day boundary in the daemon's local timezone is the simple choice; rolling 24h is the conservative one. Pick at implementation time.

### Allowlists

Per-key:

- `recipientAllowlist: [bech32m...]` — `transferTokens.to` must match one of these.
- `contractAllowlist:  [hex addr...]` — `callCircuit.contractAddress`, `deployContract` (any address — i.e. block deploys entirely if absent), `insertVerifierKey.contractAddress`.
- `circuitAllowlist:   { "<contractAddr>": ["circuitName", ...] }` — even within an allowed contract, only some circuits.

### Time-of-day windows

`allowedHours: { tz: "UTC", windows: [{from: "09:00", to: "17:00"}] }`. Operator-side rule for "this CI key only spends during the business day."

### Default-deny on multi-rule match

When a key's request matches multiple rules (e.g. a spend cap AND an allowlist), every rule must pass. Permissive-OR semantics would let any one rule unlock the others, which is the opposite of what operators want.

### Policy reload

Stage-3 policy changes via `moth daemon reload-policy` — an authenticated write-scope RPC that re-reads the per-key records (and any global policy file) and updates the in-memory gates. Surfaces in the audit log alongside the auth that triggered it.

### Policy DSL

Stay declarative — JSON inside the per-key record, plus an optional shared `~/.moth/policy.json` for cross-key defaults (e.g. "block all transfers over 10k NIGHT regardless of key"). No Rego / OPA dependency until multi-tenant complexity justifies it.

## Stage 4 (proposed): tiered async approval

A higher tier than "policy says yes/no." Some operations should require human approval, async, OUT OF BAND from the daemon-mode client. Today this is the TUI's L3 modal; at stage 4 it's a Slack DM / email / webhook to an operator group.

Detail in [04 — Approval pipeline](./04-approval-pipeline.md).

## Open questions

- **Policy engine location**: in the daemon or a sidecar (OPA)? Sidecar means a separate review process for policy changes, which is good for ops but adds a hop. Stage 3 default: in-daemon, declarative JSON. Park OPA until a multi-tenant deployment requires it.
- **Policy interaction with the approval pipeline**: policy says "approved with constraints" (e.g. spend within cap), what exactly fires the human escalation? Probably "any write op above 50% of the daily cap requires human ack." Tunable per-key. Park to [04](./04-approval-pipeline.md).
- **Anonymous read for `getState`**: explicitly rejected — a `read` scope key is the right granularity. No special-case for unauthenticated reads.
- **Read-class scope expansion**: should a read key be able to query the audit log via a future `auditQuery` verb? Probably yes, but the operator might want a separate `audit` scope so a dashboard can show balances without leaking historical activity. Defer until `auditQuery` is real.

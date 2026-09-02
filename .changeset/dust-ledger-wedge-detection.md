---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-cli': minor
---

Detect and steer users away from the devnet dust-ledger wedge (docs/bugs-found #15-style defect).

Some devnets (midnight-node 2.0.0-rc.4 / midnight-ledger 9.1.0.0-rc.3) can
enter a state where a DUST registration leaves the node's dust ledger unable
to reconcile with any wallet's, permanently — every subsequent dust spend,
from every wallet, fails with the same `InvalidDustSpendProof` /
`Custom error: 170` signature that a normal transient race also produces.
Only a chain reset clears it; retrying does not. This is not a Moth defect —
see `docs/upstream-issues/dust-ledger-wedge-invalid-dust-spend-proof.md` for
the evidence and the draft issue against `midnightntwrk/midnight-node` /
`midnight-ledger` — but Moth users hit it on shared and local devnets, so
Moth now detects and steers around it rather than retrying forever.

**Detection** (`@shieldedtech/moth-wallet`, `sync/dust-ledger-health.ts`): a
run of consecutive, independently built submissions rejected with the same
ambiguous signature — with a wallet/node ledger-version mismatch ruled out
first, and the chain confirmed still producing new blocks meanwhile — is
surfaced as `DustLedgerWedgedError` instead of a generic failure. Wired into
every fee-paying submission path: the extension's offscreen host, `moth
transfer` / `moth dust register`, and the daemon's `transferTokens` /
`dustRegister` / `dustDeregister` RPCs (used by both the headless CLI daemon
and the TUI).

**Registration UX** (`@shieldedtech/moth-extension`): the "Register for
DUST" flow now warns before registering a NIGHT coin that has sat
unregistered for more than a minute — the only pattern with zero known
failures across four documented occurrences is registering within seconds of
funding — and a wallet that has never registered is nudged to do so as soon
as new NIGHT is observed, rather than waiting for the user to find the Dust
screen on their own.

**Repro harness**: `packages/cli/tests/integration/daemon/dust-wedge-repro.test.ts`
isolates the fund-to-register delay as the one variable prior occurrences
didn't control for, holding UTXO size fixed at the size every known success
used (10,000,000 NIGHT).

No change to transaction construction, signing, or proving — every
registration involved in the underlying defect was accepted by the ledger,
so this only classifies what a rejection means after the fact.

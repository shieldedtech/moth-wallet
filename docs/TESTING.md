# Testing Guide

End-to-end smoke recipes for verifying every mode the moth-wallet ships. Each smoke is a copy-pasteable shell session with the exact commands, expected markers in the output, and a "what to do when it fails" section.

The recipes assume:

- The repo is checked out at `~/code/moth-wallet` and built (`yarn build`).
- A local Midnight devnet stack is running on this host (see [Prereqs](#prereqs)).
- The `moth` binary is invoked as `./packages/cli/bin/moth` from the repo root. If you have a global `moth` on `PATH` (via `npm i -g`), use that instead.

Each smoke runs in isolation and cleans up after itself. Run them in any order.

## Prereqs

### Local devnet stack

The smokes target the local `undeployed` network. Three services must be reachable:

| Service | Port | Quick check |
|---|---|---|
| midnight-indexer | 8088 | `nc -zv localhost 8088` |
| midnight-node | 9944 | `nc -zv localhost 9944` |
| proof-server | 6300 | `nc -zv localhost 6300` |

If any of these fail, bring up the stack via the `midnight-tooling:devnet` plugin or your own docker-compose. See [Why undeployed only?](#why-undeployed-only) below — the genesis-airdrop pipeline only works against the local stack; public networks need HTTP-faucet detours.

### Build state

```bash
cd ~/code/moth-wallet
yarn install                    # idempotent
yarn build                      # all 4 workspace packages
```

A clean build is mandatory. The smokes invoke `./packages/cli/bin/moth`, which loads from `packages/cli/dist/`. A stale `dist/` will mask real changes.

### Tools

- `node` >= 22 (already a hard requirement for the daemon).
- `jq` for some examples (`brew install jq` / `apt install jq`).
- `nc` for port probes.
- `npx` for the genesis airdrop (`npx -y -p midnight-wallet-cli@latest midnight airdrop …`).

---

## Smoke 1 — In-process CLI (no daemon)

Verifies the single-shot path: each command unlocks the wallet, syncs, performs the op, exits. Use this to confirm the wallet, sync, and proof pipeline work before adding the daemon's complexity.

### Setup

```bash
cd ~/code/moth-wallet
WALLET="smoke1-$(date +%s)"
NETWORK=undeployed              # smokes target the local stack
export MOTH_PASSPHRASE='smoke-test-passphrase'

./packages/cli/bin/moth wallet generate --name "$WALLET" --network "$NETWORK" -o json \
  | jq -r ".addresses.nightExternal.bech32m.$NETWORK" > /tmp/$WALLET.addr
ADDR=$(cat /tmp/$WALLET.addr)
echo "address: $ADDR"
```

**Expected**: a 73-char `mn_addr_undeployed1…` address printed (or `mn_addr_<network>1…` if you change `$NETWORK`).

> **Note**: the `addresses.nightExternal.bech32m` object returned by `wallet generate -o json` carries an entry for **every** network (mainnet, preview, preprod, qanet, devnet, undeployed). They're all encodings of the same underlying keypair — only the HRP differs. The `--network` flag controls which network the wallet's **meta** record (and therefore its sync target) is bound to, not which addresses are in the bundle. Pick the right key on the bundle via the jq path; the `$NETWORK` variable above keeps the two in sync.

### 1a — Fund + balance

```bash
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$ADDR"
./packages/cli/bin/moth balance --wallet "$WALLET" --network "$NETWORK" -o json
```

**Expected**:
- The airdrop completes in ~20s with a tx hash on stdout.
- `moth balance` (after sync) returns JSON with `balances.night.unshielded` matching the airdropped amount in STARS (1000 NIGHT = `1000000000` STARS) and `synced: true`.

**Failure modes**:
- Airdrop hangs → proof server is unreachable or genesis wallet isn't pre-funded. Re-check the stack.
- `balance` reports zero after airdrop → the wallet's sync didn't observe the airdrop block. Wait 30s and retry; if persistent, see Smoke 6.

### 1b — Register dust + transfer

```bash
# Generate a recipient
RECV="recv-$(date +%s)"
./packages/cli/bin/moth wallet generate --name "$RECV" --network undeployed -o json \
  | jq -r '.addresses.nightExternal.bech32m.undeployed' > /tmp/$RECV.addr
RECV_ADDR=$(cat /tmp/$RECV.addr)

./packages/cli/bin/moth dust register --wallet "$WALLET" --network undeployed
# Wait ~30s for dust to accrue past the per-tx fee threshold.

./packages/cli/bin/moth transfer 0.1 NIGHT --to "$RECV_ADDR" \
  --wallet "$WALLET" --network undeployed -o json
```

**Expected**: transfer returns JSON with `txId` (hex).

**Failure modes**:
- `Insufficient Funds: could not balance dust` → register hasn't accrued enough yet. Wait longer and retry. See [Spec §8 — dust accrual](spec/wallet-service/01-architecture.md#open-questions) for the underlying constraint.

### 1c — Cleanup

```bash
./packages/cli/bin/moth wallet remove "$WALLET" --yes
./packages/cli/bin/moth wallet remove "$RECV" --yes
```

Removes the keystore + sync cache. See [§Wallet lifecycle](spec/wallet-service/COMMANDS.md#wallet-lifecycle) in COMMANDS.md for what's cleaned and what isn't.

---

## Smoke 2 — TUI host (interactive)

Verifies the L3 modal flow. The TUI hosts the daemon socket while it runs, so this smoke also exercises the daemon code path — just driven from a human at the keyboard rather than from CLI subcommands.

### Setup

```bash
cd ~/code/moth-wallet
WALLET="smoke2-$(date +%s)"
export MOTH_PASSPHRASE='smoke-test-passphrase'

./packages/cli/bin/moth wallet generate --name "$WALLET" --network undeployed -o json \
  | jq -r '.addresses.nightExternal.bech32m.undeployed' > /tmp/$WALLET.addr
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$(cat /tmp/$WALLET.addr)"
```

### 2a — Launch the TUI

```bash
./packages/cli/bin/moth tui --network undeployed
```

**In the TUI**:

1. Select the wallet you just created (`smoke2-…`).
2. Unlock with the passphrase.
3. Watch the Dashboard — `Status: ● synced` should appear within ~30s.
4. From the Dashboard, press `s` to open the Send screen.
5. Generate a recipient in another shell (`moth wallet generate --name recv-tui --network undeployed`) and capture its `nightExternal.bech32m.undeployed` address.
6. Enter the recipient address, amount `0.05`, and submit.

**Expected**: a modal pops up showing `Send 0.05 NIGHT to mn_addr_undeployed1…` with the operator-facing details (Wallet, Network, Recipient, Amount). Pressing `y` approves; pressing `n` denies.

7. Approve. The Send screen should show `Submitted: <txHash>` within ~30s.

### 2b — Verify daemon hosting

While the TUI is still running, from another shell:

```bash
./packages/cli/bin/moth wallet status --wallet "$WALLET" --network undeployed -o json
```

**Expected**: structured JSON with `ready: true`, `synced: true`, balances reflecting the recent transfer. The CLI is routing through the TUI's daemon socket — no second sync started.

### 2c — Verify modal cancel

In the TUI, repeat the Send flow but press `n` at the modal. Expected: the Send screen shows an error like `Cancelled by user`. No on-chain side-effect.

### 2d — Cleanup

Quit the TUI with `M-q`. Then:

```bash
./packages/cli/bin/moth wallet remove "$WALLET" --yes
./packages/cli/bin/moth wallet remove recv-tui --yes
```

---

## Smoke 3 — Headless daemon (Unix socket)

Verifies `moth daemon serve` headless mode + daemon-mode CLI subcommands. Same RPC verbs the TUI exposes, no human in the loop.

### Setup

```bash
cd ~/code/moth-wallet
WALLET="smoke3-$(date +%s)"
export MOTH_PASSPHRASE='smoke-test-passphrase'
export MOTH_DAEMON_AUTO_APPROVE=1

./packages/cli/bin/moth wallet generate --name "$WALLET" --network undeployed -o json \
  | jq -r '.addresses.nightExternal.bech32m.undeployed' > /tmp/$WALLET.addr
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$(cat /tmp/$WALLET.addr)"
```

### 3a — Launch the daemon

In **terminal A**:

```bash
./packages/cli/bin/moth daemon serve \
  --wallet "$WALLET" \
  --network undeployed \
  --auto-approve
```

**Expected** in terminal A:

```
[daemon-serve] unlocking wallet "smoke3-…" on undeployed
[daemon-serve] starting wallet sync
[daemon-serve] waiting for wallet to report synced=true
[daemon-serve] wallet synced
[daemon-serve] listening at unix:///Users/…/moth/sync/undeployed/smoke3-….sock
[daemon-serve] PID …; SIGINT/SIGTERM to stop
```

### 3b — Drive verbs from terminal B

```bash
# Read verb — no L3 modal involved
./packages/cli/bin/moth wallet status --wallet "$WALLET" --network undeployed -o json

# Write verb — auto-approve fires
./packages/cli/bin/moth dust register \
  --wallet "$WALLET" --network undeployed
# Wait ~30s for accrual, then:

RECV="recv-d3-$(date +%s)"
./packages/cli/bin/moth wallet generate --name "$RECV" --network undeployed -o json \
  | jq -r '.addresses.nightExternal.bech32m.undeployed' > /tmp/$RECV.addr

./packages/cli/bin/moth daemon transfer \
  --wallet "$WALLET" --network undeployed \
  --to "$(cat /tmp/$RECV.addr)" --night 0.05 --type unshielded
```

**Expected** in terminal A (the daemon's stderr):

```
[daemon-serve auto-approve] Send 0.05 NIGHT to mn_addr_…
[daemon-serve auto-approve]   · Wallet: smoke3-…
[daemon-serve auto-approve]   · Network: undeployed
[daemon-serve auto-approve]   · Recipient: …
…
```

And terminal B prints the `txId`.

### 3c — Verify the audit log

```bash
tail -n 5 ~/.moth/daemon-audit.log | jq .
```

**Expected**: one JSON line per lifecycle event + each write verb you fired, with `kind`, `wallet`, `network`, `verb`, `summary`, `decision: "auto-approve"`, `txHash`. See [§06 — Audit & Observability](spec/wallet-service/06-audit-observability.md).

### 3d — Cleanup

In terminal A: `Ctrl-C` (SIGINT). The daemon writes a `shutdown-signal` audit line and exits cleanly.

```bash
./packages/cli/bin/moth wallet remove "$WALLET" --yes
./packages/cli/bin/moth wallet remove "$RECV" --yes
```

---

## Smoke 4 — Daemon over TCP with AuthN + scopes

Verifies stage-2 transport + AuthN + per-key scopes. The most concentrated smoke for the security surface.

### Setup

```bash
cd ~/code/moth-wallet
WALLET="smoke4-$(date +%s)"
export MOTH_PASSPHRASE='smoke-test-passphrase'
export MOTH_DAEMON_AUTO_APPROVE=1
rm -rf ~/.moth/api-keys                 # start fresh

./packages/cli/bin/moth wallet generate --name "$WALLET" --network undeployed -o json \
  | jq -r '.addresses.nightExternal.bech32m.undeployed' > /tmp/$WALLET.addr
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$(cat /tmp/$WALLET.addr)"
```

### 4a — Refuse to bind TCP without keys

```bash
./packages/cli/bin/moth daemon serve \
  --wallet "$WALLET" --network undeployed --auto-approve \
  --transport tcp --bind 127.0.0.1:18800
```

**Expected**: exits non-zero with `INVALID_INPUT`:

```
Refusing to bind 127.0.0.1:18800: TCP transport requires at least one
active API key. Generate one with `moth daemon key gen --label "<purpose>"` …
```

### 4b — Generate keys

```bash
# Read-only key (dashboard / observer)
./packages/cli/bin/moth daemon key gen --label "dashboard" --scopes read -o json \
  | tee /tmp/read.json | jq -r .token > /tmp/read.tok

# Full-access key (CI bot)
./packages/cli/bin/moth daemon key gen --label "ci-bot" --scopes read,write -o json \
  | tee /tmp/rw.json | jq -r .token > /tmp/rw.tok

./packages/cli/bin/moth daemon key list
```

**Expected**: list shows two active keys, columns `id label scopes status created`.

### 4c — Start the TCP daemon

In **terminal A**:

```bash
./packages/cli/bin/moth daemon serve \
  --wallet "$WALLET" --network undeployed --auto-approve \
  --transport tcp --bind 127.0.0.1:18800
```

**Expected**: `[daemon-serve] listening at tcp://127.0.0.1:18800`.

### 4d — Verify auth gate, scope enforcement, audit log

In **terminal B**:

```bash
# Unauthenticated → UNAUTHORIZED
./packages/cli/bin/moth wallet status --bind 127.0.0.1:18800
# Expected: "--bind requires --token (or MOTH_DAEMON_TOKEN). …"

# Read key + read verb → OK
MOTH_DAEMON_TOKEN=$(cat /tmp/read.tok) \
  ./packages/cli/bin/moth wallet status --bind 127.0.0.1:18800 -o json

# Read key + write verb → UNAUTHORIZED (scope)
MOTH_DAEMON_TOKEN=$(cat /tmp/read.tok) \
  ./packages/cli/bin/moth daemon dust register --bind 127.0.0.1:18800 \
    --wallet "$WALLET" --network undeployed
# Expected: 'method "dustRegister" requires the "write" scope; key <id> has [read]'

# Write key + write verb → OK
MOTH_DAEMON_TOKEN=$(cat /tmp/rw.tok) \
  ./packages/cli/bin/moth daemon dust register --bind 127.0.0.1:18800 \
    --wallet "$WALLET" --network undeployed
```

### 4e — Verify audit log carries apiKeyId + transport

```bash
tail -n 5 ~/.moth/daemon-audit.log | jq '{verb, decision, transport, apiKeyId}'
```

**Expected**: each RPC entry shows `transport: "tcp"` and an `apiKeyId` matching one of the keys you generated.

### 4f — Revoke a key, verify the next auth fails

```bash
READ_ID=$(jq -r .id /tmp/read.json)
./packages/cli/bin/moth daemon key revoke "$READ_ID"

MOTH_DAEMON_TOKEN=$(cat /tmp/read.tok) \
  ./packages/cli/bin/moth wallet status --bind 127.0.0.1:18800
# Expected: connect-style failure ("Could not reach a daemon at tcp://…
#           Likely causes: … wrong token … ").
# The daemon is up; the token's record is now revoked, so the auth
# handshake fails.
```

### 4g — Cleanup

Terminal A: `Ctrl-C`. Then:

```bash
./packages/cli/bin/moth wallet remove "$WALLET" --yes
rm -rf ~/.moth/api-keys
```

---

## Smoke 5 — Wallet lifecycle (cache cleanup)

Verifies that `wallet remove` cleans every on-disk artifact. Catches the "re-create same name silently inherits stale state" regression.

### Setup

```bash
WALLET="smoke5-$(date +%s)"
export MOTH_PASSPHRASE='smoke-test-passphrase'

./packages/cli/bin/moth wallet generate --name "$WALLET" --network undeployed -o json >/dev/null

# Spawn a daemon briefly to populate the sync cache.
MOTH_DAEMON_AUTO_APPROVE=1 ./packages/cli/bin/moth daemon serve \
  --wallet "$WALLET" --network undeployed --auto-approve --no-wait-for-sync \
  >/tmp/d.log 2>&1 &
DPID=$!
sleep 5
kill -TERM $DPID
wait $DPID 2>/dev/null
```

### 5a — Inspect on-disk state

```bash
ls -la ~/.moth/wallets/ | grep "$WALLET"          # keystore + meta both live here
ls -la ~/.moth/sync/undeployed/ | grep "$WALLET"
```

**Expected**: `<wallet>.keystore` and `<wallet>.meta` both under `wallets/`, plus a per-wallet sync cache directory under `sync/undeployed/<wallet>/` containing `shielded.dat` / `unshielded.dat` / `dust.dat`.

### 5b — Remove and re-inspect

```bash
./packages/cli/bin/moth wallet remove "$WALLET" --yes

ls -la ~/.moth/wallets/ | grep "$WALLET"          # nothing (keystore + meta both gone)
ls -la ~/.moth/sync/undeployed/ | grep "$WALLET"  # nothing
```

**Expected**: no traces. The `level-db/` and `empty-ref/` directories under `~/.moth/` may still have content — those are intentionally retained ([§Wallet lifecycle](spec/wallet-service/COMMANDS.md#wallet-lifecycle) explains why).

### 5c — Re-create with same name, confirm fresh state

```bash
./packages/cli/bin/moth wallet generate --name "$WALLET" --network undeployed -o json >/dev/null
ls -la ~/.moth/sync/undeployed/ | grep "$WALLET"  # nothing yet (no sync run)
```

**Expected**: no sync cache dir until the next daemon run. The new wallet will sync from scratch (or pre-seed from the empty-ref), not from the old wallet's state.

### 5d — Cleanup

```bash
./packages/cli/bin/moth wallet remove "$WALLET" --yes
```

---

## Smoke 6 — Failure recovery (sync resumption)

Verifies that killing the daemon mid-sync and restarting picks up from the cache rather than re-syncing from genesis.

### Setup

```bash
WALLET="smoke6-$(date +%s)"
export MOTH_PASSPHRASE='smoke-test-passphrase'
export MOTH_DAEMON_AUTO_APPROVE=1

./packages/cli/bin/moth wallet generate --name "$WALLET" --network undeployed -o json \
  | jq -r '.addresses.nightExternal.bech32m.undeployed' > /tmp/$WALLET.addr
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$(cat /tmp/$WALLET.addr)"
```

### 6a — First run: let sync complete + observe the airdrop

In **terminal A**:

```bash
./packages/cli/bin/moth daemon serve \
  --wallet "$WALLET" --network undeployed --auto-approve
```

Wait for `[daemon-serve] wallet synced`. Confirm in terminal B:

```bash
./packages/cli/bin/moth wallet status --wallet "$WALLET" --network undeployed -o json \
  | jq '{ready, synced, balances}'
```

**Expected**: `unshielded` includes the 1000 NIGHT.

### 6b — Hard-kill the daemon

In terminal A: `Ctrl-C` (SIGINT, clean) — or for a harder test, `kill -9 <pid>` (SIGKILL, no cleanup).

### 6c — Restart, watch the restore-from-cache path

In terminal A:

```bash
./packages/cli/bin/moth daemon serve \
  --wallet "$WALLET" --network undeployed --auto-approve --verbose
```

**Expected** in the daemon's stderr:

```
[sync] Starting shielded wallet...
[sync] Restoring shielded state from cache...
[sync] Starting unshielded wallet...
[sync] Restoring unshielded state from cache...
[sync] Sync state restored from cache — catching up...
```

…rather than `Syncing with network…` from scratch. The catch-up phase should complete in seconds, not the full sync time.

### 6d — Cleanup

`Ctrl-C` the daemon. Then `moth wallet remove "$WALLET" --yes`.

---

## Running the integration test suite

Beyond manual smokes, the daemon has a vitest integration suite at `packages/cli/tests/integration/daemon/`. Six test files, ~17 tests total.

### Setup

```bash
cd ~/code/moth-wallet
yarn build

# Same prereqs as the smokes — local stack on 8088/9944/6300.
# COUNTER_ARTIFACT_PATH is needed for deploy/call/maintenance tests.
# Without it, three test files skip cleanly.
export MOTH_DEVNET_URL=http://localhost:8088
export MOTH_PASSPHRASE='integration-test-passphrase'
export MOTH_DAEMON_AUTO_APPROVE=1
export COUNTER_ARTIFACT_PATH=/Users/robertblessing-hartley/code/firstperson/compiled/fpc-registry
```

### Run

```bash
yarn workspace @shieldedtech/moth-cli test tests/integration/daemon/
```

**Expected scoreboard** (as of feat/tui-daemon):

```
Test Files  6 passed (6)
     Tests  13 passed | 4 skipped (17)
```

The four skipped tests are documented in [01-architecture.md Open Q §6, §7, §8](spec/wallet-service/01-architecture.md#open-questions) — they need either contract authorship (stub artifact) or core fixes (dust maturity, witness fixtures) outside the daemon's surface.

### Diagnose failures

Each test file logs the daemon's stderr buffer on first failure. If you want to see daemon activity live during a run:

```bash
MOTH_TEST_VERBOSE_DAEMON=1 \
  yarn workspace @shieldedtech/moth-cli test tests/integration/daemon/daemon-transfer.test.ts
```

The daemon subprocess's stderr is plumbed to vitest's stderr with a `[daemon <wallet>]` prefix.

---

## Why `undeployed` only?

The smokes target the local docker stack (network id `undeployed`). Public testnets (`preview`, `preprod`) use HTTP faucets that aren't scriptable from this repo's tooling — see [memory/genesis-airdrop-scope](../.claude/projects/.../memory/genesis-airdrop-scope.md) for the full mapping. To smoke a public network, the funding step changes but every other part of the recipes works identically.

## Common diagnostic commands

When something goes wrong:

```bash
# Verify the local stack is reachable
nc -zv localhost 8088 9944 6300

# Inspect the daemon's audit log
tail -n 20 ~/.moth/daemon-audit.log | jq -c .

# List API keys + scope status
./packages/cli/bin/moth daemon key list

# See which wallets exist + which is active
./packages/cli/bin/moth wallet list

# Watch a running daemon's stderr (if you started it in the background)
tail -f /path/to/your/log/file

# Find stale daemon sockets (from crashes)
ls -la ~/.moth/sync/*/                  # *.sock files

# Force a wallet's sync to restart from genesis
rm -rf ~/.moth/sync/<network>/<wallet>/
```

## Cross-reference

- [README.md](../README.md) — Quick Start + CI Pipeline examples (less detail than this guide)
- [docs/spec/wallet-service/COMMANDS.md](spec/wallet-service/COMMANDS.md) — every CLI / TUI / RPC verb cataloged
- [docs/spec/wallet-service/01-architecture.md](spec/wallet-service/01-architecture.md) — process model and stage roadmap
- [docs/spec/wallet-service/02-authentication.md](spec/wallet-service/02-authentication.md) — API-key wire shape + storage
- [docs/spec/wallet-service/07-failure-modes.md](spec/wallet-service/07-failure-modes.md) — what happens when each component misbehaves

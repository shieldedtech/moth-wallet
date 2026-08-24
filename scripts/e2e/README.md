# End-to-end wallet harness

`moth-e2e.sh` drives a real wallet through the whole CLI surface against a live
testnet: it imports a funded wallet from its seed phrase, creates a throwaway
wallet, funds it, registers it for DUST generation, spends *from* it, and
optionally sweeps everything back. The same suite runs two ways — in-process
(`--mode cli`) and through the headless daemon (`--mode daemon`).

**It spends real testnet funds.** It refuses to run against any network whose
name contains "main".

## Setup

```bash
cp scripts/e2e/e2e.config.example.json ~/moth-e2e.config.json
chmod 600 ~/moth-e2e.config.json      # required — the script refuses a looser mode
$EDITOR ~/moth-e2e.config.json        # paste the funded wallet's phrase
```

The funded wallet needs: unshielded NIGHT, DUST already generating (it pays the
fees for the funding transfers), and — if you want those legs exercised —
shielded NIGHT and a non-NIGHT token.

Set `funding.birthdayHeight` if you know it. Without it the import uses
`--birthday-discover`, which asks the indexer for the account's first unshielded
activity; correct, but slower, and it is the difference between a pre-seeded
first sync and one that walks the chain.

## Running

```bash
# in-process commands, leave the funds where they end up
scripts/e2e/moth-e2e.sh --config ~/moth-e2e.config.json --mode cli

# through the daemon, sweeping back at the end
scripts/e2e/moth-e2e.sh --config ~/moth-e2e.config.json --mode daemon --return-funds

# both, one after the other, in separate run folders
scripts/e2e/moth-e2e.sh --config ~/moth-e2e.config.json --mode both --return-funds
```

`timeouts.syncSeconds` defaults to 5400 (90 minutes) because a funding wallet
whose birthday sits below every stored reference replays the dust stream from
genesis — 78 minutes on preprod. Check what you are in for before starting:

```bash
node scripts/e2e/probe-dust-floor.mjs preprod <the wallet's dust address>
```

If it reports no reference at or below the floor, the first phase is a genesis
walk. `--no-isolate` then pays it once instead of once per run.

Expect **30–60 minutes** per mode once the funding wallet is synced. Most of it is two unavoidable waits: the
funding wallet's first sync, and the DUST the throwaway wallet has to generate
before it can pay for its own designation.

`MOTH_BIN` overrides the entrypoint; it defaults to
`<repo>/packages/cli/bin/moth`, so build first.

## What lands in the run folder

`scripts/e2e/runs/<stamp>-<network>-<mode>/` (mode 700):

| path | what it holds |
| --- | --- |
| `run.log` | the whole run, timestamped, with the command line for every step |
| `steps.ndjson` | one record per step: name, exit code, duration, artifact paths |
| `summary.md` | the table you read afterwards, plus a failure list |
| `artifacts/NN-<step>.out/.err` | raw stdout and stderr of every command |
| `artifacts/daemon-<wallet>.log` | the daemon's own log, daemon mode only |
| `wallet-secrets.json` | **the throwaway wallet's phrase and passphrase** (600) |
| `balances-*.json` | funding and throwaway balances before and after |
| `home/` | the run's isolated `$HOME` — keystores, sync store, api-keys, audit log |

The throwaway wallet's passphrase is generated per run (18 random bytes) and
written only to `wallet-secrets.json`. Its phrase is captured from
`wallet generate --show-mnemonic` straight into a 600 file and is never echoed
to the log or the terminal.

## Isolation

Nothing in moth lets you relocate its storage — `FilesystemStorageAdapter` and
`daemonSocketPath` both key off `homedir()` with no override. So the harness
sets `HOME` to `<run>/home` for the duration. Everything the run touches lives
inside the run folder, your own `~/.moth` is never opened, and deleting the
folder deletes the run completely.

That also means the funded wallet is re-imported into each run's fresh keystore
rather than reusing one you already have, and each run re-syncs from its
birthday. `--no-isolate` uses your real `$HOME` instead, which is faster on
repeat runs but puts the throwaway wallet next to your own.

Unlike a `mktemp` HOME, the run folder is durable: it does not get swept out
from under the wallets it contains.

## Steps, in order

| phase | step | notes |
| --- | --- | --- |
| 0 | `--version`, `info` | `info` is critical — it proves the indexer answers |
| 0 | `preseed install` | seeds the isolated `$HOME` from the repo's packaged bundle; skipped with `--no-isolate` |
| 1 | import funded wallet, `wallet list`, `wallet status`, `preseed status`, `wallet address` | phrase goes in on stdin |
| 1 | balance + `dust status` on the funded wallet | asserts it has NIGHT and DUST |
| 2 | `wallet generate`, `export-phrase`, `export-phrase --seed-hex` | asserts the export round-trips the generated phrase (#59) |
| 2 | `wallet use` then a bare `wallet address` | the active-wallet path (#60) |
| 2 | `dust register` on the empty wallet | **must refuse** (#58) |
| 3 | unshielded transfer → wait for arrival | |
| 3 | shielded transfer → wait for arrival | skipped when `fundShieldedNight` is 0 |
| 3 | token transfer via `--token-id --amount`, then the positional form | the positional form **must refuse** for a non-NIGHT token (#62) |
| 4 | `dust register --wait` on the throwaway wallet | the long one; asserts `status=registered` |
| 4 | wait for its DUST to appear, then `dust status` | |
| 5 | transfer back to the funder | the real test: the throwaway wallet pays its own DUST fee |
| 5 | `transfer batch` with two entries | CLI only — the daemon takes one transfer per call |
| 5 | `transfer batch` with amount `"1,5"` | **must refuse**, and today does not — see below |
| 6 | sweep unshielded, shielded and token balances back; `dust deregister` | only with `--return-funds` |
| 7 | `wallet remove`, final balances, `summary.md` | `--keep-wallet` skips the removal |

Steps whose whole point is a refusal are run through `run_step_expect_fail`, so
a non-zero exit is the pass and an unexpected success is the failure.

## Pre-seed and birthdays

An isolated `$HOME` starts with no reference, so the harness installs the
repository's packaged one before importing anything. The gate is
`reference height <= birthday`: the throwaway wallet is born at the current tip
and pre-seeds, while a funded wallet older than the packaged reference still
walks the chain from its birthday. That is the shape of the feature, not a fault
in the run — but it is why the first phase can take a while, and why setting
`funding.birthdayHeight` is worth it.

## The malformed-amount probe fails today

`executeBatchTransfer` parsed amounts with `parseFloat` and
`Math.round(x * 1_000_000)`, so a batch entry of `"1,5"` was read as **1 NIGHT**
and `"0.0000001"` rounded to a **zero-value transfer that still paid a fee** —
the two failure modes #63 fixed for `moth transfer`, still live in the batch
path. Filed as **#66** and fixed by pointing the batch path at the shared
`parseNightAmount`, with the file also checked up front so a typo on entry 3 no
longer surfaces after two transfers have gone out. The probe passes once that
lands.

It sends its NIGHT to the *funding* address, so while the bug is present the
money goes back where it came from. It is skipped when the throwaway wallet
holds under 1 NIGHT, because an insufficient-funds failure would look like a
refusal and prove nothing.

### And a second one, in the same file

`batchExitCode` returned the two failure codes the wrong way round — 1 when
every entry failed, 2 when only some did — against both its own docstring and
the README table. A caller treating 2 as "nothing went out, safe to re-send the
file" would re-send a batch whose successful entries were already on chain.
Filed as **#67**, fixed alongside #66, and now covered by tests; nothing had
ever tested it, and the prose describing it was correct, so only running a
partial batch revealed it.

## Balances, and why the daemon reads them differently

In `--mode cli` balances come from `moth balance --output json`. In
`--mode daemon` they come from the daemon's own `getState` over the socket, via
`daemon-state.mjs`, which emits the same JSON shape so one set of `jq` paths
reads both.

That helper exists because **there is no `moth daemon state` command**: the verb
is implemented and reachable over the socket, but nothing in the CLI calls it.
Running `moth balance` while a daemon holds the same wallet would start a second
sync over the same store, which is what the helper avoids.

## Daemon mode specifics

- Keystore operations — `wallet generate`, `import`, `address`, `export-phrase`,
  `remove` — have no daemon verb and always run in-process, in both modes.
- `transfer batch` has no daemon verb either; the daemon takes a single transfer
  per call, so the batch leg is skipped rather than faked.
- The daemon is started per wallet with `--auto-approve`,
  `MOTH_DAEMON_AUTO_APPROVE=1`, `--idle-timeout 0` (no auto-lock mid-run) and a
  `--max-spend` cap computed as twice the largest configured leg, so the
  harness's own transfers pass while the cap stays real.
- `--wait-for-sync` means the socket appears only once the wallet is synced;
  the harness waits for the socket, so that wait is the sync wait.
- Daemons are killed on exit, including on Ctrl-C.

## Notes on secrets

The funded wallet's phrase stays in your config file and is passed to
`wallet import` on stdin as a here-string, which keeps it out of the process
list — `printf … | moth` would expose it to anyone running `ps`. Bash may back
that here-string with a short-lived temp file at mode 600. The phrase is never
copied into the run folder.

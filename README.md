<p align="center">
  <img src="brand/logo.png" alt="" width="200">
</p>

# Moth

An isomorphic wallet tool for the Midnight Network. Provides single-command wallet operations across three runtime contexts: non-interactive CLI, browser library, and interactive terminal dashboard.

Built for DApp developers, CI pipelines, and developing AI coding agents.

## Status: Experimental and Unsupported

Moth is an experimental wallet built for internal testing. It is published as-is, for reference and evaluation only.

**It is not supported.** We do not maintain it, fix bugs, patch security issues or respond to support requests or vulnerability reports. It may be incomplete, insecure or stop working at any time.

**It has not been audited.** Moth handles cryptographic keys and interacts with the Midnight network. Using it may result in the permanent and irreversible loss of assets. You use it entirely at your own risk.

**No warranty.** This software is provided "as is," without warranty of any kind. This notice is in addition to  and does not replace the terms of the Apache License 2.0 under which Moth is released (see L1ICENSE), including its
warranty disclaimer and limitation of liability.

## Architecture

```
packages/
  core/      Isomorphic engine — zero platform-specific imports
  browser/   Browser adapter (IndexedDB, Web Crypto)
  tui/       Interactive terminal dashboard (React/Ink)
  cli/       Non-interactive CLI commands (oclif)
```

The `core` package contains all wallet logic: HD key derivation, encrypted keystores, network clients, proof orchestration, and transaction building. The `browser`, `tui`, and `cli` packages are thin shells that provide platform-specific I/O adapters around the shared core.

## First Sync and the Pre-Seed Reference

A brand-new account is not usable the instant you create it. The DUST sub-wallet has to reconstruct generation state by streaming the ledger events that produced it, and on a chain with real history that takes a while — not because your wallet has any transactions, but because DUST generation is global chain state that has to be replayed to be known.

This is a property of where zero-knowledge chains currently are, not a defect in Midnight or in Moth, and the protocol's own roadmap addresses it further later this year. What follows is how Moth makes the wait tolerable in the meantime.

Most of that replay is identical for every wallet, so it does not need doing more than once. A **pre-seed reference** is an unfunded throwaway wallet's synced state, captured at a known block height. A new account starts from that height instead of from genesis. On preprod this is the difference between roughly 78 minutes and roughly 29 seconds.

The reference holds nothing and controls nothing, so it is safe to distribute — it is a snapshot of public chain state, not of anyone's funds. Its *mnemonic*, by contrast, is never published; see [`docs/adr/0003-preseed-reference.md`](docs/adr/0003-preseed-reference.md).

Two things constrain when it is used:

- It is applied **only to wallets that provably cannot have had activity before the reference height** — a wallet created after the reference was built. A wallet restored from a seed phrase has no such guarantee and takes the full walk, because starting it mid-history would hide its own funds from it.
- Each sub-wallet carries an independent cursor, so DUST can start at the reference height while shielded and unshielded resume from their own caches.

Builds bundle a reference for preprod. Other networks sync from genesis until one is built.

Building and refreshing is two steps: warm a reference by syncing an unfunded wallet to tip, then package it into the extension. The warm is the slow part — it is the chain walk itself, so budget tens of minutes to an hour depending on the network.

```bash
# 1. Warm: sync an unfunded wallet to tip and write the reference to ~/.moth
node scripts/sync-benchmark.mjs --warm-reference --network preprod --timeout 9000

# 2. Package: copy it into packages/extension/public/preseed/<network>/
node scripts/export-preseed.mjs --network preprod

# Report age and size without writing anything
node scripts/export-preseed.mjs --check
```

A stale reference costs catch-up time, not correctness — the wallet syncs forward from the reference height — so one cut at release time stays useful for as long as the release does. Roughly half a second of catch-up per hour of age, measured on preprod. Refresh it when cutting a release rather than on a schedule; `--check` reports the age it would ship.

There is no CI job that refreshes it, so this is a manual step in the release process. See [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md) for what the warm actually does and the sharp edges around it, and [ADR 0004](docs/adr/0004-preseed-distribution.md) for why the reference is distributed in the package rather than fetched.

## Prerequisites

- **Node.js 22+**
- **Yarn 4.14+** (ships via Corepack: `corepack enable`)
- **Midnight devnet** — a running local network or access to preview/preprod
- **Proof server** — running on port 6300 (required for transactions)
- **Compact CLI** (`compact compile`) — for compiling contracts before deployment
- **Node heap**: The `bin/moth` wrapper sets `--max-old-space-size=8192` (8 GB) to handle wallet genesis scans that can exceed 4 GB

## Build from Source

```bash
git clone <repo-url>
cd moth-wallet
yarn install
yarn build
```

This builds all four packages. The `core` package builds first, then `cli`, `browser`, and `tui` in parallel (managed by Turborepo).

## Run Tests

```bash
yarn test
```

Tests cover security-critical modules: HD key derivation (BIP-44 path `m/44'/2400'`), ChaCha20-Poly1305 keystore encryption/decryption, BIP-39 mnemonic handling, and contract artifact loading.

For end-to-end verification of every mode (in-process CLI, TUI host, daemon Unix, daemon TCP + AuthN + scopes, wallet lifecycle, failure recovery), see [`docs/TESTING.md`](docs/TESTING.md). It includes the integration-test invocation, the local-stack prereqs, and per-mode smoke recipes with expected output markers.

## Install the Browser Extension

The extension is not on the Chrome Web Store. Build it and load it unpacked.

```bash
yarn workspace @shieldedtech/moth-extension build          # -> packages/extension/.output/chrome-mv3
yarn workspace @shieldedtech/moth-extension build:firefox  # -> packages/extension/.output/firefox-mv2
```

In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `packages/extension/.output/chrome-mv3`. After a rebuild, press the reload icon on the extension's card — Chrome does not pick up a new build on its own.

In Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the `manifest.json` inside `packages/extension/.output/firefox-mv2`. Temporary add-ons are removed when Firefox restarts.

To hand a build to someone else, `yarn workspace @shieldedtech/moth-extension zip` writes a store-shaped archive to `.output/`. They still load it unpacked, so they will need to unzip it first.

A fresh install creates its wallet on preprod, not mainnet. That is deliberate — see [Status](#status-experimental-and-unsupported) — and you can change it in Settings once you understand what you are changing it to.

The extension has a developer page that the UI does not link to: open `chrome-extension://<extension-id>/debug.html`, taking the ID from the extension's card on `chrome://extensions`. It reports phase timings and per-host request counts with outcomes, which is the first place to look when something is slow or an endpoint is refusing you.

## Interactive Dashboard (TUI)

`moth tui` launches the terminal dashboard. It is also the daemon host: while it runs, `moth daemon …` subcommands route to it, and every write operation raises a confirmation modal in it.

| Key | Action |
|-----|--------|
| `M-m` (Alt+M) | Toggle navigation menu |
| `1`-`9` | Navigate to screen (when menu is open) |
| `M-p` (Alt+P) | Pause/resume wallet sync |
| `M-q` (Alt+Q) | Quit |
| `Esc` | Back/cancel within screens |

Screens: 1 Dashboard, 2 Send, 3 Deploy, 4 Mint, 5 Contract, 6 Keys, 7 DUST, 8 Network, 9 Logs

## Install the CLI

After building from source:

```bash
# Option 1: Run directly via node
node packages/cli/dist/index.js --help

# Option 2: Create a shell alias
echo 'alias moth="node /path/to/moth-wallet/packages/cli/dist/index.js"' >> ~/.zshrc
source ~/.zshrc

# Option 3: npm global link (use npm, not yarn, for global installs)
cd packages/cli
npm link

# Verify
moth --help
```

Or install directly from npm (when published):

```bash
npm install -g @shieldedtech/moth-cli
```

## Interactive Prompting

All commands prompt for missing required inputs when running in a terminal. You never need to memorize the exact flags — just run the command and Moth will ask for what it needs. Passphrase input is masked with `*` characters (hidden input, not echoed). Before each operation, the CLI prints `Using wallet: <name>` to stderr so you know which wallet is active.

```bash
$ moth deploy
Using wallet: dev
Path to compiled contract artifact: ./managed/counter
Passphrase: ********
Syncing wallet before deploy...
Deploying to devnet...

$ moth wallet import
New passphrase: ********
Recovery phrase (24 words): abandon abandon abandon ...
```

In CI/automation (non-TTY), missing inputs fail with a clear error and non-zero exit code. Use flags and environment variables for scripting:

```bash
MOTH_PASSPHRASE=secret moth deploy ./managed/counter --project-dir . --output json
echo "word1 word2 ..." | MOTH_PASSPHRASE=secret moth wallet import --name ci-wallet
```

## Quick Start

### 0. Launch the Daemon

Pick one — both work, both expose the same RPC verbs over the same socket:

```bash
# Interactive: TUI dashboard hosts the daemon while it's running. Modal
# confirmations appear for every write op.
moth tui

# Headless: long-running daemon process. No UI. Auto-approves every L3
# modal — only use this for trusted automation (CI, service accounts).
MOTH_PASSPHRASE='…' MOTH_DAEMON_AUTO_APPROVE=1 \
  moth daemon serve --wallet dev --network undeployed --auto-approve
```

The daemon listens at `~/.moth/sync/<network>/<wallet>.sock`. With the daemon running, subsequent `moth daemon …` invocations connect to it instead of starting their own sync.

You can skip step 0 and use the in-process commands (`moth transfer`, `moth deploy`, etc.) for one-shot work — they spin up an ephemeral sync each time.

### 1. Create a Wallet

```bash
moth wallet generate --name dev
```

Prompts for a passphrase (or reads `MOTH_PASSPHRASE` env var in CI). Generates a BIP-39 24-word mnemonic, derives HD keys for all five Midnight roles, and encrypts the wallet to `~/.moth/`.

### 2. Fund the Wallet (local devnet only)

`moth airdrop` is a placeholder. For a local devnet stack (`undeployed`), fund from genesis via the `midnight-wallet-cli` npm package:

```bash
ADDR=$(moth wallet list -o json | jq -r '.[] | select(.name=="dev") | .addresses.nightExternal.bech32m.undeployed')
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$ADDR"
```

For `preview` / `preprod` use the HTTP faucet at `https://faucet.<network>.midnight.network/`. `mainnet` has no faucet.

### 3. Check Balance

```bash
# In-process — spins up its own sync, prints balances, exits.
# First call is slow (full sync); subsequent calls use the on-disk cache.
moth balance
moth balance -o json

# Daemon-mode — instant, reads from the daemon's warm snapshot.
# Requires a daemon (TUI or `moth daemon serve`).
moth wallet status

# DUST-specific generation status:
moth dust status
```

### 4. Deploy a Contract

```bash
# Compile first (outputs to managed/ directory)
compact compile my-contract.compact

# Daemon mode (recommended — reuses warm sync, triggers L3 confirmation):
moth daemon deploy ./managed/my-contract \
  --witnesses ./src/witnesses.js \
  --project-dir .

# In-process mode (one-shot, spins up its own sync):
moth deploy ./managed/my-contract --project-dir .
moth deploy ./managed/my-contract --project-dir . --witnesses ./src/witnesses.js

# JSON output for scripting:
moth daemon deploy ./managed/my-contract --project-dir . -o json | jq '.contractAddress'
```

The `--project-dir` flag (or `MOTH_PROJECT_DIR` env var) tells Moth where your contract project lives, so it can resolve `@midnight-ntwrk/*` SDK dependencies from that project's `node_modules/`. If omitted, Moth guesses two directories above the artifact path.

### 5. Call a Circuit

```bash
# Daemon mode — same per-op confirmation flow as transfer/deploy:
moth daemon call increment \
  --address <contract-addr> \
  --artifact ./managed/my-contract \
  --witnesses ./src/witnesses.js \
  --project-dir .

moth daemon call transfer \
  --address <addr> \
  --args '{"to": "...", "amount": 100}' \
  --artifact ./managed/my-contract --project-dir .

# In-process variant (omit `daemon` from the subcommand path):
moth call increment --address <contract-addr>
moth call transfer --address <addr> --args @args.json
```

### 6. Query Contract State

```bash
moth state <contract-address>
moth state <contract-address> --output json
```

### 7. Maintenance Updates

Some contracts are too large to deploy in a single transaction — the total verifier-key payload exceeds the per-tx block weight cap and the deploy fails with `exceeded block limit in transaction fee computation`. Midnight's maintenance authority lets you split the deploy across multiple transactions:

1. **Deploy a stub** of the contract with `export` stripped from non-essential circuits — same ledger declarations, smaller operations table.
2. **Insert each remaining verifier key** with a maintenance update, signed by the maintenance authority that was set at deploy time.

The signing key is stored in moth's private state at deploy, so subsequent `moth maintenance insert-vk` calls find it automatically — no extra configuration.

```bash
# After deploying the stub at <addr>, insert one circuit per maintenance tx:
moth maintenance insert-vk \
  --network preprod \
  --address <addr> \
  --circuit-id initializeToken \
  --vk-file ./compiled-full/keys/initializeToken.verifier \
  --artifact ./compiled-full \
  --project-dir "$PWD"

# Bulk: insert every .verifier in the FULL compile in one command. The
# wallet syncs once at the start and submits one tx per circuit; the
# command exits with status 2 on first hard failure (so you can resume
# with --skip-existing).
ADDR=<contract-address>
export MOTH_PASSPHRASE='...'   # set once for the whole batch

moth maintenance insert-vks-batch \
  --network preprod \
  --address "$ADDR" \
  --artifact compiled-full/ \
  --project-dir "$PWD" \
  --skip-existing \
  --yes

# Or pass a subset:
moth maintenance insert-vks-batch \
  --network preprod --address "$ADDR" --artifact compiled-full/ \
  --circuits initializeToken,mint,burnCustodial \
  --project-dir "$PWD" --skip-existing --yes
```

Each maintenance update is one transaction (Level 1 batching: the command shares one wallet sync across many submits, but each circuit is still its own tx because the maintenance authority counter is monotonic). Plan for ~3–5 minutes wall time per tx for proving + finalisation; for 20 circuits expect ~20-30 min total instead of the ~70-90 min you'd get running `insert-vk` once per circuit. The contract address is fixed by the initial deploy and does not change as circuits are added.

## CLI Reference

### Global Flags

Every command accepts:

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output` | `-o` | `text` | Output format: `text` or `json` |
| `--network` | `-n` | `devnet` | Target network |
| `--wallet` | `-w` | active | Wallet name |
| `--verbose` | `-v` | off | Debug output to stderr |
| `--timeout` | `-t` | varies | Operation timeout (seconds) |
| `--proof-server` | | config | Proof server URL override |
| `--indexer` | | config | Indexer GraphQL URL override (env: `MOTH_INDEXER_URL`) |
| `--node-url` | | config | Node URL override (env: `MOTH_NODE_URL`) |

### Wallet Management

| Command | Description |
|---------|-------------|
| `moth wallet generate [--name <name>]` | Create new wallet from random mnemonic |
| `moth wallet import [--name <name>]` | Import from recovery phrase (stdin or interactive) or `--seed-hex` |
| `moth wallet list` | List all wallets |
| `moth wallet address --name <name>` | Print a wallet's receive addresses (NIGHT, DUST, shielded) for every network. Offline — unlocks the keystore, no sync |
| `moth wallet use [<name>]` | Switch active wallet (prompts if name omitted) |
| `moth wallet remove [<name>] [--yes]` | Delete a wallet (prompts for name and confirmation) |

### Token Operations

| Command | Description |
|---------|-------------|
| `moth balance` | Show NIGHT (shielded + unshielded) + DUST + non-NIGHT token balances. In-process — spins up its own sync. |
| `moth wallet status` | Same info but via the daemon's warm snapshot (instant). Requires TUI or `moth daemon serve`. |
| `moth transfer [<amount>] [NIGHT] [--to <addr>]` | Transfer NIGHT (prompts for missing details) |
| `moth transfer <amount> NIGHT --to <addr> --shielded` | Shielded transfer |
| `moth transfer batch <file.json>` | Batch transfer from JSON file (`@stdin` for pipe). Exit: 0 all ok, 1 partial, 2 all failed |

### Contract Operations

| Command | Description |
|---------|-------------|
| `moth deploy [<artifact-path>] [--project-dir <dir>] [--witnesses <file>]` | Deploy a contract; syncs wallet first. `--project-dir` (or `MOTH_PROJECT_DIR`) sets SDK dep resolution root. Artifact path accepts a `managed/` directory from `compact compile` output. |
| `moth call [<circuit>] [--address <addr>] [--args <json>]` | Call a circuit (prompts for missing details) |
| `moth state [<address>]` | Query public ledger state (prompts for address) |
| `moth mint [<amount>] [--address <addr>]` | Mint fungible tokens (prompts for missing details) |
| `moth maintenance insert-vk --address <addr> --circuit-id <name> --vk-file <path> --artifact <dir>` | Insert a verifier key for a circuit on an already-deployed contract. Signed by the contract's maintenance authority (signing key read from moth's private state). Use to stage-deploy contracts that exceed the per-tx block weight cap. |
| `moth maintenance insert-vks-batch --address <addr> --artifact <dir> [--circuits a,b,c] [--skip-existing]` | Insert many verifier keys in one command (Level 1 batching: shared wallet sync, one tx per VK). Default iterates every `.verifier` in `<artifact>/keys/`. `--skip-existing` queries the chain first and omits already-defined circuits, making the command resumable. |

### DUST Management

| Command | Description |
|---------|-------------|
| `moth dust register` | Register for DUST generation |
| `moth dust deregister` | Deregister from DUST |
| `moth dust status` | Show generation status, rate, capacity |

### Utility

| Command | Description |
|---------|-------------|
| `moth info` | Network and node status |
| `moth airdrop` | **Stub** — does not move funds. On the local `undeployed` stack, fund from genesis via `npx midnight-wallet-cli midnight airdrop <amt> --wallet <bech32m>` (see [§2. Fund the Wallet](#2-fund-the-wallet-local-devnet-only)) |
| `moth config get/set/unset <key> [<value>]` | Read, write, or clear a `~/.moth/config.json` key |
| `moth tui` | Launch interactive dashboard |

> For the exhaustive reference — including every `moth daemon …` subcommand (serve, transfer, call, deploy, submit-tx, dust, key gen/list/revoke, maintenance) and the full on-disk lifecycle — see [`docs/spec/wallet-service/COMMANDS.md`](docs/spec/wallet-service/COMMANDS.md).

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Failure (wallet error, network error, invalid input) |
| 2 | Partial failure (batch operations: some succeeded, some failed) |
| 3 | Timeout |

### Error Output

JSON mode errors:

```json
{
  "error": {
    "category": "NETWORK_ERROR",
    "message": "Could not connect to node at ws://localhost:9944",
    "code": 1
  }
}
```

Text mode errors go to stderr with hints:

```
Error [NETWORK_ERROR]: Could not connect to node at ws://localhost:9944
  Hint: Is your devnet running? Check your local network setup
```

## Daemon Model

Moth runs in two modes:

1. **In-process** — every CLI invocation (e.g. `moth transfer …`, `moth deploy …`) unlocks the wallet, starts its own sync, performs the operation, and exits. Simple, single-shot, but two simultaneous invocations against the same wallet race on the sync cache.

2. **Daemon-hosted** — one long-lived process (the TUI dashboard, or `moth daemon serve` headless) owns the wallet, keeps its sync warm, and exposes write operations over a Unix domain socket. CLI subcommands under `moth daemon …` (e.g. `moth daemon transfer`, `moth daemon deploy`) route through that socket instead of starting their own sync. This is the recommended pattern for any workflow that does more than one tx — the sync warm-up is paid once.

The daemon's RPC verbs are: `getState`, `clearSyncCache`, `submitTransaction`, `transferTokens`, `callCircuit`, `deployContract`, `dustRegister`, `dustDeregister`, `insertVerifierKey`, `insertVerifierKeysBatch`. Each write verb triggers an L3 confirmation modal in the TUI (or auto-approves under two-flag arming in headless mode — see **L3** under Security layers).

**Security layers**:

- **L1** (kernel UID enforcement): the socket lives at `~/.moth/sync/<network>/<wallet>.sock`, mode `0600` in a `0700` directory. Only the daemon's UID can connect.
- **L3** (per-operation human consent): every write verb produces a modal in the TUI showing the operation summary, recipient/contract, amounts. The op only proceeds on explicit approval. Headless mode replaces this with auto-approve, gated by *both* `--auto-approve` AND `MOTH_DAEMON_AUTO_APPROVE=1` — belt-and-suspenders so a stray flag in shell history doesn't disable consent on a service account.

The living spec at [`docs/spec/wallet-service/`](docs/spec/wallet-service/) describes the four-stage roadmap from this local-only model (stage 1) to a multi-tenant network-accessible service (stage 4): authentication, policy, audit, threat model, key management decisions.

## CI Pipeline Example

Two patterns. Pick based on how many ops the job runs.

### Single-op (in-process is simplest)

```bash
#!/bin/bash
set -e
export MOTH_PASSPHRASE="ci-ephemeral-$(date +%s)"

moth wallet generate --name ci-test --network undeployed -o json
ADDR=$(moth wallet list -o json | jq -r '.[]|select(.name=="ci-test")|.addresses.nightExternal.bech32m.undeployed')
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$ADDR"

DEPLOY=$(moth deploy ./managed/counter --project-dir . -o json)
CONTRACT=$(echo "$DEPLOY" | jq -r '.contractAddress')
moth state "$CONTRACT" -o json

moth wallet remove ci-test --yes
```

### Multi-op (daemon amortizes sync warm-up)

```bash
#!/bin/bash
set -e
export MOTH_PASSPHRASE="ci-ephemeral-$(date +%s)"
export MOTH_DAEMON_AUTO_APPROVE=1

# Generate + fund + register dust
moth wallet generate --name ci-test --network undeployed -o json
ADDR=$(moth wallet list -o json | jq -r '.[]|select(.name=="ci-test")|.addresses.nightExternal.bech32m.undeployed')
npx -y -p midnight-wallet-cli@latest midnight airdrop 1000 --wallet "$ADDR"

# Start the daemon in the background and let it sync
moth daemon serve --wallet ci-test --network undeployed --auto-approve &
DAEMON_PID=$!
trap 'kill -TERM $DAEMON_PID 2>/dev/null; moth wallet remove ci-test --yes' EXIT

# Wait for daemon to be ready (poll wallet status until ready=true)
until moth wallet status --wallet ci-test --network undeployed -o json | jq -e '.ready'; do sleep 2; done
moth daemon dust register --wallet ci-test --network undeployed

# Now run as many write ops as the job needs — each reuses the warm sync.
DEPLOY=$(moth daemon deploy ./managed/counter --project-dir . -o json)
CONTRACT=$(echo "$DEPLOY" | jq -r '.contractAddress')
moth daemon call increment --address "$CONTRACT" --artifact ./managed/counter --project-dir . -o json
moth state "$CONTRACT" -o json
```

## AI Agent Example

Agents interact via sequential commands with `--output json`:

```
> moth wallet generate --name test --output json
{"name":"test","address":"0x...","network":"devnet"}

> moth deploy ./managed/counter --project-dir . --output json
{"contractAddress":"0x...","txHash":"0x...","status":"SUCCESS"}

> moth call increment --address 0x... --output json
{"txHash":"0x...","status":"SUCCESS"}

> moth state 0x... --output json
{"address":"0x...","state":"...","lastUpdated":{"blockHeight":42}}
```

## Using the Browser Library

```typescript
import { createMothBrowser } from '@shieldedtech/moth-browser';

// Configure with custom endpoints
const moth = createMothBrowser({
  indexerUrl: 'https://indexer.preview.midnight.network',
  network: 'preview',
});

// Generate a wallet
const info = await moth.wallets.generate('my-wallet', 'passphrase');
console.log(info.addresses.nightExternal.bech32m.preview);

// Query contract state
const state = await moth.indexer.getContractAction('0x...');

// Or use individual components with custom URLs
import { IndexerClient, ProofClient } from '@shieldedtech/moth-browser';
const indexer = new IndexerClient('https://my-indexer.example.com');
const prover = new ProofClient('http://localhost:6300');
```

## Network Configuration

| Network | Node | Indexer | Proof Server |
|---------|------|--------|--------------|
| devnet | `ws://localhost:9944` | `http://localhost:8088` | `http://localhost:6300` |
| preview | `https://rpc.preview.midnight.network` | `https://indexer.preview.midnight.network/api/v4/graphql` | `http://localhost:6300` |
| preprod | `https://rpc.preprod.midnight.network` | `https://indexer.preprod.midnight.network/api/v4/graphql` | `http://localhost:6300` |
| qanet | `https://rpc.qanet.dev.midnight.network` | `https://indexer.qanet.dev.midnight.network/api/v4/graphql` | `http://localhost:6300` |

Default network is `devnet`. Endpoints can be overridden at multiple levels (highest precedence first):

**1. CLI flags** (per-command):
```bash
moth info --indexer https://my-indexer.example.com
moth deploy ./managed/counter --project-dir . --proof-server http://my-prover:6300
moth transfer 1 NIGHT --to <addr> --node-url wss://my-node:9944
```

**2. Environment variables**:
```bash
export MOTH_INDEXER_URL=https://indexer.preview.midnight.network/api/v4/graphql
export MOTH_NODE_URL=https://rpc.preview.midnight.network
export MOTH_PROOF_SERVER_URL=http://localhost:6300
moth info  # uses env vars
```

**3. `.env` file** (loaded automatically from working directory):
```bash
# .env
MOTH_INDEXER_URL=https://indexer.preview.midnight.network/api/v4/graphql
MOTH_NODE_URL=https://rpc.preview.midnight.network
```

**4. Persistent config** (saved to `~/.moth/`):
```bash
moth config set indexer-url https://indexer.preview.midnight.network/api/v4/graphql
moth config set node-url https://rpc.preview.midnight.network
moth config set default-network preview
```

**5. Network defaults** (built-in, see table above)

See `.env.example` for a template.

## Security Model

- **Encrypted keystores**: ChaCha20-Poly1305 with scrypt KDF. Wallet files at `~/.moth/` with `0600` permissions.
- **No keys in CLI arguments**: Passphrases via interactive prompt or `MOTH_PASSPHRASE` env var. Mnemonics via stdin pipe (never env var — SR-001).
- **Memory zeroing**: Derived keys are wiped from memory when `wallet.lock()` is called. The `UnlockedWallet` object zeroes all key material on lock.
- **Sanitized logging**: `--verbose` output is filtered to redact hex keys, mnemonics, and passphrase assignments before writing to stderr.
- **File locking**: Concurrent access to wallet files uses advisory locking with stale lock detection (30s timeout).
- **HD derivation**: BIP-44 path `m/44'/2400'/{account}'/{role}/{index}` with five Midnight roles matching the official wallet SDK.

## Project Structure

```
packages/
  core/
    src/
      wallet/       HD derivation, keystore, mnemonic, manager, balance
      network/      JSON-RPC node client, GraphQL indexer client
      transaction/  Transaction builder (deploy, call, transfer, mint, DUST)
      proof/        Proof server HTTP client (/prove, /check, /health)
      providers/    Custom providers bridging SDK interfaces
      sync/         Background sync engine with genesis reset detection
      contract/     Artifact loader, witness loader, args parser, state query
      storage/      StorageAdapter interface
      types/        Shared types, error hierarchy, exit codes
    tests/
      unit/         HD derivation, keystore, mnemonic, artifact loader
  cli/
    src/
      commands/     18 oclif commands
      adapters/     Filesystem storage, passphrase prompting
      formatters/   Text table + JSON output
  browser/
    src/
      adapters/     IndexedDB storage, Web Crypto passphrase
  tui/
    src/
      screens/      Dashboard
      app.tsx        Ink app shell
```

## Development

```bash
# Build all packages
yarn build

# Run tests
yarn test

# Build a single package
yarn workspace @shieldedtech/moth-wallet build

# Run tests for a single package
yarn workspace @shieldedtech/moth-wallet test
```

The project uses Turborepo for build orchestration. The `core` package always builds first since `cli`, `browser`, and `tui` depend on it.

## Acknowledgements

The TUI component draws on architectural patterns and screen designs from [mn-tui](https://github.com/input-output-hk/arc-mn-tui) (Apache-2.0), a terminal wallet manager for Midnight developed by Input Output Global. See [NOTICE](NOTICE) for full attribution details.

Particular thanks to [@bwbush](https://github.com/bwbush) — Brian W. Bush — for the initial terminal UI and the thinking behind it. The TUI is the surface most of this project's early debugging happened through.

Moth was built by a number of people before it was opened up, and the squash that created this repository credits none of them. [CONTRIBUTORS.md](CONTRIBUTORS.md) is the record of who wrote it.

## License

See [LICENSE](LICENSE).

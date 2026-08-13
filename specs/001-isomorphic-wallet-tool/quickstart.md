> ⚠️ **This spec is superseded.** It predates the wallet daemon work
> landed on `feat/tui-daemon`. The current architecture lives at
> [`docs/spec/wallet-service/`](../../docs/spec/wallet-service/) and
> the operational reference at
> [`docs/spec/wallet-service/COMMANDS.md`](../../docs/spec/wallet-service/COMMANDS.md).
> Treat this file as historical context, not current truth.
# Quickstart: Moth

## Prerequisites

- Node.js 22+
- Yarn 4.14+ (via Corepack: `corepack enable`)
- A running Midnight devnet (Docker or local)
- A running proof server on port 6300

## Install

```bash
# From npm (when published)
npm install -g @moth/cli

# Or from source
git clone <repo-url> && cd secure-wallet
yarn install
yarn build
cd packages/cli && npm link  # makes 'moth' command available
```

## First Use

```bash
# 1. Generate a wallet (prompts for passphrase)
moth wallet generate --name dev

# 2. Check your wallet was created
moth wallet list

# 3. Request test tokens on devnet
moth airdrop

# 4. Check your balance
moth balance
```

## Deploy a Contract

```bash
# Compile a Compact contract (outputs to managed/ directory)
compact compile my-contract.compact

# Deploy to devnet — pass the managed/ directory and project root
moth deploy ./managed/my-contract --project-dir .

# Deploy with witnesses
moth deploy ./managed/my-contract --project-dir . --witnesses ./src/witnesses.js

# Deploy with JSON output for scripting
moth deploy ./managed/my-contract --project-dir . --output json | jq '.contractAddress'
```

The `--project-dir` flag (or `MOTH_PROJECT_DIR` env var) tells Moth where to
find your project's `node_modules/` for SDK dependency resolution. If omitted,
Moth defaults to two directories above the artifact path.

## Call a Circuit

```bash
# Call with inline JSON arguments
moth call increment --address <contract-addr>

# Call with arguments
moth call transfer --address <addr> --args '{"to": "...", "amount": 100}'

# Call with arguments from file
moth call transfer --address <addr> --args @args.json
```

## Transfer Tokens

```bash
# Transfer NIGHT
moth transfer 100 NIGHT --to <recipient-address>

# Shielded transfer
moth transfer 100 NIGHT --to <recipient-address> --shielded

# Batch transfer from file (exit: 0=all ok, 1=partial, 2=all failed)
moth transfer batch transfers.json

# Batch transfer from stdin
cat transfers.json | moth transfer batch @stdin -y
```

Batch file format (`transfers.json`):
```json
[
  { "to": "mn_addr_...", "amount": "100" },
  { "to": "mn_addr_...", "amount": "50", "shielded": true }
]
```

## DUST Management

```bash
# Register for DUST generation
moth dust register

# Check DUST status
moth dust status

# Deregister
moth dust deregister
```

## Query Contract State

```bash
moth state <contract-address>
moth state <contract-address> --output json
```

## CI Pipeline Example

```bash
#!/bin/bash
set -e

# Generate ephemeral wallet (passphrase from env)
export MOTH_PASSPHRASE="ci-ephemeral-$(date +%s)"
WALLET=$(moth wallet generate --name ci-test --output json)
ADDRESS=$(echo "$WALLET" | jq -r '.address')

# Fund the wallet
moth airdrop

# Wait for DUST
moth dust register
sleep 30  # allow DUST to accrue
moth dust status --output json

# Deploy contract
DEPLOY=$(moth deploy ./managed/counter --project-dir . --output json)
CONTRACT=$(echo "$DEPLOY" | jq -r '.contractAddress')

# Call circuit and verify
RESULT=$(moth call increment --address "$CONTRACT" --output json)
echo "Transaction: $(echo "$RESULT" | jq -r '.txHash')"

# Check state
moth state "$CONTRACT" --output json

# Cleanup
moth wallet remove ci-test --yes
```

## AI Agent Example

An AI agent can use the tool via sequential commands with JSON output:

```text
Agent: moth wallet generate --name test --output json
  → {"name":"test","address":"0x..."}

Agent: moth airdrop --output json
  → {"balance":"1000000","token":"NIGHT"}

Agent: moth deploy ./managed/counter --project-dir . --output json
  → {"contractAddress":"0x...","txHash":"0x..."}

Agent: moth call increment --address 0x... --output json
  → {"txHash":"0x...","status":"SUCCESS"}

Agent: moth state 0x... --output json
  → {"address":"0x...","state":{"counter":1}}
```

## Network Configuration

```bash
# Use a specific network
moth balance --network preview

# Use custom node URL
moth info --network devnet \
  --node-url ws://custom-node:9944

# Set default network
moth config set default-network preview
```

## Interactive Dashboard

```bash
# Launch TUI
moth tui

# Or just run without subcommand
moth
```

## Troubleshooting

**"Proof server not reachable"**: Start the proof server or specify a custom URL:
```bash
moth deploy ./managed/contract --project-dir . --proof-server http://localhost:6300
```

**"Insufficient DUST"**: Register for DUST and wait for accrual:
```bash
moth dust register
moth dust status  # check currentCapacity
```

**"Network timeout"**: Check that your devnet is running:
```bash
moth info  # shows connection status
```

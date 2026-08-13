> ⚠️ **This spec is superseded.** It predates the wallet daemon work
> landed on `feat/tui-daemon`. The current architecture lives at
> [`docs/spec/wallet-service/`](../../docs/spec/wallet-service/) and
> the operational reference at
> [`docs/spec/wallet-service/COMMANDS.md`](../../docs/spec/wallet-service/COMMANDS.md).
> Treat this file as historical context, not current truth.
# CLI Command Interface Contract

**Date**: 2026-05-01

## Global Flags

All commands accept these flags:

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--output` | `-o` | `text\|json` | `text` | Output format |
| `--network` | `-n` | `string` | `devnet` | Target network |
| `--wallet` | `-w` | `string` | active wallet | Wallet name |
| `--verbose` | `-v` | `boolean` | `false` | Debug output to stderr |
| `--timeout` | `-t` | `number` | per-command | Operation timeout in seconds |
| `--proof-server` | | `URL` | from network config | Proof server URL override |
| `--help` | `-h` | | | Show help |
| `--version` | | | | Show version |

## Commands

### `wallet generate`

Generate a new wallet from a random BIP-39 mnemonic.

```text
moth wallet generate [--name <name>]
```

| Output Field | Type | Description |
|-------------|------|-------------|
| name | string | Wallet name (auto-generated if not provided) |
| address | string | Primary unshielded address |

**Exit codes**: 0 success, 1 name conflict, 1 passphrase error

---

### `wallet import`

Import a wallet from an existing mnemonic or hex seed.

```text
moth wallet import [--name <name>] [--seed-hex]
```

Mnemonic or hex seed is read from stdin (piped) or interactive prompt — never
from CLI arguments or environment variables (SR-001, CWE-200).

- **Mnemonic**: `echo "$MNEMONIC" | moth wallet import --name ci-wallet`
- **Hex seed**: `echo "$SEED" | moth wallet import --seed-hex --name ci-wallet`
- **Interactive**: `moth wallet import` prompts for recovery phrase or hex seed

---

### `wallet list`

List all configured wallets.

```text
moth wallet list
```

| Output Field | Type | Description |
|-------------|------|-------------|
| wallets[] | array | Wallet name, address, active status, network |

---

### `wallet use <name>`

Switch active wallet.

```text
moth wallet use <name>
```

---

### `wallet remove <name>`

Remove a wallet (requires confirmation or `--yes`).

```text
moth wallet remove <name> [--yes]
```

---

### `balance`

Display wallet balances.

```text
moth balance
```

| Output Field | Type | Description |
|-------------|------|-------------|
| night | string | NIGHT balance (in STAR) |
| dust | string | DUST balance (in SPECK) |
| address | string | Wallet address |

**Exit codes**: 0 success, 1 wallet not found, 1 network error

---

### `transfer`

Transfer NIGHT tokens.

```text
moth transfer <amount> [NIGHT] --to <address> [--shielded]
```

| Output Field | Type | Description |
|-------------|------|-------------|
| txHash | string | Transaction hash |
| status | string | Finalized status |
| fees | object | Paid and estimated fees |

**Timeout default**: 30 seconds
**Exit codes**: 0 success, 1 insufficient funds, 1 network error, 1 timeout

---

### `transfer batch`

Batch transfer from a JSON file.

```text
moth transfer batch <file.json|@stdin>
```

File format:
```json
[
  { "to": "<address>", "amount": "100", "token": "NIGHT" },
  { "to": "<address>", "amount": "50", "token": "NIGHT", "shielded": true }
]
```

**Exit codes**: 0 all succeeded, 1 all failed, 2 partial failure

---

### `dust register`

Register wallet for DUST generation.

```text
moth dust register
```

---

### `dust deregister`

Deregister wallet from DUST generation.

```text
moth dust deregister
```

---

### `dust status`

Show DUST generation status.

```text
moth dust status
```

| Output Field | Type | Description |
|-------------|------|-------------|
| registered | boolean | Registration status |
| dustAddress | string | DUST address |
| nightBalance | string | Backing NIGHT balance |
| generationRate | string | Rate in SPECK/second |
| maxCapacity | string | Maximum DUST capacity |
| currentCapacity | string | Current generated DUST |

---

### `deploy`

Deploy a compiled Compact contract. The wallet is synced before deployment
to ensure transaction balancing works correctly.

```text
moth deploy <artifact-path> [--project-dir <dir>] [--witnesses <file.js>] [--name <label>] [--yes]
```

The `<artifact-path>` accepts a `managed/` directory from `compact compile`
output. Moth looks for `contract/index.js` inside that directory.

The `--project-dir` flag (env: `MOTH_PROJECT_DIR`) specifies the contract
project root so Moth can resolve `@midnight-ntwrk/*` SDK dependencies from
its `node_modules/`. The resolved path is prepended to `NODE_PATH`. If
omitted, Moth defaults to two directories above the artifact path.

| Output Field | Type | Description |
|-------------|------|-------------|
| contractAddress | string | Deployed contract address |
| txHash | string | Transaction hash |
| fees | object | Transaction fees |

**Timeout default**: 120 seconds
**Exit codes**: 0 success, 1 proof server unavailable, 1 insufficient DUST,
1 compilation error, 1 timeout

---

### `call`

Call a circuit on a deployed contract.

```text
moth call <circuit-name> --address <contract-addr> [--args '<json>'|--args @file.json]
```

| Output Field | Type | Description |
|-------------|------|-------------|
| txHash | string | Transaction hash |
| status | string | Transaction result status |
| result | object | Return values (if any) |
| fees | object | Transaction fees |

**Timeout default**: 30 seconds

---

### `state`

Query public ledger state of a deployed contract.

```text
moth state <contract-address>
```

| Output Field | Type | Description |
|-------------|------|-------------|
| address | string | Contract address |
| state | object | Decoded public ledger state |
| lastUpdated | object | Block hash and height of last update |

---

### `mint`

Mint fungible tokens on a deployed contract.

```text
moth mint <amount> --address <contract-addr> [--token-type <hex>]
```

---

### `info`

Show network and node information.

```text
moth info
```

| Output Field | Type | Description |
|-------------|------|-------------|
| network | string | Active network |
| nodeUrl | string | Node WebSocket URL |
| indexerUrl | string | Indexer GraphQL URL |
| proofServerUrl | string | Proof server URL |
| blockHeight | number | Current block height |
| syncStatus | string | Wallet sync status |

---

### `airdrop`

Request test tokens on development networks.

```text
moth airdrop [--amount <amount>]
```

Only available on devnet. Fails with clear error on other networks.

---

### `tui`

Launch interactive terminal dashboard.

```text
moth tui
moth  (no subcommand — same as tui)
```

## Error Output Contract

All errors follow this structure in JSON mode:

```json
{
  "error": {
    "category": "NETWORK_ERROR|WALLET_ERROR|PROOF_ERROR|TIMEOUT|INVALID_INPUT",
    "message": "Human-readable description",
    "code": 1
  }
}
```

In text mode, errors are written to stderr:

```text
Error [NETWORK_ERROR]: Could not connect to node at ws://localhost:9944
  Hint: Is your devnet running? Check your local network setup
```

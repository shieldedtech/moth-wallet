# @shieldedtech/moth-cli

The `moth` command-line tool — single-command wallet operations for the
[Midnight Network](https://midnight.network): wallet management, token transfers, contract
deploy/call, and DUST operations. Built for DApp developers, CI pipelines, and AI coding agents.

Part of [Moth](https://github.com/shieldedtech/moth-wallet).

> **Experimental — use at your own risk.** This is unaudited software provided AS-IS with no
> warranty, for development and testing only. Do not use it with real funds on mainnet.

## Install

```bash
npm install -g @shieldedtech/moth-cli
moth --help
```

Or run without installing:

```bash
npx @shieldedtech/moth-cli --help
```

## Usage

Every command prompts for missing required inputs in a terminal, and accepts flags/env vars for
scripting. Global flags include `--network/-n` (default `devnet`), `--wallet/-w`, `--output/-o`
(`text` or `json`), and `--verbose/-v`.

Transaction commands accept `--prover server|wasm` (or `MOTH_PROVER`). Server
mode uses `--proof-server <url>`; WASM mode proves locally.

```bash
# Create and fund a wallet
moth wallet generate --name dev
moth airdrop

# Check balances
moth balance

# Deploy a compiled contract and call a circuit
moth deploy ./managed/counter --project-dir .
moth call increment --address <contract-addr>

# Launch the interactive terminal dashboard
moth tui
```

## Commands

| Group | Commands |
| --- | --- |
| Wallet | `wallet generate`, `wallet import`, `wallet list`, `wallet use`, `wallet remove` |
| Tokens | `balance`, `transfer [amount]`, `transfer batch <file>`, `airdrop` |
| Contracts | `deploy`, `call`, `state`, `mint`, `maintenance insert-vk`, `maintenance insert-vks-batch` |
| DUST | `dust register`, `dust deregister`, `dust status` |
| Utility | `info`, `config get/set`, `tui` |

## Documentation

See the [project README](https://github.com/shieldedtech/moth-wallet#readme) for the full CLI
reference (every flag, exit codes, network configuration, and CI/agent examples).

## License

Apache-2.0 — see [LICENSE](https://github.com/shieldedtech/moth-wallet/blob/main/LICENSE).

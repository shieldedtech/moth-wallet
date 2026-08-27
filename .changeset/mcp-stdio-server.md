---
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-wallet': minor
---

Expose the wallet to AI agents as an MCP server: `moth mcp`.

Agents could only reach the wallet by shelling out to CLI subcommands and
parsing `-o json` — workable, but every operation paid a full process spawn,
a fresh unlock, and its own sync. `moth mcp` serves the wallet over the Model
Context Protocol instead: one long-lived process, typed tools, warm sync.

Two transports. stdio (default) is for clients that spawn and own the server
process. `--transport http --bind 127.0.0.1:<port>` is for operators who run
the server themselves: it binds the MCP Streamable HTTP endpoint at
`http://<bind>/mcp`, serves any number of concurrent client sessions against
the one unlocked wallet, and refuses non-loopback binds (the transport is
unencrypted and unauthenticated — kernel-local trust only, with DNS-rebinding
protection on the Host header). Stdio-only clients bridge to it with
`npx -y mcp-remote <url> --allow-http`, which also keeps the passphrase out
of client configs entirely.

The command is a fourth shell over the same core, not a new wallet surface.
Write verbs route through `buildWalletHandlers` — the exact handler bodies the
daemon and TUI use — so the max-spend cap, auto-approve records, and
`~/.moth/daemon-audit.log` behave identically. Read tools (`wallet_status`,
`wallet_balances`, `wallet_addresses`, `wallet_activity`, `wallet_list`,
`wait_for_sync`) are always served. Spend tools (`transfer_tokens`,
`estimate_transfer_fee`, `dust_register`, `dust_deregister`) follow the
daemon's headless consent policy: `--auto-approve` AND
`MOTH_DAEMON_AUTO_APPROVE=1` AND a mandatory `--max-spend <NIGHT>` cap, or
they are not registered at all.

Two constraints shape the design. In stdio mode stdout is the JSON-RPC
channel, so the command reroutes every other stdout writer to stderr before
the wallet engine starts, and `MOTH_PASSPHRASE` is required in both modes
because stdin cannot host a prompt. And a first sync can take minutes while
MCP clients expect a handshake in seconds — so the transport connects
immediately after unlock, sync runs in the background, and agents call
`wait_for_sync` as an explicit barrier (`everSynced` latches; the raw
`synced` flag flip-flops as new blocks arrive).

All amounts cross the interface as decimal strings in smallest units, per the
daemon wire convention, and every tool's text block carries the full JSON
payload alongside the summary — some MCP clients surface only text to the
model, and data living solely in `structuredContent` is invisible there.
`wallet_addresses` also serves the wallet's zswap public identity
(`shieldedKeys.coinPublicKey` / `.encryptionPublicKey`), which dApp endpoints
need to build shielded outputs to the wallet.
Transfer recipients are validated beyond bech32m well-formedness: the address
kind must match the transfer type (unshielded → `mn_addr_…`, shielded →
`mn_shield-addr_…`) and the embedded network tag must match the wallet's
network, since a cross-network send loses the funds. The server exits and
locks the wallet on SIGINT, SIGTERM, or — in stdio mode — client disconnect
(stdin EOF; the MCP SDK's transport does not watch for it, so the command
does).

MCP client configuration:

```json
{
  "command": "moth",
  "args": ["mcp", "--wallet", "<name>", "--network", "<net>"],
  "env": { "MOTH_PASSPHRASE": "..." }
}
```

One more escalation exists behind its own flag: `--allow-balancing` registers
`balance_transaction` and `submit_transaction` for the dApp-connector flow —
a site's endpoint generates a payment transaction, the wallet balances it
(pays fees, adds inputs/outputs), proves it when the input is unproven (the
common dApp shape: dApps cannot prove; `stage: 'sealed' | 'unsealed' |
'unproven'` selects the input), signs, and by default submits it, so an agent
can pay for access and use the token the site returns. `submit_transaction`
covers the remaining case of a fully-built FinalizedTransaction that only
needs sending. Both tools take the transaction inline as hex (`txHex`) or as
a file path read on the server host (`txFile`, holding hex text or the raw
bytes) — serialized transactions with proofs run to hundreds of KB, too
large to shuttle through an agent's context as a tool argument when a dApp
writes them to disk. This required a new core daemon verb, `balanceTransaction`
(the existing connector operation, extended with the unproven stage via the
facade's `balanceUnprovenTransaction`), which the TUI and `daemon serve`
hosts now also serve with the usual L3 modal. Both tools are separately armed
because `--max-spend` cannot protect them: the value inside externally-built
transaction bytes is opaque to the wallet, which funds whatever the
transaction needs — the flag is refused without the full spend gate
underneath, and the modal/audit details state the cap does not apply.

This does not add contract deploy/call or verifier-key maintenance tools —
those daemon verbs exist and can be attached later; the surface starts with
balances, transfers, and balancing.

---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-tui': minor
---

The bundled moth-ft token issuer, and the receive-unshielded test fixture, now come in two builds:
the compactc 0.31.1 one they had (a ledger-8 contract) and a compactc 0.36.0 one (a ledger-9 contract).
midnight-js 5 refuses to deploy a ledger-8 contract after the v9 fork, and attaches to a deployed
contract only through the build whose verifier keys it holds, so moth picks one per operation.

- `deployFungibleToken` deploys the build for the era of the network's latest block, the reading
  midnight-js checks a deploy against. Token deploys from the CLI and TUI keep working after the fork.
- `mintFungibleToken` reads the contract's state and mints through the build whose verifier keys it
  holds: the ledger-8 build for a token deployed before the fork, on either side of it, and the
  ledger-9 build for one deployed after. An address that holds neither build's keys is refused with a
  message saying so.
- A ledger-9 build runs with a proof server (9.0.0 or later), as any ledger-9 contract does, since
  its circuits are ZKIR v3.
- The package now ships moth-ft (both builds, about 16.7 MB packed). It shipped only `dist` before,
  so `deployFungibleToken` and `mintFungibleToken` found no artifact outside this repository.
- Core depends on `@midnight-ntwrk/compact-runtime` 0.21.0, shared with midnight-js, and on 0.16.0
  under the alias `compact-runtime-ledger8`, the name midnight-js gives its own ledger-8 copy. The
  ledger-8 modules import the alias, so each build resolves its own runtime in any install.
- `FUNGIBLE_TOKEN_ARTIFACT_DIR` is removed. `bundledContractBuild(name, era)`,
  `bundledContractForDeploy(name, network)` and `bundledContractForAddress(name, address, network)`
  give a bundled contract's build directory, and the build an operation should take.

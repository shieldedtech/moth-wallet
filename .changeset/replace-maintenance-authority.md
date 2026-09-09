---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-cli': minor
---

Replace, renounce, and read a contract's maintenance authority.

`packages/core/src/contract/maintenance.ts` claimed to cover "replace maintenance
authority" in its header and only ever inserted verifier keys. Nothing in moth
could change who holds the authority, which mattered more than it looked: nothing
in moth could *show* it either, so the most consequential fact about a deployed
contract — who can rewrite its circuits — was invisible from the CLI.

What a deploy leaves behind is worth stating plainly. `deployContract` samples a
fresh signing key per deployment and stores it in the private-state provider under
the contract's address, so every contract moth deploys starts under a 1-of-1
authority whose key nobody chose and nothing published. Losing
`~/.moth/level-db/...` freezes that contract's circuit set permanently; copying it
hands over the ability to replace `contribute`, `reveal`, or any other circuit,
silently.

Three commands:

- `moth maintenance show-authority` — committee, threshold, counter, and whether
  the authority is renounced. No wallet and no keys, because it is the check a
  consumer runs before trusting an instance.
- `moth maintenance replace-authority` — install a committee with a threshold
  above one. Takes the committee as inline JSON or `@file.json` (a bare array, or
  an object with `committee` and `threshold`, so a project's published parameters
  can be passed straight in), and the current authority's signing keys as
  repeatable `--signer` values, each `index:key` or `@file.json`.
- `moth maintenance renounce-authority` — install an authority nothing can
  satisfy, freezing the circuit set. Irreversible, and the confirmation says so.

The SDK's `submitReplaceAuthorityTx` could not do this: it swaps one signing key
for one other, since `replaceContractMaintenanceAuthority` takes an
`Option<SigningKey>`, and midnight-js carries the TODO. So `replaceAuthority`
builds the `MaintenanceUpdate` from ledger types, signs it with a threshold of the
current authority, and submits it as an intent carrying nothing else. The ledger
types are resolved from `@midnight-ntwrk/midnight-js-protocol/ledger` rather than
this package's own `ledger-v8` import, because they must be the same WASM instance
the SDK's `submitTx` handles — the same trap that produces `expected instance of
ChargedState` on the call path.

Every refusal happens before anything is signed or submitted: a threshold above
the committee size (named as the renounce configuration rather than rejected
blankly), a duplicate committee key, an empty committee without `renounce`, a
signer whose key is not the one on chain at the index it claims, and too few
signers for the current threshold. Seven unit tests cover the guards.

Two operational consequences, both surfaced in command output rather than left to
be discovered. Insert every verifier key *before* handing a contract to a
committee: `insert-vk` signs with one locally stored key and a committee-held
contract will refuse it. And after a successful replacement the local signing key
is dropped unless it alone still suffices, so `insert-vk` fails at the keyboard
instead of at the chain.

Not done: the daemon and TUI surfaces, and committee-signed verifier key inserts.

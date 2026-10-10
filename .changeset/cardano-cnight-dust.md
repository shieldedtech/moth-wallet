---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-tui': minor
---

Register cNIGHT on Cardano for DUST generation, from all four surfaces.

DUST can be generated from NIGHT held on Midnight or from cNIGHT held on
Cardano. moth only did the first. The second needs a Cardano transaction that
maps a Cardano stake key to a Midnight DUST address, so it needed Cardano
keys, the `cnight_generates_dust` Plutus validator and a chain provider — none
of which the wallet had.

Core gains a `@shieldedtech/moth-wallet/cardano` subpath with register,
deregister and change-receiver, reachable as `moth cardano …`, `moth daemon
cardano …`, the TUI's `a` screen and a Cardano screen in the extension.

Cardano keys come from the account's existing recovery phrase via CIP-1852, so
there is no Cardano account to create and nothing new to back up — every surface
now says so where the address is shown, because "where do I create one?" is the
first thing the absence of a create button suggests.

The Cardano address is shown before anything is configured, since funding it is
the first step and derivation needs no Blockfrost key. The extension reaches
Cardano from the home screen rather than only from Settings, and truncates
addresses with a copy button rather than laying a 103-character bech32 string
into a label/value row.

Multiple Cardano accounts, in the extension. "Add account" takes the next
CIP-1852 index of the wallet's own phrase — its own address, its own stake key
and so its own independent DUST registration, with nothing new to back up.
Indices come from a persisted high-water mark, never recomputed from the list,
so removing an account cannot hand its address and registration to the next one
created. "Import" adds a Cardano-only account from a separate phrase, encrypted
under the wallet passphrase; that phrase is NOT covered by the moth recovery
phrase, which the import screen says before asking for it. Accounts imported from a raw hex seed have no
Cardano address at all — BIP-39's phrase-to-seed step is one-way, and CIP-1852
starts from the entropy — and every surface says so by name rather than failing
at derivation.

The Cardano network is derived from the Midnight network — mainnet/Mainnet,
preprod/Preprod, preview/Preview — and cannot be chosen separately. devnet,
qanet and undeployed have no counterpart and refuse rather than falling back to
a testnet. Letting the two be picked independently had exactly one outcome in
practice: cNIGHT registered on Cardano Preview against a Midnight preprod
wallet, valid on Cardano, invisible to Midnight, and silent for the twelve
hours you spend waiting for DUST that cannot arrive.

cNIGHT amounts are STARs, six decimal places, as NIGHT is on Midnight. Cardano
carries no protocol-level decimals and the asset publishes no registry entry,
so nothing on chain states the scale and a block explorer shows the raw
integer. Both the display and the send inputs now apply it: `--cnight 10` used
to move ten STARs — a hundred-thousandth of what was asked for — and succeed.

Reads and submission go through Blockfrost, which needs a project id — one per
network, since a project id is issued for a single network and answers 403 on
the others. Every
surface can set one: `moth config set blockfrost-project-id`, the TUI's Network
screen under Cardano, the extension's Cardano settings, or
`MOTH_BLOCKFROST_PROJECT_ID`. The CLI, TUI and daemon share one store, so
setting it once covers all three; the extension keeps its own. Without a project
id, address derivation still works and everything else refuses with that reason.

The ID is masked wherever it is shown back — `config get`, `config set` output,
and the TUI's input field — because it is a credential and those all end up in
terminal scrollback or CI logs.

Sending ADA and cNIGHT, on every surface: `moth cardano send`, `moth daemon
cardano send`, the TUI's `s` flow and a Send screen in the extension. The
destination is checked against the session's own network id before anything is
built — a well-formed mainnet address entered on a testnet is the mistake that
actually loses funds, and the builder would otherwise accept it. Sending cNIGHT
from a registered account warns first, because the cNIGHT that leaves stops
generating DUST and the rest is rotated.

Cardano account management reached the CLI and TUI too: `moth cardano account
list|add|import|use|remove`, a `--account` flag on every `moth cardano` command,
and an accounts view on the TUI's Cardano screen with a two-step masked import.

DUST on the Cardano side is finality-bound: Midnight will not act on a
registration until Cardano finalises it, about 12 hours (k=2160 blocks at ~20s).
Native NIGHT registration takes minutes, so the two flows feel very different
and the wallet used to claim the fast one for both. The Cardano screen now
counts down from the registration transaction's own block time — read from the
chain, so it survives a reinstall and is right for a registration made from the
dApp or the CLI — and says what the wait is for.

Registering also offers your Midnight accounts as DUST receivers instead of only
taking 66 hex characters by hand. The DUST address is read out of each account,
so locked accounts are offered too — the account holding the cNIGHT is usually
not the one being paid.

The extension can show its DUST address again: Receive gained a DUST tab and the
DUST screen shows the address with a copy button. Neither had it, while the TUI
showed it on the keys screen all along. It is not a "receive" address — nothing
can send you DUST — but it is what you hand to another wallet or a Cardano
registration to point generation at yourself.

Also fixes `moth dust status`, which passed the wallet's Midnight address to an
indexer query keyed by Cardano *reward* address and so reported "not registered"
for every wallet, registered or not.

moth registers against the `cnight_generates_dust` deployment the Midnight
bridge actually reads: script hash 7e69087d…, the contract the node repo ships
as `mapping_validator.plutus`. It previously used the compilation in the dApp's
`contracts-new-aiken/plutus.json` (5027bb76…), which is newer, compiles
cleanly, and is not deployed. Registrations against it confirmed on Cardano and
generated nothing — the bridge has never acknowledged one, and there is no
error anywhere to read. 51 registrations live at the deployed address; moth's
three transactions are the only ones that have ever touched the other.

`scripts/sync-cnight-blueprint.mjs` now pins that hash and refuses to emit
bytes that do not match it, reads either a `.plutus` envelope or an Aiken
blueprint, and takes `--verify-on-chain` to confirm the derived address holds
real registrations. The hash is pinned in the tests too, as a literal. The
check that was there before compared the compiled bytes to a hash generated
from the same file: self-consistent by construction, and green throughout.

The registration datum records the 33 bytes `DustAddress.serialize()` returns —
a 0x73 type tag then the payload — matching every live registration and the
deployed validator's own `length_of_bytearray(dust_address) <= 33`. The other
plausible receiver, the 32-byte shielded coin public key, encodes just as
cleanly and is a different key: Cardano accepts it and the bridge matches
nothing.

Registrations written against the coin public key still exist on chain, so the
datum is read back with a range rather than a fixed length. Pinning the reader
would not reject such a registration, it would hide it: the datum stops
decoding, the wallet reports "not registered", and registering again mints a
second auth NFT onto a stake key that already has one, which the validator
rejects. A registration that cannot generate DUST is labelled as such in all
four surfaces, with `update` offered to repoint it.

The extension also reported a wallet's own registration as belonging to someone
else. It compared the datum against the session's shielded coin public key,
which the datum has not held since the receiver became a DUST address — same
length, different key, so the comparison failed silently rather than loudly.
It now resolves the wallet's own DUST address through the same path the
registration writes it. The CLI, TUI and daemon derived this through
`dustAddressBytes` and were unaffected.

Changing the DUST address no longer adds a zero withdrawal. The validator
authorises a key-based stake credential by signature; the withdrawal route is
for script credentials, and its redeemer is an output reference rather than the
unit value, so including one aborted the transaction.

The extension's Cardano provider now implements CIP-30 in full: `getExtensions`,
`getUtxos(amount, paginate)` with amount filtering, `getCollateral({ amount })`
reading `cbor<Coin>`, pagination on `getUsedAddresses`, and `enable(extensions)`.
Errors reach dApps in the shapes the spec fixes — numeric `APIError` codes,
`PaginateError { maxSize }`, and the per-method decline codes — where previously
every CIP-30 failure arrived as `[object Object]` with its detail dropped.

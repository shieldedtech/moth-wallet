---
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-wallet': minor
---

**The extension can restore an account from a raw hex seed.** Previously it
accepted a 24-word phrase and nothing else, which made accounts created from a
seed permanently unreachable there.

That was not a policy — a wallet created from a hex seed **has no mnemonic and
can never be given one**, because BIP-39's phrase-to-seed step is a one-way KDF.
There was nothing to type into the word grid. Meanwhile the TUI
(`tui/src/app.tsx`) and the CLI (`moth wallet import --seed-hex`) both had the
path, and the extension's own session model is seed-based end to end: it derives
`seedHex` at unlock and carries it through every operation. A mnemonic was only
ever a transport format for the seed, and the extension accepted just that one
format at the door.

The plumbing was the only thing missing. `wallets` in the browser facade *is* a
`WalletManager`, so `importFromSeed` was already callable from the offscreen
document; `unlock` already handled a `seed:` keystore. `ImportWalletRequest` is
now a union — exactly one of `mnemonic` / `seed`, enforced by the type rather
than a runtime check — threaded through the background/offscreen RPC, and the
offscreen host routes to whichever core call fits. The two stay separate calls,
not one with a branch: `import` runs the BIP-39 checksum, `importFromSeed`
shape-checks the hex.

The restore screen now offers both artifacts as tabs on one page. No
"which do you have?" step first: anyone restoring already knows which they hold,
so that step would cost a click and gather nothing.

**New in core: `wallet/hex-seed.ts`, and `importFromSeed` now validates.** It had
no validation whatsoever — a malformed seed reached the SDK and surfaced as a
bare `Invalid seed`, and a merely wrong-*length* seed was accepted outright,
silently producing a different wallet. `checkHexSeed` returns a machine-readable
problem so each surface can word it itself (the extension localises it; the CLI
and TUI use `describeHexSeedProblem`). The TUI and CLI inherit the fix.

**The validation is shaped around the fact that a hex seed has no checksum.**
Measured against the wallet SDK, `HDWallet.fromSeed` accepts any 16–64 byte
seed and refuses 15 or 65 — and every accepted length derives a *different*
wallet. So:

- change one character and there is **no error**, just a different, valid, empty
  wallet;
- truncate a paste and the same is true;
- whereas one wrong word in a phrase fails `validateMnemonic`.

The bounds therefore match what the SDK actually accepts rather than a rule of
our own, with a test that fails if an SDK bump moves them. Lengths other than 32
or 64 bytes — the two sizes real tooling emits — are **warned about, not
refused**: a truncated paste looks exactly like a seed genuinely created at that
length, and refusing would lock such a wallet out. And the field is deliberately
**not** a password input: reading the seed back against a backup is the only
check available, so masking it would remove the sole defence.

Note those two sizes are not interchangeable. A 32-byte seed is what the Midnight
node toolkit and `moth wallet import --seed-hex` deal in; the 64-byte one is the
BIP-39 seed a phrase expands to, and what `exportSeedHex` returns for a
phrase-backed wallet. Truncating the latter to the former gives a different
wallet.

Restored accounts keep `createdHere: false` and no birthday, so they scan from
genesis — they may hold funds at any height, and seeding one past its own history
would hide them (ADR 0003, rule 4).

Also corrected: three places documented a BIP-39 seed as 64 hex characters. It is
128 — 64 hex characters is a 32-byte seed, a different artifact that derives a
different wallet. `core/src/sync/operations.ts` and two spots in
`docs/spec/wallet-service/05-key-management.md`. That claim is precisely what
would lead someone to write `length === 64` validation and reject the seeds this
app exports (#99).

Closes #98.

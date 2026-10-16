# proof-server (vendored)

A copy of `proof-server/` from [midnight-ledger](https://github.com/midnightntwrk/midnight-ledger) at tag `ledger-8.1.3`, Apache-2.0, © Midnight Foundation.

It is vendored because the crate's request handlers are `pub(crate)` and its server binds to every interface. The mobile app needs it on loopback only. Changes from upstream:

- `src/lib.rs`: binds `127.0.0.1` instead of `0.0.0.0`, and exposes `configure` so Moth can call the endpoints in-process, without a socket.
- `Cargo.toml`: the ledger crates come from the `ledger-8.1.3` git tag instead of workspace paths, and the dev-dependencies are removed.

The other source files are unchanged from the tag. When moving to a new ledger release, copy `proof-server/` from that tag and reapply these two changes.

# proof-server (vendored)

A copy of `proof-server/` from [midnight-ledger](https://github.com/midnightntwrk/midnight-ledger) at tag `ledger-8.1.3`, Apache-2.0, © Midnight Foundation.

It is vendored because the crate's request handlers are `pub(crate)` and its server binds to every interface. The mobile app needs it on loopback only. Changes from upstream:

- `src/lib.rs`: binds `127.0.0.1` instead of `0.0.0.0`, and exposes `configure` so Moth can call the endpoints in-process, without a socket.
- `src/lib.rs`: replaces `Cors::permissive()` with an origin allowlist that `server` takes as an argument (`ENGINE_ORIGIN`, `moth://engine`, for the app). A request whose `Origin` is not on the list is refused with 400 before any handler runs; requests with no `Origin` are served. Upstream's permissive CORS let any page in the DApp browser that could reach loopback read and call the prover.
- `src/main.rs`: an `--allow-origin` flag (env `MIDNIGHT_PROOF_SERVER_ALLOW_ORIGINS`) feeds that list; it defaults to `moth://engine`.
- `Cargo.toml`: the ledger crates come from the `ledger-8.1.3` git tag instead of workspace paths, and the dev-dependencies are removed.

The other source files are unchanged from the tag. When moving to a new ledger release, copy `proof-server/` from that tag and reapply these changes.

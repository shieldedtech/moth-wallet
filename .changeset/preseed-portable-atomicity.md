---
'@shieldedtech/moth-wallet': patch
---

Require all three parts of a pre-seed reference, and drop `node:zlib` from core.

Two findings from review on the CLI/TUI parity work.

**A missing part was as damaging as a corrupt one.** Both `exportReference` and
`importReference` checked only dust, so a bundle without shielded state imported
the other two over an existing reference and moved the height key with them. The
store was left holding shielded at the old height and the rest at the new one — a
mixture that never existed on chain, reported as ready by
`loadUsableRefStates` because the height key still looked consistent, and that
inflated height then feeding the `emptyRef.height <= birthday` guard, seeding
wallets whose birthday fell between the two. Both functions now require every
part: export returns null, import refuses and names each missing file.

**`node:zlib` had no business in core.** Nothing in the browser or extension
packages imported `preseed-portable` yet, but it is re-exported from core's
barrel — and that barrel reaches 36 Node builtins where the browser package's
walked graph reaches none, so one careless import would have carried zlib into
every dependent DApp bundle. Compression now goes through `CompressionStream` and
`DecompressionStream`, which Node 18+ and every current browser provide, so the
module is genuinely isomorphic rather than allow-listed as an exception. Gzip
level is not selectable through that API, so bundles written here compress
slightly less than `scripts/export-preseed.mjs` does at level 9; sizes are
recorded in the manifest either way, and decompression is level-agnostic.

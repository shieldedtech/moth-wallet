# Wallet Service Spec — Changelog

Date-stamped notes on changes to any spec section. PRs touching this doc should add an entry here.

## 2026-06-21

- **Accepted** D-KM-3 (derive-and-drop). `WalletManager.unlock` derives the typed `WalletKeys` bundle and immediately drops the raw `seedHex` string; the `UnlockedWallet` interface no longer exposes a `seedHex` getter or a `clearSeed()` method. `startWalletSync`, `preSeedNewWallet`, `executeBatchTransfer` all migrated to accept `WalletKeys` directly. 10 CLI commands + the TUI's `useBalance` / `useWallet` / `useDaemonHost` migrated alongside.
- Marked the staged implementation plan: we are at stage 1 (D-KM-3 shipped). Stage 2+ still gated on architecture / auth / policy / approval-pipeline sections being accepted.
- Closed open question #1 (`UnlockedWallet` shape after D-KM-3) — the seedHex getter was dropped outright. Every caller migrated cleanly.

## 2026-06-19

- **Scaffolded** the spec directory. README + section stubs created.
- **Drafted** [05-key-management.md](./05-key-management.md) in response to the seed-in-memory question that surfaced during D3e (`moth daemon serve`) bring-up. Covers the current model (seed-as-V8-string for the daemon's lifetime), the matching threat-model implications, and a staged hardening path from derive-and-drop (cheap, ship soon) through `mlock` (OS-specific) to OS-keystore / KMS / HSM offload (multi-tenant prerequisite).

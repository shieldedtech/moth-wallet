---
status: accepted
last-updated: 2026-06-21
---

# 05 — Key Management

## Context

The wallet daemon's whole point is to hold spending keys so that callers (the TUI, a CLI client, a Web2 service via a future TCP transport) can ask it to perform on-chain operations without ever seeing the keys themselves. This is the same trust model as `ssh-agent`, Hashicorp Vault Transit, BitGo Cloud, or a custodial exchange hot wallet.

This section answers: **where do the keys live at rest, in flight, and at runtime; what can read them in each state; and how do we reduce that surface as the deployment shape gets more public?**

## Current state (today, as of this commit)

### At rest

- Keystore file at `~/.moth/wallets/<name>.keystore`.
- Encrypted with AES-256-GCM. Key derived from the operator's passphrase via Argon2id.
- File mode `0600`, dir `0700`. Filesystem permissions are the only thing protecting other UIDs on the same host from copying the file.
- An attacker with the file but not the passphrase has work to do — Argon2id is designed to make passphrase guessing expensive.

### During unlock

- `WalletManager.unlock(name, passphrase)` reads the keystore, runs Argon2id KDF, decrypts the ciphertext, and yields an `UnlockedWallet` object whose closure holds the plaintext `seedHex` (a 64-char hex string — the BIP-39 seed).
- The seed and its derivatives sit in V8 heap memory as JavaScript strings / `Uint8Array`. No `mlock`, no special protection.
- `UnlockedWallet.lock()` sets the closure variable to the empty string. V8 garbage collects the previous string eventually; the exact moment isn't observable.

### At runtime (daemon serve mode)

- The seed lives in the daemon process's V8 heap for the daemon's entire lifetime. Write verbs re-derive keys from the seed on each call via `deriveRawKeys(seedHex)` and downstream operations like `sendTokens` / `callCircuit`.
- The TUI uses the same model: once the operator unlocks a wallet at startup, the seed is in TUI process memory until quit.

### Threat model implications

Anyone who can read the daemon's process memory has the seed. Concretely:

| Adversary capability                                | Result      |
|-----------------------------------------------------|-------------|
| Same-UID `ptrace` / `gdb` attach                    | Seed extracted |
| Read `/proc/$PID/mem` (Linux) / `task_for_pid` (macOS) | Seed extracted |
| Read a core dump if the process ever crashes        | Seed extracted |
| Read a swap file containing the seed page           | Seed extracted (mitigated on macOS by default encrypted swap; not on every Linux distro) |
| Read filesystem keystore                            | Seed NOT extracted without passphrase (Argon2id work factor) |
| Network adversary on a Unix socket                  | Blocked by L1 perms; no network exposure today |
| Network adversary in service mode (future)         | Blocked by AuthN; covered separately in [02-authentication.md](./02-authentication.md) |
| Other UID on host                                   | Blocked by L1 perms; cannot reach the socket or the keystore |

The current model is acceptable for the local single-user developer-tool case the TUI was originally designed for. **It is not acceptable for a network-accessible service** that holds funds the operator cares about losing, because the surface for "attacker who can read process memory" expands meaningfully (CI runners, container images shipped with crash reporters, multi-tenant hosting).

## Decisions

### D-KM-1: Keep the keystore-at-rest model unchanged

**Decision**: AES-256-GCM + Argon2id KDF, file mode 0600 in 0700 directory.

**Why**: This is industry standard (Bitcoin Core, Electrum, MetaMask) and matches what users expect. No production wallet ships a different shape. Per-keystore work-factor tuning may be revisited as Argon2 parameters drift but the construction stays.

### D-KM-2: Seed-in-memory is acceptable for single-tenant local-host deployments

**Decision**: For deployments where the daemon and its callers run on a host the operator administers exclusively, the V8-heap-string seed model stays. The TUI and `moth daemon serve` running on a developer laptop, a private VM, or a single-tenant container all fall under this.

**Why**: The threat model is identical to running the TUI today. No new attacker capabilities are introduced by the daemon. Making the daemon strictly stricter than the TUI would be inconsistent.

**Conditions for this to remain true**:
- The daemon's socket stays local (Unix socket or loopback TCP). The moment we expose a network port to anything other than the operator's own host, this decision is **invalidated** until D-KM-3 ships.
- Any feature that exports the seed (backup, recovery, migration) goes through the keystore, not the daemon's RPC. The daemon never has a verb that returns the seed.

### D-KM-3: Derive-and-drop before exposing the daemon over the network

**Status**: Accepted and implemented as of 2026-06-21.

**Decision**: Before the daemon listens on anything reachable from outside the host (TCP + TLS, or a tunneled-but-network-reachable Unix socket), derive the typed key objects at unlock time and drop the raw seed string immediately.

**Concretely** (as implemented):

1. `WalletManager.unlock()` reads the keystore, derives the typed `WalletKeys` bundle via `deriveWalletKeys(seedHex)`, then overwrites the local `seedHex` string before returning. The returned `UnlockedWallet` exposes only `walletKeys` and `lock()` — no `seedHex` getter, no `clearSeed()` mechanism. The seed never escapes the function.
2. `WalletKeys` lives in `types/wallet.ts` so the `UnlockedWallet` interface can reference it without a cross-module import cycle. The concrete value is constructed by `deriveWalletKeys` in `sync/operations.ts`.
3. Every write path accepts the typed bundle directly. `sendTokens`, `designateForDust`, `dedesignateFromDust` have `*WithKeys` peers; `callCircuit`, `deployContract`, `insertVerifierKey`, `insertVerifierKeys` accept an optional `walletKeys` field alongside the legacy `seedHex` field, with the typed bundle preferred when supplied.
4. `startWalletSync` and `preSeedNewWallet` now take `WalletKeys` directly. The one place that genuinely needs a seedHex (the empty-reference wallet's brief existence inside `preseed.ts:buildEmptyRefCache`) generates one locally, derives, then `.fill(0)`s the buffer.

**Why this is meaningfully better**:
- The BIP-39 seed is the master secret — recovering it lets an attacker derive ANY child key, not just the ones in use. A process that holds only the derived typed keys leaks "what this wallet has used" but not "the operator's wallet across all derivations".
- The typed key WASM objects expose `clear()` (we use it nowhere today, but it zeros their internal state). Future tightening can zero those between operations.

**Cost paid**: ~200 LoC across `WalletManager`, `startWalletSync`, `preSeedNewWallet`, `executeBatchTransfer`, 10 CLI commands, the TUI's `useBalance`/`useWallet`/`useDaemonHost`/`app.tsx`. No SDK changes required. 126/126 unit tests pass; integration tests unchanged.

**Open question resolved**: the seedHex getter was dropped from `UnlockedWallet`'s public shape rather than parallel-shipped. Every caller in the repo migrated cleanly in one pass, so there was no need for an incremental shim.

**Lifecycle diagram** (what each component holds at each phase):

```mermaid
sequenceDiagram
  participant FS as Keystore file<br>~/.moth/wallets/&lt;name&gt;.keystore
  participant Mgr as WalletManager.unlock()
  participant Derive as deriveWalletKeys()
  participant UW as UnlockedWallet
  participant Caller as Caller (TUI / daemon / CLI)

  Caller->>Mgr: unlock(name, passphrase)
  Mgr->>FS: read keystore (encrypted)
  FS-->>Mgr: ciphertext + KDF params
  Mgr->>Mgr: Argon2id KDF + AES-256-GCM decrypt
  Note over Mgr: local var: seedHex (BIP-39 64-char hex)<br>SCOPE: inside unlock()
  Mgr->>Derive: deriveWalletKeys(seedHex)
  Derive-->>Mgr: { shieldedSecretKeys,<br>  dustSecretKey, nightExternalKey }
  Mgr->>Mgr: seedHex = '' (overwrite local)
  Note over Mgr: seedHex is now unreachable;<br>V8 will GC the original string
  Mgr->>UW: build with walletKeys
  Mgr-->>Caller: UnlockedWallet (no seedHex)
  Note over UW: holds walletKeys ONLY<br>no getter for seed
  Caller->>UW: walletKeys (for every write op)
  UW-->>Caller: { shieldedSecretKeys, dustSecretKey, nightExternalKey }
  Caller->>UW: lock()
  Note over UW: zeros typed key state
```

The BIP-39 seed exists as a JavaScript string for the duration of `WalletManager.unlock()` — typically milliseconds. After return, the only reference held anywhere in the process is the typed `WalletKeys` bundle. An attacker who reads heap memory mid-call might still get the seed, but only inside the narrow unlock window; read after that and they get derived keys only.

### D-KM-4: `mlock` decrypted key pages before service-mode launch

**Decision**: Use `mlock(2)` / `VirtualLock` on the pages holding derived keys, so they cannot be written to swap.

**Why**: Encrypted swap (macOS default; Linux opt-in) makes this mostly defense-in-depth, but every public-facing custodial service locks its key pages — losing a key because a memory-pressured machine swapped it to an unencrypted partition is the kind of failure that ends companies.

**How**:
- Node doesn't expose `mlock` directly. Either:
  - Native addon (~100 LoC C, vetted) that exposes `mlock(addr, len)` on the buffer backing a `Uint8Array`.
  - OR: shift to using `posix-mlock` or similar maintained npm package (audit first).
- Apply to: the typed key WASM internal storage if the SDK exposes it, and to any `Uint8Array` holding raw key bytes we manage ourselves.

**Cost**: ~100 LoC plus a native dep, plus the operational implication that the daemon may need `CAP_IPC_LOCK` or a raised `RLIMIT_MEMLOCK` on Linux.

**Open question**: do we ship a sidecar that just holds keys and talks to the main daemon over a domain socket, where the sidecar is the only process that links the native code? That isolates the trusted compute, but doubles the operational footprint.

### D-KM-5: Multi-tenant custodial deployment requires HSM/KMS offload

**Decision**: When the daemon holds keys for users it doesn't own, the raw key material must not live in the daemon process at all. Spending operations route through a KMS (AWS KMS / GCP KMS / Hashicorp Vault Transit) or an HSM (CloudHSM, on-prem YubiHSM, Fortanix).

**Why**: This is the standard for regulated custody. The attacker threat model now includes "rogue insider on the wallet-service operator's team" — anyone with shell access on the daemon host could otherwise drain every user. KMS / HSM offload moves the boundary so that even root on the daemon can't extract keys; they can only request signatures, which are audit-logged at the KMS layer.

**Why this is hard with Midnight today**:

- Midnight uses non-standard cryptography (Jubjub curve points, Schnorr signatures over Pedersen commitments, zk-SNARK proving with witness data). AWS KMS, GCP KMS, and most commercial HSMs speak secp256k1, secp256r1, RSA, AES. They do not understand zswap key formats.
- The proof server already sees witness data — moving raw keys off the daemon doesn't change that. The proof server is a separate trust boundary that this spec needs to address (see [09-threat-model.md](./09-threat-model.md) — tbd).
- Realistic near-term path: a **Fortanix-style attested confidential computing** environment running the wallet host inside an enclave (SGX, Nitro Enclaves, SEV-SNP). Keys never leave the enclave; the daemon-as-software-process-with-keys-in-RAM model survives but inside a hardware-enforced isolation boundary.

**Status**: This is the long-pole decision for any production multi-tenant launch. Out of scope for the next several commits but shapes earlier decisions — D-KM-3 and D-KM-4 are stepping stones that don't conflict with eventually moving to enclave-based custody.

## Staged implementation plan

| Stage | Daemon scope                                      | Key handling                          | Trigger to advance |
|-------|---------------------------------------------------|---------------------------------------|--------------------|
| 0     | TUI + `moth daemon serve` on local host           | Seed-as-V8-string for lifetime        | — (historical) |
| 1 (today) | Same, plus integration tests + derive-and-drop | Seed dropped inside `WalletManager.unlock()`; only `WalletKeys` retained (D-KM-3) | Need to expose the daemon to anything not the operator's own login session |
| 2     | Loopback TCP transport (`127.0.0.1:port`), API-key auth | Same as stage 1                | Need to expose the daemon to other hosts on the LAN |
| 3     | Public TCP+TLS, API-key + mTLS, policy engine     | + `mlock` (D-KM-4)                    | Need to hold keys for users you don't own |
| 4     | Multi-tenant custodial                            | KMS/HSM offload OR enclave (D-KM-5)   | — |

We are at stage 1. D-KM-3 landed on 2026-06-21. Every advancement past stage 1 needs another spec section accepted (architecture, authentication, policy, audit) before the corresponding code can ship.

## Open questions parked here

1. **Resolved (2026-06-21)**: `UnlockedWallet` shape after D-KM-3 — the seedHex getter was dropped outright. Every caller migrated.

2. **Keystore versioning**: the current keystore JSON has no explicit version field. When we eventually change the on-disk layout (e.g., to support multiple derivations per file for multi-account wallets), we need a version field and a migration path. File `KEYSTORE-FORMAT.md` once this matters.

3. **Passphrase rotation**: today there's no `moth wallet change-passphrase`. For a long-running daemon this is a real ops concern — passphrases compromised over time, operator turnover, etc. The mechanic itself is straightforward (decrypt with old, re-encrypt with new), but we need a clean offline path that doesn't require the daemon to be running.

4. **Recovery**: if the daemon's host dies, the keystore + mnemonic on a backup get the operator back in. For multi-tenant deployments (D-KM-5), recovery is the hardest problem — how do users prove ownership without keys, especially if the custodian itself loses access? Punted to [08-multi-tenant-roadmap.md](./08-multi-tenant-roadmap.md).

5. **Proof server trust**: the proof server today sees witness data in the clear. It's a separate process running locally during proving. For a service-mode daemon, can the proof server live in a TEE? If not, is it acceptable that the trust boundary leaks through it? This is a [09-threat-model.md](./09-threat-model.md) question that loops back to key management because if the proof server is hostile it can siphon spending data even without keys.

## See also

- [02-authentication.md](./02-authentication.md) — how callers prove who they are; orthogonal to key management at the daemon level but they share threat-model assumptions.
- [09-threat-model.md](./09-threat-model.md) — STRIDE pass over the whole system; this section's decisions follow from the threat model there.
- [09 ↔ proof-server witness trust] — open question (5 above).

# mobile-proving-bench

Native Midnight proving on an iPhone, measured with the unmodified ledger-8.1.3 Rust prover (the ledger version mainnet runs). It was built to answer whether a mobile wallet can prove on the device rather than remotely.

## Results (iPhone 17 Pro, 2026-10-10)

- **Wallet circuits:** a zswap output proves in 1.21–1.29 s and a spend in 2.25–2.43 s, on 6 threads. Times stayed flat over a minute of continuous proving, thermal state stayed nominal, and they were the same on battery. Peak memory was 665 MB.
- **Larger circuits (k sweep):** k=15 takes 1.7 s, k=16 3.4 s and k=17 6.5 s. At k=18 iOS killed the app at about 3.3 GB, right after prover-key expansion. Memory is about 70x the serialized prover key and doubles with each k.
- **WASM, for comparison:** the WASM prover is about 15x slower than native even single-threaded (M5 Max: a spend takes 37 s in WASM, against 2.4 s native on one thread).

The raw data is in `results/`, and `summarize_ksweep.py` prints the per-k table.

## What it measures

- **Wallet circuits** (`bench/src/lib.rs`, `mn_bench_run`). Each round:
  1. proves a zswap output
  2. applies the proven output to a local wallet state
  3. proves a spend of that coin, checked with `well_formed`

  Per round it records the time and memory: iOS `phys_footprint` and its peak, which is what jetsam counts.
- **k sweep** (`bench/src/ksweep.rs`, `mn_ksweep_run`).
  - **Circuits.** Synthetic circuits: a chain of `transient_hash` (Poseidon) sized to fill exactly 2^k rows. Each hash costs 22 rows.
  - **Per k.** Records prover-key expansion time, then 3 proofs, each verified against the verifier key.
  - **Timeout.** Any single proof over 60 s is recorded as a timeout and ends the sweep. The proving thread can't be cancelled, so the app exits.
- **Logging.** The iOS app (`app/App.swift`) runs the wallet benchmark (10 rounds, 6 threads), then the sweep for k=10..20. It appends every event, plus thermal state and battery once a second, to `Documents/*.jsonl` as it goes. A USB disconnect or an out-of-memory kill therefore loses nothing already measured.

## Layout

| Path | Contents |
|---|---|
| `bench/` | Rust crate. Builds a static library for iOS and a Mac CLI. Depends on midnight-ledger at git tag `ledger-8.1.3`. |
| `app/` | SwiftUI harness, bridging header, Info.plist, entitlements. |
| `results/run1-wallet/console.log` | First iPhone run (wallet circuits, USB-powered). |
| `results/run2-ksweep/` | Second iPhone run (wallet + k sweep, on battery; the app was killed at k=18). |
| `results/mac/` | Mac M5 Max k sweep, plus the keygen log. |
| `summarize_ksweep.py` | Prints the per-k table from a `ksweep.jsonl`. |

## Rebuild and run

Prerequisites:
- Xcode
- Rust
- an "Apple Development" signing identity and a provisioning profile that covers the phone (passed as `TEAM_ID`, `SIGN_ID` and `PROFILE`)
- the zk params cache at `~/.cache/midnight/zk-params`, which the Mac wallet benchmark fills on first run

Steps:

```sh
TEAM_ID=… SIGN_ID=… PROFILE=… ./build.sh   # Mac CLI, iOS lib, k-sweep keys (cached in ksweep-keys/), signed build/MNProveBench.app (~950 MB)
DEVICE=<udid> ./run-device.sh install   # phone connected and unlocked
DEVICE=<udid> ./run-device.sh launch    # then unplug if you want a battery run; keep the app on screen
DEVICE=<udid> ./run-device.sh pull run3 # after it shows DONE or exits; writes results/run3/ and prints the k table
```

Mac-only runs:

```sh
./target/release/mn-mobile-bench params 3 6                                   # wallet circuits: dir, rounds, threads
./target/release/mn-mobile-bench sweep params ksweep-keys 10,11,12 3 6 out.jsonl
./target/release/mn-mobile-bench calibrate 16,17                               # hashes per k
```

The bundle ID is `io.shielded.mnprovebench`; get the phone's UDID from `xcrun devicectl list devices`.

## Caveats

- **Synthetic circuits.** Real Compact circuits lay out columns and lookups differently, so the per-k numbers are approximate. As a check, the real zswap spend is k=15 and takes 2.3 s on the phone, against 1.7 s for the synthetic k=15.
- **Unconfirmed memory kill.** The k=18 kill is assumed to be iOS jetsam: the process died with no error and no timeout written. The jetsam log was not pulled.
- **No energy figure.** The battery level read 100% for the whole battery run.
- **iOS only so far.** Android hasn't been measured.

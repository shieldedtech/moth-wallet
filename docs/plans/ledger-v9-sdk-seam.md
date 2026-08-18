# Dual-SDK seam: verified file map

Supporting plan for [ADR-0006](../adr/0006-ledger-v9-and-signature-kinds.md). Every
classification below was measured by loading both SDK generations in one Node process and
comparing output, not inferred from signatures. Measured 2026-08-18.

## Why a second seam is needed

The ledger seam lets Moth choose v8 or v9. It is not sufficient: `@midnightntwrk/wallet-sdk@1.2.0`
is bound to ledger-v8, so a v9 ledger object handed to it is rejected at the WASM boundary. This
is what stopped a stagenet preseed:

```
Pre-seed: reference sync failed — Error: expected instance of DustParameters
```

Isolating that exact call gives a clean three-way result:

| Combination | Result |
|---|---|
| v8 SDK + v8 ledger | **ACCEPTED** (control — harness is valid) |
| v8 SDK + v9 ledger | **REJECTED** — DustParameters identity mismatch (the bug) |
| v9 SDK + v9 ledger | **ACCEPTED** (the fix) |

Both SDK generations install and load together. Yarn hoists the v8 line to the top level and nests
the v9 beta under the alias, with exactly one copy of each ledger:

```
node_modules/@midnightntwrk/wallet-sdk            1.2.0          (v8 line, hoisted)
node_modules/wallet-sdk-v9/node_modules/…         5.0.0-beta.2   (v9 line, nested)
@midnight-ntwrk/ledger-v8@8.1.0  ·  @midnightntwrk/ledger-v9@1.0.0-rc.3
```

Alias: `"wallet-sdk-v9": "npm:@midnightntwrk/wallet-sdk@2.0.0-beta.2"`.

## What is invariant across the fork

Measured, same inputs through both SDK generations:

| Subpath | Result | Evidence |
|---|---|---|
| `/hd` | **INVARIANT** | `HDWallet.fromSeed` → identical keys for every role |
| `/address-format` | **INVARIANT** | identical bech32m encoding from identical inputs |
| `/unshielded` (address) | **INVARIANT** | same bech32m address from the same seed |
| `/unshielded` (signing) | **DIVERGES** | different signature bytes; v9 rejects a v8 signature |

Two consequences worth stating plainly.

**`createKeystore` changed shape**: v8 takes `(Uint8Array, networkId)`, v9 takes
`({kind, secret}, networkId)`. A v8-style call throws on v9.

**Signature kind changes the address.** An `ecdsa` keystore yields a *different* bech32m address
than a `schnorr` one from the same seed, and the ledger verifies both. So the signature kind is not
a signing preference — it selects an identity. Unlike the ledger version, which the network
dictates, this genuinely is a user-facing choice, and it belongs at wallet creation. ADR-0006's
decision not to prompt for a *ledger version* stands; it does not extend to signature kind.

## File map

17 files import the SDK.

### Shared — no version seam needed

Only invariant surfaces. These keep importing the v8 SDK directly, for the same reason
`wallet/address.ts` keeps importing ledger-v8 directly: the output is identical either way.

| File | Subpaths |
|---|---|
| `core/src/wallet/mnemonic.ts` | `/hd` |
| `core/src/wallet/address-validate.ts` | `/address-format` |
| `core/src/contract/fungible-token.ts` | `/address-format` |
| `core/src/wallet/address.ts` | `/address-format`, `/hd`, `/unshielded` (address only) |

### Type-only — no runtime dependency

| File | Subpaths |
|---|---|
| `tui/src/hooks/useDaemonHost.ts` | `import type … /facade` |

### Must be version-matched

Ledger objects or signatures cross the boundary, so the SDK generation must match the active
ledger.

| File | Subpaths | Why |
|---|---|---|
| `core/src/sync/wallet-sync.ts` | `~`, `/facade`, `/dust`, `/shielded`, `/unshielded`, `/hd`, `/capabilities/submission` | facade init, `DustParameters` — the observed failure |
| `core/src/sync/sdk-dedup.ts` | `/dust/v1`, `/shielded/v1` | wraps sync capabilities over ledger state |
| `core/src/sync/operations.ts` | `/facade`, `/address-format`, `/hd`, `/unshielded` | returns `ZswapSecretKeys` into transaction code |
| `core/src/sync/activity.ts` | `/facade` | reads facade state |
| `core/src/sync/preseed.ts` | `/unshielded` | reference wallet inside the sync path |
| `core/src/daemon/wallet-handlers.ts` | `/facade` | submits transactions |
| `core/src/proof/provider.ts` | `/capabilities/proving`, `/prover-client/effect` | proving over ledger transactions |
| `core/src/providers/midnight-provider.ts` | `~`, `/node-client` | submission |
| `core/src/contract/call.ts` | `/hd`, `/unshielded` | signs intents |
| `core/src/contract/deploy.ts` | `/address-format`, `/hd`, `/unshielded` | signs intents |
| `core/src/contract/maintenance.ts` | `/hd`, `/unshielded` | signs intents |
| `core/src/wallet/sign-message.ts` | `/unshielded` | signature bytes differ per version |

**12 files must be version-matched; 4 are shared; 1 is type-only.**

## Shape of the seam

Mirror `src/ledger/`: an `src/sdk/` module with two adapter implementations behind one interface,
selected by the active ledger version. The adapters are the only modules permitted to import
`@midnightntwrk/wallet-sdk` or `wallet-sdk-v9` for the must-match subpaths; a lint rule should
enforce that, as the ledger seam does.

The shared four keep direct imports and should carry a comment saying why, pointing here.

## Open questions

1. **Does v9 sync actually complete against stagenet?** The spike proves the objects are accepted;
   it does not prove a full sync. Rebuilding a stagenet preseed reference is the end-to-end test,
   and stagenet is ~74k blocks, small enough to be quick.
2. **Which SDK signs a message when the wallet is idle?** `sign-message.ts` has no network in scope
   today; it takes a `networkId` string. It needs the ledger version threaded in.
3. **Does the ECDSA address break existing wallets?** Since kind changes the address, an existing
   schnorr wallet must stay schnorr. Kind is a creation-time property to be persisted, never a
   toggle on an existing wallet.
4. **`wallet-sdk@2.0.0-beta.2` is a beta**, and `canary-v2` is newer. Pin deliberately.

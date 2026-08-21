# ADR-0007: cNIGHT to DUST registration

- **Status:** Proposed
- **Date:** 2026-08-21
- **Authors:** @bobblessinghartley
- **Reviewers:**
- **Tags:** cardano, dust, keys, packaging

## Context

NIGHT held on Cardano (cNIGHT) generates DUST for a Midnight address, but only
once an on-chain mapping exists between the Cardano holder and that address.
Moth cannot see or create that mapping today. `IndexerClient` has one
Cardano-shaped call, `getDustGenerationStatus(cardanoRewardAddresses)`, and its
only caller passes the wrong thing:

```ts
// packages/cli/src/commands/dust/status.ts
// Query DUST status — requires the Cardano reward address
// For now, use the wallet address as a placeholder
const statuses = await client.getDustGenerationStatus([wallet.address]);
```

That is a Midnight bech32m address where a `CardanoRewardAddress` is required, so
`moth dust status` has never answered the question it appears to answer.

Registration is not metadata. Read from the reference implementation at
`midnight-cnight-to-dust-dapp` (`src/lib/dustTransactionsUtils.ts:31-152`), it is
a Plutus contract interaction:

1. Mint one DUST NFT (empty asset name) under the DUST Generator's minting
   policy, redeemer `DustAction.Create`, CBOR-serialised.
2. Pay `1_586_080` lovelace plus that NFT to the DUST Generator validator
   address, carrying an inline datum:
   ```
   { c_wallet: { VerificationKey: [stakeKeyHash] },   // 28 bytes
     dust_address: <32 bytes> }
   ```
3. Sign with the key that controls the cNIGHT, submit, and wait for confirmation.

The indexer has no registration mutation — only `connect`/`disconnect` — so
nothing about this can be done Midnight-side. `dustGenerationStatus` is read-only
and reports what already exists on Cardano.

Two constraints narrow the design before any code:

- **The signer must be the stake key whose cNIGHT generates the DUST.** The datum
  binds `stakeKeyHash`, taken in the reference dApp from the connected wallet's
  address. A Cardano account derived from moth's Midnight seed would hold no
  cNIGHT, so deriving one is not a shortcut — it is a dead end that looks like a
  shortcut.
- **`core` may not import platform builtins.** ADR-0003's boundary rules are now
  enforced by tests (PR #23): the browser package's walked import graph reaches
  no Node builtin, where `core`'s own barrel reaches 36. Lucid, Blaze and the
  harmoniclabs CBOR/Plutus libraries are very unlikely to survive that rule.

## Decision

We will add a separate package, `@shieldedtech/moth-cardano`, holding all
Cardano-specific code, and moth will hold Cardano keys so registration works on
the CLI, TUI and extension alike.

```
packages/cardano/
  src/keys.ts           CIP-1852 derivation; stake key hash
  src/registration.ts   builds the mint + datum output; pure, returns an unsigned tx
  src/blueprint.ts      DUST Generator script, policy id, lovelace constant, per network
  src/provider.ts       a chain-provider port; Blockfrost lives behind it
```

`core` will not depend on this package. Surfaces compose the two, exactly as they
already compose `core` with the Node and IndexedDB storage backends.

The Cardano secret is a **separate import** from the Midnight seed: the user
brings the mnemonic of the wallet that already holds their cNIGHT.

Scope limit: this is not a general-purpose Cardano wallet. It derives what
registration needs, builds registration, update and deregistration transactions,
and reads generation status. It does not do staking, native assets, or general
transfers.

## Alternatives considered

### Option A — CIP-30 connection to an existing Cardano wallet

- **Summary:** what the reference dApp does — `lucid.wallet()` backed by a
  browser extension such as Lace, with `sign.withWallet()`.
- **Pros:** no key custody; the user keeps cNIGHT where it already is; the
  signing prompt comes from a wallet they already trust.
- **Cons:** browser-only. The CLI and TUI have no extension to talk to, so the
  feature would exist on one surface out of three. An extension-to-extension
  connection is also awkward: moth would be a dApp asking Lace to sign.
- **Why not chosen:** parity across surfaces was a requirement.

### Option B — Moth holds Cardano keys from an imported mnemonic (chosen)

- **Summary:** the user imports the Cardano mnemonic holding their cNIGHT; moth
  derives CIP-1852 keys and signs registration itself.
- **Pros:** identical behaviour on all three surfaces; no dependency on another
  wallet being installed; scriptable from the CLI.
- **Cons:** moth becomes custodian of keys controlling real ADA and cNIGHT — a
  materially larger security surface than a Midnight-only wallet. One passphrase
  now guards two chains' funds, which has to be explained rather than assumed.
- **Why chosen:** the only option that satisfies the parity requirement.

### Option C — Derive Cardano keys from the existing Midnight seed

- **Summary:** add a CIP-1852 path to `deriveAllAddressesFromSeed`.
- **Pros:** no second secret, no new import flow.
- **Cons:** the derived account holds no cNIGHT, which is the entire point. It
  would only be useful if moth were where the user's cNIGHT already lived.
- **Why not chosen:** it answers a different question from the one users have.

### Option D — Display only; register elsewhere

- **Summary:** moth exposes the DUST address and reads generation status back;
  registration happens in the Cardano wallet or the reference dApp.
- **Pros:** no Cardano keys, no Cardano dependencies, small.
- **Cons:** the user has to leave moth to complete the flow.
- **Why not chosen:** rejected deliberately — creating the registration is the
  requirement. The DUST-address exposure below is kept regardless, because it is
  useful on its own.

## Consequences

### Positive

- `moth dust status` can answer truthfully, against a real reward address.
- The registration flow works headless, so it can be scripted and tested in CI
  rather than clicked through a browser.
- Cardano code is quarantined in one package, so the boundary guards keep
  protecting DApp bundle size.

### Negative

- Moth holds keys to Cardano funds. Accepting this means the keystore, unlock
  path and passphrase story all now cover two chains.
- A Blockfrost project key becomes a new class of configuration: a third-party
  API token, per network, either user-supplied or proxied. Neither is free.
- The dependency surface grows substantially — Lucid or Blaze, plus CBOR and
  Plutus-data libraries — for one feature.
- The DUST Generator script hash and policy id are deployment constants that must
  be tracked per network, in the same way the ledger version already is.

### Neutral / follow-up

- **Expose the DUST address in the receive panel.** `Receive.tsx` today has
  shielded and unshielded tabs, and a header comment reading "No DUST tab: DUST
  can't be transferred, so it can't be received." That is true of the token and
  wrong about the address: the DUST address is precisely what a cNIGHT holder
  needs to register. This is independent of everything else here and can land
  first.
- CLI and TUI already print the DUST address at `wallet generate`; the
  extension's Accounts view is where it is missing.
- Deregistration and update transactions exist in the reference implementation
  (`docs/DEREGISTRATION.md`) and should follow the same shape.

## Open question, blocking implementation

**Which 32 bytes belong in `dust_address`?** The contract does not say —
`contract_blueprint.ts` declares it `Type.String()`, an opaque ByteString — and
the two available sources disagree:

| Source | Says it is |
| --- | --- |
| Our `addresses.dust`, our `designateForDust` receiver (`operations.ts:525`), the indexer's `dustAddress` (fixture `mn_dust_test1xyz`) | bech32m address from the dedicated **Dust role key** |
| The reference dApp (`Onboard.tsx:110`, `dustPKHValue = midnight.coinPublicKey`) | raw 32-byte **shielded coin public key** |

These cannot both be right, and picking wrong writes a registration whose DUST
accrues to a key the user cannot spend from. So it is settled empirically before
we sign anything:

1. Take a Cardano reward address with a live registration on preprod.
2. Read `dustGenerationStatus(cardanoRewardAddresses: [...]) { dustAddress }` and
   decode it from bech32m to its 32 bytes.
3. Read the inline datum of that registration UTXO and compare `dust_address`.

Matching bytes mean the datum holds a Dust-role public key, and the reference
dApp is passing the wrong key. Differing bytes mean the cNIGHT flow genuinely
keys on the shielded coin public key, and `addresses.dust` is not part of it.

## Validation

- **Success criteria:** a registration created by moth on preprod is reported by
  the indexer as `registered: true` against the expected `dustAddress`, and DUST
  accrues to an address the same wallet can spend from. The same flow runs from
  the CLI without a browser.
- **Failure signals:** the open question above resolves such that no single
  32-byte value satisfies both the contract and the indexer; or the Cardano
  dependencies cannot be kept out of the browser graph without a shim that costs
  more than the feature.
- **Review date:** after the first successful preprod registration.

## References

- Related ADRs: [ADR-0003](0003-preseed-reference.md) for the boundary rules this
  respects; [ADR-0006](0006-ledger-v9-and-signature-kinds.md) for the precedent
  of per-network deployment constants.
- Reference implementation: `midnight-cnight-to-dust-dapp` —
  `docs/REGISTRATION.md`, `docs/DEREGISTRATION.md`,
  `src/lib/dustTransactionsUtils.ts`, `src/config/contract_blueprint.ts`.
- Cardano derivation reference: `lace-wallet` —
  `packages/contract/cardano-context`, which uses `@cardano-sdk/{core,crypto,key-management,util}`.

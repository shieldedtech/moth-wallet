# ADR-0007: Cardano test pairing for local Midnight networks

- **Status:** Proposed
- **Date:** 2026-10-12
- **Authors:** @bobblessinghartley
- **Reviewers:** TBD
- **Tags:** cardano, network, dapp-testing

## Context

Moth derives the Cardano network from the Midnight network and never lets the user choose it
(`cardanoNetworkFor`): mainnet→Mainnet, preprod→Preprod, preview→Preview, and **nothing** for
undeployed, devnet and qanet. The reason is in the code: a DUST registration only works between a
real bridge pair. A cNIGHT registration on Cardano Preview against a Midnight preprod wallet is
accepted by Cardano, never seen by Midnight, and gives no feedback for the twelve hours the user
waits.

That rule also switches off everything else Cardano on local networks: the Cardano account, its
balances (including cNIGHT), sending, and the CIP-30 provider. Those don't involve the bridge.

dApps developed against a local Midnight stack need them. The motivating case is Gloam, whose
local profile pairs the devnet with Cardano preprod: creators pay a launch fee in cNIGHT on
Cardano, and guardians attest the payment on Midnight. Testing that payment from the wallet (CIP-30)
against a local stack is impossible today. The developer's undeployed account shows no cNIGHT.

Constraints:

- The bridge pairing, and everything that depends on it (registration, update, deregistration),
  must keep its guarantee exactly.
- Mainnet must never be reachable from a development network.
- CIP-30 reports only a network id (0 = any testnet), so a dApp can't tell Preprod from Preview.

## Decision

We will let a **local** Midnight network (undeployed, devnet, qanet) name a Cardano **testnet**
(Preprod or Preview) as a *test pairing*, used for reading, sending and signing only.

- **Core** (`cardano/network.ts`):
  - `effectiveCardanoNetwork(midnight, testPairing)` returns the bridge pairing where one exists
    (never overridable), else the test pairing on a local network, else null. Mainnet is never
    accepted.
  - `resolveCardanoNetwork` takes `testPairing` and marks the resolved config
    `testPairing: true`.
  - `registerForDust`, `updateDustAddress` and `deregisterFromDust` refuse a test pairing
    (`TestPairingRegistrationError`) before touching the chain.
  - `cardanoNetworkFor` is unchanged and remains the bridge pairing.
- **Extension:**
  - setting `cardanoTestPairing: { [localNetwork]: 'Preprod' | 'Preview' }`, default empty;
    entries for public networks or Mainnet are dropped on read;
  - Settings → Cardano shows **Cardano network for testing** (None / Preprod / Preview) on local
    networks only, and the per-network Blockfrost id follows the effective pairing;
  - the Cardano screen labels the network "Preprod (test pairing)", explains that DUST
    registration is off, and hides the register/update/deregister controls.
- **CLI / TUI / daemon:** `MOTH_CARDANO_TEST_NETWORK` or the stored `cardano-test-network`
  config, with the same rules (`parseTestPairing`).

## Alternatives considered

### Option A: Keep local networks unpaired

- **Summary:** status quo.
- **Pros:** no new surface.
- **Cons:** dApps that take Cardano payments can't be tested end to end against a local stack.
- **Why not chosen:** it blocks a real workflow to prevent a mistake that a narrower rule also
  prevents.

### Option B: Let any network choose its Cardano pairing

- **Pros:** maximum flexibility.
- **Cons:** reintroduces exactly the mismatched-registration failure the derivation exists to
  prevent, and makes Mainnet reachable from development networks.
- **Why not chosen:** it removes the guarantee rather than scoping it.

### Option C: Test pairing on local networks only, registration refused (chosen)

- **Pros:** registration still only happens on a real bridge pair; local stacks can test
  payments and signing; Mainnet is never involved.
- **Cons:** one more setting; a dApp can't detect which testnet the wallet picked (see below).
- **Why chosen:** it keeps the guarantee where it matters and unblocks testing.

## Consequences

### Positive

- A local Midnight account can hold and send testnet cNIGHT and answer CIP-30 calls, so dApps
  like Gloam can test Cardano-paid flows end to end.
- Registration remains possible only between real bridge pairs. This is enforced in core, not
  just hidden in the UI.

### Negative

- **Ambiguous testnet for dApps.** CIP-30 reports network id 0 for both Preprod and Preview. If
  the user pairs Preview while the dApp expects Preprod, a payment lands on a chain the dApp
  never watches. Mitigation: the dApp names the expected network, and the wallet labels the
  pairing on every Cardano screen. A future CIP-30 extension could expose the network name.
- Five new strings ship in English in de/es/fr pending translation (TRANSLATION-STATUS.md).

### Neutral / follow-up

- Consider an `experimental.cardanoNetworkName` CIP-30 extension method.
- Show the pairing in CIP-30 approval prompts (today they show the Cardano network name).

## Validation

- **Success criteria:**
  - On undeployed with a Preprod test pairing, the Cardano screen shows the account's tADA and
    tcNIGHT, and a CIP-30 payment from a local dApp confirms on Preprod.
  - Registration attempts fail with `TestPairingRegistrationError`, in tests and in the UI.
- **Failure signals:** any registration created from a local network; any Mainnet use from a
  local network.
- **Review date:** after the first dApp integration test that uses it.

## References

- Code: `packages/core/src/cardano/network.ts` (`effectiveCardanoNetwork`,
  `canRegisterForDust`), `registration.ts` (`assertBridgePair`), `config.ts`
  (`parseTestPairing`), `packages/extension/lib/background/settings.ts`
  (`parseTestPairings`), `components/screens/Settings.tsx`, `Cardano.tsx`.
- Tests: `packages/core/tests/unit/cardano/test-pairing.test.ts`,
  `packages/extension/tests/settings.test.ts`.
- Gloam: cNIGHT launch fees (research R21) and the browser payment task (T147).

// Pins the ledger's imbalance sign convention, which the approval screen turns
// into "You pay" / "You get back". If a ledger release flipped it, the wallet
// would tell the user they receive what they are about to spend.

import {describe, expect, it} from 'vitest';
import {
  CostModel,
  Intent,
  Transaction,
  UnshieldedOffer,
  nativeToken,
  sampleSigningKey,
  signatureVerifyingKey,
  type ProvingProvider,
  type UtxoOutput,
  type UtxoSpend,
} from '@midnight-ntwrk/ledger-v8';
import {
  decodeConnectorTransaction,
  summarizeConnectorTransaction,
  summarizeTransaction,
} from '../../../src/sync/tx-summary.js';

const OWNER = 'be5eb2579464f606ed883d18831617302f484e6ce3602b0e2725801b653cd19d';
const OTHER_TOKEN = 'ab'.repeat(32);
// OWNER, bech32m-encoded for preprod — the address the approval must display.
const OWNER_ADDRESS = 'mn_addr_preprod1he0ty4u5vnmqdmvg85vgx9shxqh5snnvudszkr38ykqpkefu6xwsq30mjf';

// An input names its owner by verifying key, not by address, and the ledger
// checks the key's shape when the offer is built.
const nightInput = (value: bigint): UtxoSpend => ({
  value,
  owner: signatureVerifyingKey(sampleSigningKey()),
  type: nativeToken().raw,
  intentHash: '00'.repeat(32),
  outputNo: 0,
});

// The fixtures carry no contract calls, so proving only advances the stage
// marker; a provider that is ever consulted is a fixture bug.
const noProofs: ProvingProvider = {
  async check() {
    throw new Error('unexpected proof check');
  },
  async prove() {
    throw new Error('unexpected proving');
  },
};

async function unsealedTx(inputs: UtxoSpend[], outputs: UtxoOutput[]): Promise<Uint8Array> {
  const intent = Intent.new(new Date(Date.now() + 60_000));
  intent.fallibleUnshieldedOffer = UnshieldedOffer.new(inputs, outputs, []);
  const unproven = Transaction.fromParts('preprod', undefined, undefined, intent);
  const unbound = await unproven.prove(noProofs, CostModel.initialCostModel());
  return unbound.serialize();
}

describe('summarizeConnectorTransaction', () => {
  it('reports an output the dApp left unfunded as a spend from the wallet', async () => {
    const bytes = await unsealedTx([], [{owner: OWNER, type: nativeToken().raw, value: 1_000_000n}]);

    expect(summarizeConnectorTransaction(bytes, false, 'preprod')).toEqual({
      spends: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1_000_000n}],
      receives: [],
      contractActions: 0,
      recipients: [
        {address: OWNER_ADDRESS, kind: 'user', amounts: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1_000_000n}]},
      ],
    });
  });

  it('sums several outputs of one token and keeps distinct tokens apart', async () => {
    const bytes = await unsealedTx(
      [],
      [
        {owner: OWNER, type: nativeToken().raw, value: 250_000n},
        {owner: OWNER, type: nativeToken().raw, value: 750_000n},
        {owner: OWNER, type: OTHER_TOKEN, value: 7n},
      ]
    );

    const summary = summarizeConnectorTransaction(bytes, false, 'preprod');
    expect(summary.receives).toEqual([]);
    expect(summary.spends).toHaveLength(2);
    expect(summary.spends).toContainEqual({kind: 'unshielded', tokenId: nativeToken().raw, amount: 1_000_000n});
    expect(summary.spends).toContainEqual({kind: 'unshielded', tokenId: OTHER_TOKEN, amount: 7n});
  });

  it('reports an input without a matching output as change back to the wallet', async () => {
    const bytes = await unsealedTx([nightInput(3_000_000n)], [{owner: OWNER, type: nativeToken().raw, value: 1_000_000n}]);

    expect(summarizeConnectorTransaction(bytes, false, 'preprod')).toEqual({
      spends: [],
      receives: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 2_000_000n}],
      contractActions: 0,
      recipients: [
        {address: OWNER_ADDRESS, kind: 'user', amounts: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1_000_000n}]},
      ],
    });
  });

  it('reports nothing for a transaction that is already balanced', async () => {
    const bytes = await unsealedTx([nightInput(1_000_000n)], [{owner: OWNER, type: nativeToken().raw, value: 1_000_000n}]);

    expect(summarizeConnectorTransaction(bytes, false, 'preprod')).toEqual({
      spends: [],
      receives: [],
      contractActions: 0,
      // Balanced for the WALLET, but it still pays someone: a screen that showed
      // only amounts would render this as "takes nothing" with no destination.
      recipients: [
        {address: OWNER_ADDRESS, kind: 'user', amounts: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1_000_000n}]},
      ],
    });
  });

  it('decodes with the markers the balancing path uses, so the summary matches what gets balanced', async () => {
    const bytes = await unsealedTx([], [{owner: OWNER, type: nativeToken().raw, value: 1n}]);
    const tx = decodeConnectorTransaction(bytes, false);
    expect(summarizeTransaction(tx, 'preprod').spends).toEqual([{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1n}]);
    // A pre-binding transaction is not a bound one; asking for the wrong stage must fail loudly.
    expect(() => decodeConnectorTransaction(bytes, true)).toThrow();
  });

  it('encodes every unshielded destination as a bech32m address', async () => {
    const bytes = await unsealedTx([], [{owner: OWNER, type: nativeToken().raw, value: 1n}]);

    expect(summarizeConnectorTransaction(bytes, false, 'preprod').recipients).toEqual([
      {address: OWNER_ADDRESS, kind: 'user', amounts: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1n}]},
    ]);
  });

  it('encodes for the network it is told about, not a fixed one', async () => {
    const bytes = await unsealedTx([], [{owner: OWNER, type: nativeToken().raw, value: 1n}]);

    const [preprod] = summarizeConnectorTransaction(bytes, false, 'preprod').recipients;
    const [undeployed] = summarizeConnectorTransaction(bytes, false, 'undeployed').recipients;
    expect(preprod.address).toMatch(/^mn_addr_preprod1/);
    expect(undeployed.address).toMatch(/^mn_addr_undeployed1/);
    expect(preprod.address).not.toEqual(undeployed.address);
  });

  it('deduplicates repeated destinations but keeps distinct ones', async () => {
    const other = 'ce'.repeat(32);
    const bytes = await unsealedTx(
      [],
      [
        {owner: OWNER, type: nativeToken().raw, value: 1n},
        {owner: OWNER, type: nativeToken().raw, value: 2n},
        {owner: other, type: nativeToken().raw, value: 3n},
      ]
    );

    const {recipients} = summarizeConnectorTransaction(bytes, false, 'preprod');
    expect(recipients).toHaveLength(2);
    expect(recipients[0].address).toEqual(OWNER_ADDRESS);
    // Repeated outputs to one destination total, rather than collapsing to a
    // bare address that says nothing about how much went there.
    expect(recipients[0].amounts).toEqual([{kind: 'unshielded', tokenId: nativeToken().raw, amount: 3n}]);
    expect(recipients[1].amounts).toEqual([{kind: 'unshielded', tokenId: nativeToken().raw, amount: 3n}]);
  });

  // The decoy: a net total cannot separate these two outputs, and the larger is
  // what a drain hides behind. Per-destination amounts are what make it visible.
  it('attributes each amount to its own destination', async () => {
    const attacker = 'ce'.repeat(32);
    const bytes = await unsealedTx(
      [],
      [
        {owner: attacker, type: nativeToken().raw, value: 2_999_000_000n},
        {owner: OWNER, type: nativeToken().raw, value: 1_000_000n},
      ]
    );

    const {spends, recipients} = summarizeConnectorTransaction(bytes, false, 'preprod');
    // One total, which is all an amounts-only screen could ever show.
    expect(spends).toEqual([{kind: 'unshielded', tokenId: nativeToken().raw, amount: 3_000_000_000n}]);
    // The ledger orders the outputs, so look each destination up by address.
    const amountFor = (address: string) =>
      recipients.find((r) => r.address === address)?.amounts[0]?.amount;
    expect(amountFor(OWNER_ADDRESS)).toBe(1_000_000n);
    expect(recipients).toHaveLength(2);
    expect(recipients.map((r) => r.amounts[0].amount).reduce((a, b) => a + b)).toBe(3_000_000_000n);
    expect(amountFor(recipients.find((r) => r.address !== OWNER_ADDRESS)!.address)).toBe(2_999_000_000n);
  });

  it('keeps a destination amounts split by token', async () => {
    const other = 'ff'.repeat(32);
    const bytes = await unsealedTx(
      [],
      [
        {owner: OWNER, type: nativeToken().raw, value: 5n},
        {owner: OWNER, type: other, value: 7n},
      ]
    );

    const [recipient] = summarizeConnectorTransaction(bytes, false, 'preprod').recipients;
    expect(recipient.amounts).toEqual([
      {kind: 'unshielded', tokenId: nativeToken().raw, amount: 5n},
      {kind: 'unshielded', tokenId: other, amount: 7n},
    ]);
  });
});

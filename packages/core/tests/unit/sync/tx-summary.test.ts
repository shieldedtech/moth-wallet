// Pins the ledger's imbalance sign convention, which the approval screen turns
// into "You pay" / "You get back". If a ledger release flipped it, the wallet
// would tell the user they receive what they are about to spend. Both ledger
// versions are exercised: the summary reads whichever one authored the bytes.

import {describe, expect, it} from 'vitest';
import {
  ContractCallPrototype,
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractOperation,
  ContractState,
  CostModel,
  Intent,
  MaintenanceUpdate,
  ReplaceAuthority,
  Transaction,
  UnshieldedOffer,
  communicationCommitmentRandomness,
  nativeToken,
  sampleContractAddress,
  sampleSigningKey,
  signatureVerifyingKey,
  type ProvingProvider,
  type UtxoOutput,
  type UtxoSpend,
} from '@midnightntwrk/wallet-sdk/ledger/v8';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import {ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import {
  decodeConnectorTransaction,
  summarizeConnectorTransaction,
  summarizeTransaction,
} from '../../../src/sync/tx-summary.js';
import {forks} from '../../../src/sync/ledger-routing.js';

// A version on each side of the v9 fork, naming which ledger authored the bytes.
const V8 = ProtocolVersion.MinSupportedVersion;
const V9 = forks.v9;

const NO_CONTRACT_ACTIONS = {contractActions: 0, contractCalls: 0, contractDeploys: 0, maintenanceUpdates: 0};

const OWNER = 'be5eb2579464f606ed883d18831617302f484e6ce3602b0e2725801b653cd19d';
const OTHER_TOKEN = 'ab'.repeat(32);

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

/** The same unfunded-output fixture, authored by ledger-v9. */
async function unsealedV9Tx(outputs: ledgerV9.UtxoOutput[]): Promise<Uint8Array> {
  const intent = ledgerV9.Intent.new(new Date(Date.now() + 60_000));
  intent.fallibleUnshieldedOffer = ledgerV9.UnshieldedOffer.new([], outputs, []);
  const unproven = ledgerV9.Transaction.fromParts('preprod', undefined, undefined, intent);
  const unbound = await unproven.prove(
    {...noProofs, lookupKey: async () => undefined},
    ledgerV9.CostModel.initialCostModel(),
  );
  return unbound.serialize();
}

describe('summarizeConnectorTransaction', () => {
  it('reports an output the dApp left unfunded as a spend from the wallet', async () => {
    const bytes = await unsealedTx([], [{owner: OWNER, type: nativeToken().raw, value: 1_000_000n}]);

    expect(summarizeConnectorTransaction(bytes, false, V8)).toEqual({
      spends: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1_000_000n}],
      receives: [],
      ...NO_CONTRACT_ACTIONS,
    });
  });

  it('reads ledger-v9 bytes at a version from the fork on', async () => {
    const bytes = await unsealedV9Tx([{owner: OWNER, type: ledgerV9.nativeToken().raw, value: 1_000_000n}]);

    expect(summarizeConnectorTransaction(bytes, false, V9)).toEqual({
      spends: [{kind: 'unshielded', tokenId: ledgerV9.nativeToken().raw, amount: 1_000_000n}],
      receives: [],
      ...NO_CONTRACT_ACTIONS,
    });
    // Each ledger version's bytes carry its own header tag, so the other refuses them.
    expect(() => summarizeConnectorTransaction(bytes, false, V8)).toThrow();
  });

  it('decides the ledger from the bytes alone when no version is known', async () => {
    const v8Bytes = await unsealedTx([], [{owner: OWNER, type: nativeToken().raw, value: 5n}]);
    const v9Bytes = await unsealedV9Tx([{owner: OWNER, type: ledgerV9.nativeToken().raw, value: 7n}]);

    expect(summarizeConnectorTransaction(v8Bytes, false).spends).toEqual([
      {kind: 'unshielded', tokenId: nativeToken().raw, amount: 5n},
    ]);
    expect(summarizeConnectorTransaction(v9Bytes, false).spends).toEqual([
      {kind: 'unshielded', tokenId: ledgerV9.nativeToken().raw, amount: 7n},
    ]);
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

    const summary = summarizeConnectorTransaction(bytes, false, V8);
    expect(summary.receives).toEqual([]);
    expect(summary.spends).toHaveLength(2);
    expect(summary.spends).toContainEqual({kind: 'unshielded', tokenId: nativeToken().raw, amount: 1_000_000n});
    expect(summary.spends).toContainEqual({kind: 'unshielded', tokenId: OTHER_TOKEN, amount: 7n});
  });

  it('reports an input without a matching output as change back to the wallet', async () => {
    const bytes = await unsealedTx([nightInput(3_000_000n)], [{owner: OWNER, type: nativeToken().raw, value: 1_000_000n}]);

    expect(summarizeConnectorTransaction(bytes, false, V8)).toEqual({
      spends: [],
      receives: [{kind: 'unshielded', tokenId: nativeToken().raw, amount: 2_000_000n}],
      ...NO_CONTRACT_ACTIONS,
    });
  });

  it('reports nothing for a transaction that is already balanced', async () => {
    const bytes = await unsealedTx([nightInput(1_000_000n)], [{owner: OWNER, type: nativeToken().raw, value: 1_000_000n}]);

    expect(summarizeConnectorTransaction(bytes, false, V8)).toEqual({spends: [], receives: [], ...NO_CONTRACT_ACTIONS});
  });

  it('decodes with the markers the balancing path uses, so the summary matches what gets balanced', async () => {
    const bytes = await unsealedTx([], [{owner: OWNER, type: nativeToken().raw, value: 1n}]);
    const tx = decodeConnectorTransaction(bytes, false, V8);
    expect(summarizeTransaction(tx).spends).toEqual([{kind: 'unshielded', tokenId: nativeToken().raw, amount: 1n}]);
    // A pre-binding transaction is not a bound one; asking for the wrong stage must fail loudly.
    expect(() => decodeConnectorTransaction(bytes, true, V8)).toThrow();
    expect(() => decodeConnectorTransaction(bytes, true)).toThrow();
  });
});

describe('contract actions', () => {
  async function txWithActions(build: (intent: Intent<never, never, never>) => Intent<never, never, never>) {
    const intent = build(Intent.new(new Date(Date.now() + 60_000)) as Intent<never, never, never>);
    const unproven = Transaction.fromParts('preprod', undefined, undefined, intent as never);
    return (await unproven.prove(noProofs, CostModel.initialCostModel())).serialize();
  }

  it('counts a call as a call, not a deploy', () => {
    // Summarized unproven: a real call would need its circuit proven to serialize.
    const empty = {value: [], alignment: []};
    const call = new ContractCallPrototype(
      sampleContractAddress(),
      'mint',
      new ContractOperation(),
      undefined,
      undefined,
      [],
      empty,
      empty,
      communicationCommitmentRandomness(),
      'mint'
    );
    const intent = Intent.new(new Date(Date.now() + 60_000)).addCall(call);
    const tx = Transaction.fromParts('preprod', undefined, undefined, intent);

    expect(summarizeTransaction(tx)).toMatchObject({
      contractActions: 1,
      contractCalls: 1,
      contractDeploys: 0,
      maintenanceUpdates: 0,
    });
  });

  it('counts a deploy as a deploy, not a call', async () => {
    const bytes = await txWithActions((intent) => intent.addDeploy(new ContractDeploy(new ContractState())) as never);

    expect(summarizeConnectorTransaction(bytes, false, V8)).toMatchObject({
      contractActions: 1,
      contractCalls: 0,
      contractDeploys: 1,
      maintenanceUpdates: 0,
    });
  });

  it('counts a ledger-v9 deploy as a deploy', async () => {
    // Each ledger version has its own action classes, so a v9 deploy must not fall through to "unrecognised".
    const intent = ledgerV9.Intent.new(new Date(Date.now() + 60_000)).addDeploy(
      new ledgerV9.ContractDeploy(new ledgerV9.ContractState()),
    );
    const unproven = ledgerV9.Transaction.fromParts('preprod', undefined, undefined, intent);
    const bytes = (
      await unproven.prove({...noProofs, lookupKey: async () => undefined}, ledgerV9.CostModel.initialCostModel())
    ).serialize();

    expect(summarizeConnectorTransaction(bytes, false, V9)).toMatchObject({
      contractActions: 1,
      contractCalls: 0,
      contractDeploys: 1,
      maintenanceUpdates: 0,
    });
  });

  it('counts a maintenance update apart from calls and deploys', async () => {
    const authority = new ContractMaintenanceAuthority([signatureVerifyingKey(sampleSigningKey())], 1);
    const update = new MaintenanceUpdate(sampleContractAddress(), [new ReplaceAuthority(authority)], 0n);
    const bytes = await txWithActions(
      (intent) => intent.addDeploy(new ContractDeploy(new ContractState())).addMaintenanceUpdate(update) as never
    );

    expect(summarizeConnectorTransaction(bytes, false, V8)).toMatchObject({
      contractActions: 2,
      contractCalls: 0,
      contractDeploys: 1,
      maintenanceUpdates: 1,
    });
  });

  // An app that depends on another ledger-v9 version than the SDK pins builds its actions with its own copy of the
  // package, so they are no instances of the classes core loads. Plain objects stand in for them here.
  function txOfActions(actions: ReadonlyArray<object>) {
    return {intents: new Map([[1, {actions}]]), imbalances: () => new Map()} as never;
  }

  it('classifies actions that are no instance of the ledger classes core loads', () => {
    const call = {entryPoint: 'mint'};
    const deploy = {initialState: {}};
    const update = {updates: []};

    expect(summarizeTransaction(txOfActions([deploy, call, update, call]))).toMatchObject({
      contractActions: 4,
      contractCalls: 2,
      contractDeploys: 1,
      maintenanceUpdates: 1,
    });
  });

  it('throws on an action of a kind it does not know, rather than count it as a call', () => {
    expect(() => summarizeTransaction(txOfActions([{entryPoint: 'mint'}, {somethingNew: 1}]))).toThrow(
      /Unrecognised contract action/,
    );
  });
});

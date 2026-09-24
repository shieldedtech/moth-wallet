// Minimal real transactions from either ledger, for tests that need bytes a
// ledger actually reads: one fallible unshielded output and no contract calls.

import * as ledgerV8 from '@midnightntwrk/wallet-sdk/ledger/v8';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';

export const OWNER = 'be5eb2579464f606ed883d18831617302f484e6ce3602b0e2725801b653cd19d';

// With no contract calls, proving only advances the stage marker.
const noProofs = {
  async check(): Promise<never> {
    throw new Error('unexpected proof check');
  },
  async prove(): Promise<never> {
    throw new Error('unexpected proving');
  },
};

/** Proved but not yet bound. */
export async function unboundTransaction(ledger: 'v8' | 'v9'): Promise<{serialize(): Uint8Array; bind(): {serialize(): Uint8Array}}> {
  if (ledger === 'v8') {
    const intent = ledgerV8.Intent.new(new Date(Date.now() + 60_000));
    intent.fallibleUnshieldedOffer = ledgerV8.UnshieldedOffer.new(
      [],
      [{owner: OWNER, type: ledgerV8.nativeToken().raw, value: 1n}],
      [],
    );
    const unproven = ledgerV8.Transaction.fromParts('preprod', undefined, undefined, intent);
    return unproven.prove(noProofs, ledgerV8.CostModel.initialCostModel());
  }
  const intent = ledgerV9.Intent.new(new Date(Date.now() + 60_000));
  intent.fallibleUnshieldedOffer = ledgerV9.UnshieldedOffer.new(
    [],
    [{owner: OWNER, type: ledgerV9.nativeToken().raw, value: 1n}],
    [],
  );
  const unproven = ledgerV9.Transaction.fromParts('preprod', undefined, undefined, intent);
  return unproven.prove({...noProofs, lookupKey: async () => undefined}, ledgerV9.CostModel.initialCostModel());
}

/** Proved and bound: the only shape the network takes. */
export async function finalizedTransaction(ledger: 'v8' | 'v9'): Promise<{serialize(): Uint8Array}> {
  return (await unboundTransaction(ledger)).bind();
}

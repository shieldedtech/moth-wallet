import { Transaction, nativeToken } from '@midnight-ntwrk/ledger-v8';
import { describe, expect, it } from 'vitest';
import { NIGHT_TRANSFER_FIXTURE, createUnbalancedNightTransfer } from './night-transfer-fixture';

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

describe('createUnbalancedNightTransfer', () => {
  it('creates a proof-stage unsealed transaction with a 1 NIGHT deficit', async () => {
    const fixture = await createUnbalancedNightTransfer();
    const transaction = Transaction.deserialize('signature', 'proof', 'pre-binding', fromHex(fixture.tx));
    const intent = transaction.intents?.get(1);
    const offer = intent?.fallibleUnshieldedOffer;
    const nightImbalance = [...transaction.imbalances(1)].find(
      ([type]) => type.tag === 'unshielded' && type.raw === nativeToken().raw,
    )?.[1];

    expect(fixture).toMatchObject({
      amountNight: '1',
      amountRaw: 1_000_000n,
      bindingStage: 'unsealed',
      networkId: 'preprod',
      recipient: NIGHT_TRANSFER_FIXTURE.recipient,
      tokenType: nativeToken().raw,
    });
    expect(fixture.tx).toMatch(/^[0-9a-f]+$/);
    expect(fixture.tx).toHaveLength(fixture.transactionBytes * 2);
    expect(offer?.inputs).toHaveLength(0);
    expect(offer?.outputs).toEqual([
      {
        owner: 'be5eb2579464f606ed883d18831617302f484e6ce3602b0e2725801b653cd19d',
        type: nativeToken().raw,
        value: 1_000_000n,
      },
    ]);
    expect(nightImbalance).toBe(-1_000_000n);
  });
});

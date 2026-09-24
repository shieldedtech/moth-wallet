// submitTransaction takes hex that names no protocol version, so a transaction
// built for the other side of the ledger fork has to be told apart from junk:
// the first is PROTOCOL_VERSION_MISMATCH, the second INVALID_PARAMS.

import {describe, expect, it, vi} from 'vitest';
import {ProtocolVersion, ProtocolVersionMismatchError, WalletTransaction, WireFormatError} from '@midnightntwrk/wallet-sdk';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import {buildWalletHandlers} from '../../../src/daemon/wallet-handlers.js';
import {ConfirmationQueue} from '../../../src/daemon/confirmation-queue.js';
import type {NetworkConfig} from '../../../src/types/network.js';
import type {WalletKeys} from '../../../src/sync/operations.js';
import {finalizedTransaction} from '../../helpers/ledger-transactions.js';

const V9 = ProtocolVersion.ProtocolVersion(9_000_000n);

// What adoptTransaction throws for any bytes its ledger refuses.
const refused = () => {
  throw new WireFormatError({
    message: `These bytes are not a transaction of protocol version ${V9} at stage Finalized`,
  });
};

function submitWith(facade: Partial<WalletFacade>) {
  const handlers = buildWalletHandlers({
    walletName: 'test',
    network: {id: 'preprod'} as NetworkConfig,
    getFacade: () => facade as WalletFacade,
    getWalletKeys: () => ({}) as WalletKeys,
    getBalances: () => null,
    queue: new ConfirmationQueue({autoApprove: true}),
  });
  return (hex: string) => handlers.submitTransaction({hex}, undefined as never);
}

async function hexOf(ledger: 'v8' | 'v9'): Promise<string> {
  return Buffer.from((await finalizedTransaction(ledger)).serialize()).toString('hex');
}

describe('submitTransaction', () => {
  it('answers PROTOCOL_VERSION_MISMATCH for a transaction another ledger wrote', async () => {
    const submit = submitWith({adoptTransaction: vi.fn(refused)});
    await expect(submit(await hexOf('v8'))).rejects.toMatchObject({
      code: 'PROTOCOL_VERSION_MISMATCH',
      message: expect.stringMatching(/^transaction was built with ledger-v8: These bytes are not a transaction of protocol version/),
    });
  });

  it('keeps INVALID_PARAMS for hex no ledger reads', async () => {
    const submit = submitWith({adoptTransaction: vi.fn(refused)});
    await expect(submit('deadbeef')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringMatching(/^failed to deserialize hex as FinalizedTransaction/),
    });
  });

  it('answers PROTOCOL_VERSION_MISMATCH when the wallets cross the fork before submission', async () => {
    const tx = WalletTransaction.adopt('Finalized', await finalizedTransaction('v9'), V9);
    const crossed = new ProtocolVersionMismatchError({
      message: 'built for a version the wallet has left',
      authoredFor: V9,
      accepted: ProtocolVersion.makeRange(ProtocolVersion.ProtocolVersion(V9 + 1n), ProtocolVersion.ProtocolVersion(V9 + 2n)),
      stage: 'Finalized',
    });
    const submit = submitWith({
      adoptTransaction: vi.fn(() => tx) as WalletFacade['adoptTransaction'],
      submitTransaction: vi.fn(async () => {
        throw crossed;
      }),
    });
    await expect(submit(await hexOf('v9'))).rejects.toMatchObject({
      code: 'PROTOCOL_VERSION_MISMATCH',
      message: 'built for a version the wallet has left',
    });
  });
});

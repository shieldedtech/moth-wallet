import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Rx from 'rxjs';
import { ProtocolVersion, WalletTransaction } from '@midnightntwrk/wallet-sdk';
import { WalletFacade } from '@midnightntwrk/wallet-sdk/facade';
import {
  balanceTransaction,
  buildSwapIntent,
  buildTransferTransaction,
  deriveWalletKeys,
  type TokenKindsToBalance,
  type WalletKeys,
} from '../../../src/sync/operations.js';
import { forks, unshieldedPublicKeyAt } from '../../../src/sync/ledger-routing.js';
import { NIGHT_TOKEN_ID } from '../../../src/types/tokens.js';
import { unboundTransaction } from '../../helpers/ledger-transactions.js';
import { VERIFIED_PREPROD_ADDRESS, testSeedHex } from '../../helpers/seed.js';

let keys: WalletKeys;
beforeAll(async () => {
  keys = deriveWalletKeys(await testSeedHex());
});

// Stands in for the handle adoptTransaction reads the dApp's bytes into, so the
// facade sees a known object.
const dappTx = { dapp: true, protocolVersion: ProtocolVersion.MinSupportedVersion };
const adoptTransaction = () => dappTx;
const finalized = { finalized: true };
const nothingToBalance = new Error('No balancing transaction was created. Please check your transaction.');

function facadeWith(methods: Record<string, unknown>) {
  const signRecipe = vi.fn(async (recipe: unknown) => recipe);
  const finalizeRecipe = vi.fn().mockResolvedValue(finalized);
  return {
    facade: { adoptTransaction, signRecipe, finalizeRecipe, ...methods } as unknown as WalletFacade,
    signRecipe,
    finalizeRecipe,
  };
}

describe('buildTransferTransaction payFees', () => {
  const request = { type: 'unshielded' as const, tokenId: NIGHT_TOKEN_ID, amount: 1n, to: VERIFIED_PREPROD_ADDRESS };

  it.each([
    [undefined, { ttl: expect.any(Date) }],
    [{ payFees: false }, { ttl: expect.any(Date), payFees: false }],
    [{ ttl: new Date(1), payFees: true }, { ttl: new Date(1), payFees: true }],
  ])('passes options %o to the facade', async (options, expected) => {
    const transferTransaction = vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION', transaction: {} });
    const { facade } = facadeWith({ transferTransaction });
    await buildTransferTransaction(facade, keys, 'preprod', [request], undefined, options);
    expect(transferTransaction.mock.calls[0]![1]).toEqual(expected);
  });
});

describe('buildSwapIntent', () => {
  it('returns the intent signed, proven and bound, forwarding payFees', async () => {
    const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
    const initSwap = vi.fn().mockResolvedValue(recipe);
    const { facade, signRecipe, finalizeRecipe } = facadeWith({ initSwap });
    const inputs = [{ type: 'unshielded' as const, tokenId: NIGHT_TOKEN_ID, amount: 5n }];
    await expect(buildSwapIntent(facade, keys, 'preprod', inputs, [], undefined, { payFees: false })).resolves.toBe(finalized);
    expect(initSwap.mock.calls[0]![2]).toEqual({ ttl: expect.any(Date), payFees: false });
    expect(signRecipe).toHaveBeenCalledWith(recipe, expect.any(Function));
    expect(finalizeRecipe).toHaveBeenCalledWith(recipe);
  });
});

describe('balanceTransaction tokenKindsToBalance', () => {
  let balanceFinalizedTransaction: ReturnType<typeof vi.fn>;
  let balanceUnboundTransaction: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    balanceFinalizedTransaction = vi.fn().mockResolvedValue({ type: 'FINALIZED_TRANSACTION' });
    balanceUnboundTransaction = vi.fn().mockResolvedValue({ type: 'UNBOUND_TRANSACTION' });
  });

  type BalanceOptions = { tokenKindsToBalance?: TokenKindsToBalance } | undefined;
  it.each<[boolean, BalanceOptions, object]>([
    [true, undefined, { ttl: expect.any(Date) }],
    [true, { tokenKindsToBalance: ['shielded'] }, { ttl: expect.any(Date), tokenKindsToBalance: ['shielded'] }],
    [false, undefined, { ttl: expect.any(Date) }],
    [false, { tokenKindsToBalance: 'all' }, { ttl: expect.any(Date), tokenKindsToBalance: 'all' }],
  ])('sealed=%s passes options %o to the facade', async (sealed, options, expected) => {
    const { facade } = facadeWith({ balanceFinalizedTransaction, balanceUnboundTransaction });
    await expect(
      balanceTransaction(facade, keys, 'preprod', new Uint8Array(), sealed, undefined, options),
    ).resolves.toBe(finalized);
    const balance = sealed ? balanceFinalizedTransaction : balanceUnboundTransaction;
    expect(balance).toHaveBeenCalledWith(dappTx, expected);
  });

  it('returns a sealed transaction unchanged when only the fee was missing', async () => {
    balanceFinalizedTransaction.mockRejectedValue(nothingToBalance);
    const { facade, finalizeRecipe } = facadeWith({ balanceFinalizedTransaction });
    await expect(balanceTransaction(facade, keys, 'preprod', new Uint8Array(), true, undefined, { tokenKindsToBalance: ['shielded', 'unshielded'] })).resolves.toBe(dappTx);
    expect(finalizeRecipe).not.toHaveBeenCalled();
  });

  it('binds an unsealed transaction without a balancing segment when only the fee was missing', async () => {
    balanceUnboundTransaction.mockRejectedValue(nothingToBalance);
    const { facade, finalizeRecipe } = facadeWith({ balanceUnboundTransaction });
    await expect(balanceTransaction(facade, keys, 'preprod', new Uint8Array(), false, undefined, { tokenKindsToBalance: ['shielded', 'unshielded'] })).resolves.toBe(
      finalized,
    );
    expect(finalizeRecipe).toHaveBeenCalledWith({
      type: 'UNBOUND_TRANSACTION',
      protocolVersion: dappTx.protocolVersion,
      baseTransaction: dappTx,
    });
  });

  it.each<BalanceOptions>([undefined, { tokenKindsToBalance: ['dust'] }])(
    'still surfaces the facade error when DUST is balanced (options %o)',
    async (options) => {
      balanceFinalizedTransaction.mockRejectedValue(nothingToBalance);
      const { facade } = facadeWith({ balanceFinalizedTransaction });
      await expect(
        balanceTransaction(facade, keys, 'preprod', new Uint8Array(), true, undefined, options),
      ).rejects.toBe(nothingToBalance);
    },
  );
});

// Runs the SDK's own balancing with sub-wallets that find nothing to do, so a
// reworded "nothing to balance" error fails here rather than in production. The
// facade is really constructed — its balancing calls private members — around a
// real ledger-v9 transaction, which in-place balancing reads its inputs from.
describe('balanceTransaction against the real facade', () => {
  async function realFacade(stage: 'Finalized' | 'Unbound') {
    const unbound = await unboundTransaction('v9');
    const tx = WalletTransaction.adopt(stage, stage === 'Finalized' ? unbound.bind() : unbound, forks.v9);
    const { publicKey } = unshieldedPublicKeyAt(forks.v9, keys.unshielded, 'preprod');
    const unshieldedState = Rx.of({ state: { publicKey: { publicKey }, progress: { isStrictlyComplete: () => false } } });
    // Private in the typings; WalletFacade.init calls it with these, in this order.
    const Facade = WalletFacade as unknown as new (...args: unknown[]) => WalletFacade;
    const facade = new Facade(
      { state: Rx.NEVER, balanceTransaction: vi.fn().mockResolvedValue(undefined) },
      {
        state: unshieldedState,
        balanceFinalizedTransaction: vi.fn().mockResolvedValue(undefined),
        balanceUnboundTransaction: vi.fn().mockResolvedValue(undefined),
      },
      { state: Rx.NEVER, balanceTransactions: vi.fn() },
      {}, // submission
      { state: () => Rx.NEVER }, // pending transactions
      {}, // proving
      {}, // validation
      {}, // transaction history
      forks.v9,
    );
    const finalizeRecipe = vi.fn().mockResolvedValue(finalized);
    Object.assign(facade, {
      adoptTransaction: () => tx,
      signRecipe: vi.fn(async (recipe: unknown) => recipe),
      finalizeRecipe,
    });
    return { facade, tx, finalizeRecipe };
  }
  const noFees = { tokenKindsToBalance: ['shielded', 'unshielded'] as TokenKindsToBalance };

  it('returns a sealed transaction unchanged', async () => {
    const { facade, tx } = await realFacade('Finalized');
    await expect(balanceTransaction(facade, keys, 'preprod', new Uint8Array(), true, undefined, noFees)).resolves.toBe(
      tx,
    );
  });

  it('binds an unsealed transaction without a balancing segment', async () => {
    const { facade, tx, finalizeRecipe } = await realFacade('Unbound');
    await balanceTransaction(facade, keys, 'preprod', new Uint8Array(), false, undefined, noFees);
    expect(finalizeRecipe).toHaveBeenCalledWith({
      type: 'UNBOUND_TRANSACTION',
      protocolVersion: tx.protocolVersion,
      baseTransaction: tx,
    });
  });
});

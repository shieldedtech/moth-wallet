import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Rx from 'rxjs';
import type { UtxoWithMeta, WalletFacade } from '@midnightntwrk/wallet-sdk/facade';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format';
import {
  designateForDust,
  dedesignateFromDust,
  deriveWalletKeys,
  estimateTransferFee,
  listNightUtxos,
  type TxStage,
  type WalletKeys,
} from '../../../src/sync/operations.js';
import { deriveAllAddressesFromSeed } from '../../../src/wallet/address.js';
import { NIGHT_TOKEN_ID } from '../../../src/types/tokens.js';
import { VERIFIED_PREPROD_ADDRESS as PREPROD_ADDRESS, testSeedHex } from '../../helpers/seed.js';

let seedHex: string;
// Pre-derived key bundle (Option A). The seed-based ops derive this internally
// via their seedHex wrappers; the keys-based connector helpers take it directly.
let keys: WalletKeys;

beforeAll(async () => {
  seedHex = await testSeedHex();
  keys = deriveWalletKeys(seedHex);
});

/** A fresh faucet-funded wallet can have complete NIGHT state while the facade
 * aggregate remains unsynced because its shielded and DUST streams are empty. */
function freshWalletFacade(
  availableCoins: UtxoWithMeta[] = [],
  methods: Partial<WalletFacade> = {},
): WalletFacade {
  return {
    state: () =>
      Rx.of({
        isSynced: false,
        unshielded: {
          progress: { isStrictlyComplete: () => true },
          availableCoins,
        },
      }),
    ...methods,
  } as unknown as WalletFacade;
}

describe('DUST operations on a fresh wallet', () => {
  it('lists NIGHT UTXOs once unshielded sync is complete', async () => {
    await expect(listNightUtxos(freshWalletFacade())).resolves.toEqual([]);
  });

  it('does not wait for aggregate sync before registration', async () => {
    await expect(designateForDust(freshWalletFacade(), seedHex, 'devnet')).resolves.toBeNull();
  });

  it('builds, proves, and submits once unshielded sync is complete', async () => {
    const coin = {
      utxo: { type: NIGHT_TOKEN_ID, value: 1n },
      meta: { ctime: new Date(), registeredForDustGeneration: false },
    } as UtxoWithMeta;
    const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
    const finalized = { identifiers: () => ['tx-id'], transactionHash: () => 'tx-hash' };
    const registerNightUtxosForDustGeneration = vi.fn().mockResolvedValue(recipe);
    const finalizeRecipe = vi.fn().mockResolvedValue(finalized);
    // The facade resolves to an intent identifier — the submit path must
    // discard it and report the transaction hash (what history/indexer use).
    const submitTransaction = vi.fn().mockResolvedValue('tx-id');
    const stages: TxStage[] = [];
    const facade = freshWalletFacade([coin], {
      registerNightUtxosForDustGeneration,
      finalizeRecipe,
      submitTransaction,
    } as unknown as Partial<WalletFacade>);

    await expect(
      designateForDust(facade, seedHex, 'devnet', undefined, (stage) => stages.push(stage)),
    ).resolves.toBe('tx-hash');
    // The fourth argument is the DUST receiver. It used to be undefined, which
    // let the SDK derive "my own DUST address" for the network the WALLET was
    // created against rather than the one being registered on — a devnet-encoded
    // receiver handed to preview's node, which refused it. It is now derived
    // here, from the keys in hand and the network in the request.
    expect(registerNightUtxosForDustGeneration).toHaveBeenCalledWith(
      [coin],
      expect.anything(),
      expect.any(Function),
      expect.anything(),
    );
    const receiver = registerNightUtxosForDustGeneration.mock.calls[0]![3];
    expect(receiver, 'a derived receiver, not the SDK default').toBeDefined();
    // And it is THIS wallet's DUST address for the network being registered on —
    // which is the entire point, since the SDK's own default derives it for
    // whichever network the wallet was created against.
    expect(MidnightBech32m.encode('devnet', receiver as never).toString()).toBe(
      deriveAllAddressesFromSeed(seedHex).dust.bech32m.devnet,
    );
    expect(finalizeRecipe).toHaveBeenCalledWith(recipe);
    expect(submitTransaction).toHaveBeenCalledWith(finalized);
    expect(stages).toEqual(['building', 'proving', 'submitting']);
  });

  it('treats a "Transaction Already Imported" rejection as success', async () => {
    const coin = {
      utxo: { type: NIGHT_TOKEN_ID, value: 1n },
      meta: { ctime: new Date(), registeredForDustGeneration: false },
    } as UtxoWithMeta;
    const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
    const finalized = { identifiers: () => ['tx-id'], transactionHash: () => 'tx-hash' };
    // The pool already holds this tx (a prior attempt landed); the node rejects
    // the resubmitted identical bytes with 1013 rather than accepting it again.
    const submitTransaction = vi
      .fn()
      .mockRejectedValue(new Error('1013: Transaction Already Imported'));
    const facade = freshWalletFacade([coin], {
      registerNightUtxosForDustGeneration: vi.fn().mockResolvedValue(recipe),
      finalizeRecipe: vi.fn().mockResolvedValue(finalized),
      submitTransaction,
    } as unknown as Partial<WalletFacade>);

    await expect(designateForDust(facade, seedHex, 'devnet')).resolves.toBe('tx-hash');
    // Not retried — the tx is already accepted, so one attempt is enough.
    expect(submitTransaction).toHaveBeenCalledTimes(1);
  });

  it('reflects a deterministic node rejection immediately, without retrying', async () => {
    const coin = {
      utxo: { type: NIGHT_TOKEN_ID, value: 1n },
      meta: { ctime: new Date(), registeredForDustGeneration: false },
    } as UtxoWithMeta;
    const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
    const finalized = { identifiers: () => ['tx-id'], transactionHash: () => 'tx-hash' };
    // The node evaluated the tx and rejected it — resending the same bytes only
    // yields the same verdict, so the user should see the failure at once.
    const submitTransaction = vi.fn().mockRejectedValue(new Error('1010: Invalid Transaction'));
    const facade = freshWalletFacade([coin], {
      registerNightUtxosForDustGeneration: vi.fn().mockResolvedValue(recipe),
      finalizeRecipe: vi.fn().mockResolvedValue(finalized),
      submitTransaction,
    } as unknown as Partial<WalletFacade>);

    await expect(designateForDust(facade, seedHex, 'devnet')).rejects.toThrow('Invalid Transaction');
    expect(submitTransaction).toHaveBeenCalledTimes(1);
  });

  it('resends after a transient connection failure', async () => {
    vi.useFakeTimers();
    try {
      const coin = {
        utxo: { type: NIGHT_TOKEN_ID, value: 1n },
        meta: { ctime: new Date(), registeredForDustGeneration: false },
      } as UtxoWithMeta;
      const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
      const finalized = { identifiers: () => ['tx-id'], transactionHash: () => 'tx-hash' };
      // First attempt never reached the node; a resend is warranted.
      const submitTransaction = vi
        .fn()
        .mockRejectedValueOnce(new Error('WebSocket is not connected'))
        .mockResolvedValueOnce('tx-id');
      const facade = freshWalletFacade([coin], {
        registerNightUtxosForDustGeneration: vi.fn().mockResolvedValue(recipe),
        finalizeRecipe: vi.fn().mockResolvedValue(finalized),
        submitTransaction,
      } as unknown as Partial<WalletFacade>);

      const promise = designateForDust(facade, seedHex, 'devnet');
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(promise).resolves.toBe('tx-hash');
      expect(submitTransaction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for aggregate sync before deregistration', async () => {
    await expect(dedesignateFromDust(freshWalletFacade(), seedHex, 'devnet')).rejects.toThrow(
      'No registered NIGHT UTXOs to deregister',
    );
  });

  it('rejects an invalid DUST receiver instead of silently using the default', async () => {
    const coin = {
      utxo: { type: NIGHT_TOKEN_ID, value: 1n },
      meta: { ctime: new Date(), registeredForDustGeneration: false },
    } as UtxoWithMeta;
    const registerNightUtxosForDustGeneration = vi.fn();
    const facade = freshWalletFacade([coin], {
      registerNightUtxosForDustGeneration,
    } as unknown as Partial<WalletFacade>);

    await expect(
      designateForDust(facade, seedHex, 'devnet', 'mn_dust_devnet1notarealaddress'),
    ).rejects.toThrow('Invalid DUST address');
    expect(registerNightUtxosForDustGeneration).not.toHaveBeenCalled();
  });

  it('passes a valid DUST receiver through to the facade', async () => {
    const coin = {
      utxo: { type: NIGHT_TOKEN_ID, value: 1n },
      meta: { ctime: new Date(), registeredForDustGeneration: false },
    } as UtxoWithMeta;
    const receiver = deriveAllAddressesFromSeed(seedHex).dust.bech32m['devnet']!;
    const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
    const finalized = { identifiers: () => ['tx-id'], transactionHash: () => 'tx-hash' };
    const registerNightUtxosForDustGeneration = vi.fn().mockResolvedValue(recipe);
    const facade = freshWalletFacade([coin], {
      registerNightUtxosForDustGeneration,
      finalizeRecipe: vi.fn().mockResolvedValue(finalized),
      submitTransaction: vi.fn().mockResolvedValue('tx-id'),
    } as unknown as Partial<WalletFacade>);

    await expect(designateForDust(facade, seedHex, 'devnet', receiver)).resolves.toBe('tx-hash');
    const dustReceiver = registerNightUtxosForDustGeneration.mock.calls[0]![3];
    expect(dustReceiver).toBeDefined();
  });

  it('deregisters registered NIGHT: build, balance, finalize, submit', async () => {
    const coin = {
      utxo: { type: NIGHT_TOKEN_ID, value: 1n },
      meta: { ctime: new Date(), registeredForDustGeneration: true },
    } as UtxoWithMeta;
    const recipe = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
    const balanced = { type: 'UNPROVEN_TRANSACTION', transaction: {} };
    const finalized = { identifiers: () => ['tx-id'], transactionHash: () => 'tx-hash' };
    const deregisterFromDustGeneration = vi.fn().mockResolvedValue(recipe);
    const balanceUnprovenTransaction = vi.fn().mockResolvedValue(balanced);
    const finalizeRecipe = vi.fn().mockResolvedValue(finalized);
    const facade = freshWalletFacade([coin], {
      deregisterFromDustGeneration,
      balanceUnprovenTransaction,
      finalizeRecipe,
      submitTransaction: vi.fn().mockResolvedValue('tx-id'),
    } as unknown as Partial<WalletFacade>);

    await expect(dedesignateFromDust(facade, seedHex, 'devnet')).resolves.toBe('tx-hash');
    expect(deregisterFromDustGeneration).toHaveBeenCalledWith([coin], expect.anything(), expect.any(Function));
    expect(balanceUnprovenTransaction).toHaveBeenCalledWith(recipe.transaction, expect.anything(), expect.anything());
    expect(finalizeRecipe).toHaveBeenCalledWith(balanced);
  });
});

describe('transfer fee estimation', () => {
  const request = {
    type: 'unshielded' as const,
    tokenId: NIGHT_TOKEN_ID,
    amount: 1_000_000n,
    to: PREPROD_ADDRESS,
  };

  it('uses the facade total-fee estimate without booking fee inputs', async () => {
    const transaction = {};
    const transferTransaction = vi.fn().mockResolvedValue({
      type: 'UNPROVEN_TRANSACTION',
      transaction,
    });
    const estimateTransactionFee = vi.fn().mockResolvedValue(125_000_000_000_000n);
    const revertTransaction = vi.fn().mockResolvedValue(undefined);
    const facade = freshWalletFacade([], {
      transferTransaction,
      estimateTransactionFee,
      revertTransaction,
    } as unknown as Partial<WalletFacade>);

    await expect(
      estimateTransferFee(facade, keys, 'preprod', [request]),
    ).resolves.toBe(125_000_000_000_000n);

    const transferOptions = transferTransaction.mock.calls[0]![2];
    expect(transferOptions).toEqual({ ttl: expect.any(Date), payFees: false });
    // The fee estimate is booked against the DUST secret key, not the shielded
    // keys — assert the exact key so a mis-wired bundle can't slip through.
    expect(estimateTransactionFee).toHaveBeenCalledWith(
      transaction,
      keys.dustSecretKey,
      { ttl: transferOptions.ttl },
    );
    expect(revertTransaction).toHaveBeenCalledWith(transaction);
  });

  it('reverts the temporary transfer when estimation fails', async () => {
    const transaction = {};
    const revertTransaction = vi.fn().mockResolvedValue(undefined);
    const facade = freshWalletFacade([], {
      transferTransaction: vi.fn().mockResolvedValue({
        type: 'UNPROVEN_TRANSACTION',
        transaction,
      }),
      estimateTransactionFee: vi.fn().mockRejectedValue(new Error('estimate unavailable')),
      revertTransaction,
    } as unknown as Partial<WalletFacade>);

    await expect(estimateTransferFee(facade, keys, 'preprod', [request])).rejects.toThrow(
      'estimate unavailable',
    );
    expect(revertTransaction).toHaveBeenCalledWith(transaction);
  });
});

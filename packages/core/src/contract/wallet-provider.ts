// The midnight-js wallet and midnight providers over a moth WalletFacade.
//
// midnight-js 5 hands transactions over as era-tagged handles. The facade reads their
// bytes with the ledger it is acting at, so one handler serves both eras and refuses a
// handle from an era the chain has left.

import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import type {UnshieldedKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import type {
  createMidnightProviderFromHandlers,
  createWalletProviderFromHandlers,
  MidnightProvider,
  WalletProvider,
} from '@midnight-ntwrk/midnight-js/types';
import {WalletError} from '../types/errors.js';
import {deriveWalletKeys, type WalletKeys} from '../sync/operations.js';

/**
 * The midnight-js factories the providers are built with. midnight-js takes a
 * handle only from its own installed copy, so they come from the copy the
 * contract operation runs on.
 */
export interface ContractProviderFactories {
  readonly createWalletProviderFromHandlers: typeof createWalletProviderFromHandlers;
  readonly createMidnightProviderFromHandlers: typeof createMidnightProviderFromHandlers;
}

export interface ContractWalletProviderOptions {
  facade: WalletFacade;
  /** Signs the wallet's unshielded inputs in the balanced transaction. */
  keystore: UnshieldedKeystore;
  coinPublicKey: string;
  encryptionPublicKey: string;
  factories: ContractProviderFactories;
}

/**
 * The unshielded signing secret for a contract operation: the pre-derived
 * walletKeys (daemon path), else derived from seedHex (in-process CLI path).
 * See docs/spec/wallet-service/05-key-management.md D-KM-3.
 */
export function unshieldedSecretOf(
  walletKeys: WalletKeys | undefined,
  seedHex: string | undefined,
  operation: string,
): Uint8Array {
  if (walletKeys) return walletKeys.unshielded;
  if (!seedHex) throw new WalletError('WALLET_ERROR', `${operation} requires either walletKeys or seedHex`);
  try {
    return deriveWalletKeys(seedHex).unshielded;
  } catch (err) {
    throw new WalletError('WALLET_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * The wallet provider, which balances and signs a contract transaction through
 * the facade, and the midnight provider, which submits it, each serving both
 * ledger eras.
 */
export function makeContractWalletProviders(options: ContractWalletProviderOptions): {
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
} {
  const {facade, keystore, coinPublicKey, encryptionPublicKey, factories} = options;
  const balance = async (tx: {serialize(): Uint8Array}, ttl?: Date): Promise<Uint8Array> => {
    const recipe = await facade.balanceUnboundTransaction(facade.adoptTransaction(tx.serialize(), 'Unbound'), {
      ttl: ttl ?? new Date(Date.now() + 30 * 60_000),
    });
    const signed = await facade.signRecipe(recipe, keystore.signDataAsync);
    return (await facade.finalizeRecipe(signed)).serialize();
  };
  const submit = (tx: {serialize(): Uint8Array}): Promise<string> =>
    facade.submitTransaction(facade.adoptTransaction(tx.serialize(), 'Finalized'));
  return {
    walletProvider: factories.createWalletProviderFromHandlers({
      v8: balance,
      v9: balance,
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encryptionPublicKey,
    }),
    midnightProvider: factories.createMidnightProviderFromHandlers({v8: submit, v9: submit}),
  };
}

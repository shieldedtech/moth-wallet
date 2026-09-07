// The midnight-js wallet/midnight provider pair over a moth WalletFacade.
//
// midnight-js 4.1.1 authors ledger-v8 transactions, while the facade speaks in
// handles stamped with a protocol version. What midnight-js hands over is sealed
// at the version the wallets are acting at, and what comes back is unwrapped for
// it. A chain that has handed over to ledger-v9 can never include a ledger-v8
// transaction, so such a network is refused before anything is built.

import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {WalletTransaction, type ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import type {UnshieldedKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {WalletError} from '../types/errors.js';
import {isLedgerV9, unwrapTransaction} from '../sync/ledger-routing.js';
import {deriveWalletKeys, type WalletKeys} from '../sync/operations.js';

/** A proven, unbound ledger-v8 transaction, as midnight-js hands it over for balancing. */
export type V8UnboundTransaction = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;

export interface ContractWalletProvider {
  getCoinPublicKey(): string;
  getEncryptionPublicKey(): string;
  balanceTx(tx: V8UnboundTransaction, ttl?: Date): Promise<ledger.FinalizedTransaction>;
  submitTx(tx: ledger.FinalizedTransaction): Promise<string>;
}

export interface ContractWalletProviderOptions {
  facade: WalletFacade;
  /** Signs the wallet's unshielded inputs in the balanced transaction. */
  keystore: UnshieldedKeystore;
  /** The version the wallets are acting at, which every transaction built here is stamped with. */
  protocolVersion: ProtocolVersion.ProtocolVersion;
  coinPublicKey: string;
  encryptionPublicKey: string;
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

export function makeContractWalletProvider(options: ContractWalletProviderOptions): ContractWalletProvider {
  const {facade, keystore, protocolVersion, coinPublicKey, encryptionPublicKey} = options;
  if (isLedgerV9(protocolVersion)) {
    throw new WalletError(
      'WALLET_ERROR',
      `Contract operations author ledger-v8 transactions, but this network is at protocol version ` +
        `${protocolVersion} and runs ledger-v9, which cannot include them.`,
    );
  }
  return {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,
    async balanceTx(tx, ttl) {
      const recipe = await facade.balanceUnboundTransaction(WalletTransaction.adopt('Unbound', tx, protocolVersion), {
        ttl: ttl ?? new Date(Date.now() + 30 * 60_000),
      });
      const signed = await facade.signRecipe(recipe, keystore.signDataAsync);
      return unwrapTransaction<ledger.FinalizedTransaction>(await facade.finalizeRecipe(signed));
    },
    submitTx: (tx) => facade.submitTransaction(WalletTransaction.adopt('Finalized', tx, protocolVersion)),
  };
}

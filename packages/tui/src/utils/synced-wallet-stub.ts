// Deploy and mint operations take a SyncedWallet but only consume its
// facade — balancing happens inside core. This stub wraps a live facade
// with balances that report fully-synced state (deploy/mint require a
// synced wallet, so this is deliberately distinct from core's 0%
// EMPTY_STATE defaults); the coin and sub-progress shapes reuse the
// shared empty constants.

import {
  EMPTY_COINS,
  EMPTY_SUB_PROGRESS,
  type SyncedWallet,
  type WalletBalances,
} from '@shieldedtech/moth-wallet';

export function syncedWalletStub(facade: SyncedWallet['facade']): SyncedWallet {
  const balances: WalletBalances = {
    shielded: {},
    unshielded: {},
    dust: 0n,
    dustGeneration: null,
    syncProgress: {
      percentage: 1,
      etaSeconds: 0,
      // Nothing is behind in a fully-synced stub.
      slowest: null,
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: true,
    },
    synced: true,
    coins: EMPTY_COINS,
    subProgress: EMPTY_SUB_PROGRESS,
  };
  return {
    facade,
    balances,
    stop: async () => {},
    refresh: async () => balances,
    subscribe: () => () => {},
  };
}

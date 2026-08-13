export type { NetworkConfig, NetworkEndpoints, ProverConfig } from './network.js';
export type {
  WalletInfo,
  WalletAddresses,
  AddressEncoding,
  UnlockedWallet,
  DerivedKeys,
  SyncState,
} from './wallet.js';
export type { TransactionResult } from './transaction.js';
export { ExitCode } from './exit-codes.js';
export {
  WalletError,
  NetworkError,
  ProofError,
  TimeoutError,
  InvalidInputError,
  type WalletErrorCategory,
} from './errors.js';

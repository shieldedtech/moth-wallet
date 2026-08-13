/** Only the top-level route remains a "screen" — sub-views live inside the dashboard hub. */
export type Screen = 'dashboard';

export interface WalletState {
  name: string;
  address: string;
  nightBalance: string;
  dustBalance: string;
  synced: boolean;
  syncProgress: number;
}

export interface NetworkState {
  id: string;
  nodeUrl: string;
  indexerUrl: string;
  proverType: 'server' | 'wasm';
  proofServerUrl: string;
  blockHeight: number;
  connected: boolean;
}

export interface TxProgress {
  status: 'idle' | 'building' | 'proving' | 'submitting' | 'confirming' | 'done' | 'error';
  message: string;
  txHash?: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

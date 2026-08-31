// Mutable bridge between the `moth mcp` process lifecycle and the tool
// handlers. The MCP handshake must complete in seconds while the first
// wallet sync can take minutes, so the command connects the transport
// first and attaches the SyncedWallet here once startWalletSync
// resolves. Tools read whatever is attached at call time.
//
// `balances.synced` flip-flops back to false whenever new blocks arrive
// (see packages/cli/tests/integration/daemon/helpers.ts) — so the
// runtime latches `everSynced` the first time it observes synced=true,
// and "has this wallet ever reached the tip" is the question
// waitForSynced answers.

import type {
  NetworkConfig,
  RpcHandler,
  SyncProgress,
  SyncedWallet,
  UnlockedWallet,
  WalletBalances,
  WalletKeys,
} from '@shieldedtech/moth-wallet';

/** 'starting' = startWalletSync still initializing; 'ready' = facade
 *  live (sync may still be catching up); 'failed' = sync setup threw. */
export type McpSyncState = 'starting' | 'ready' | 'failed';

export interface WaitForSyncResult {
  readonly synced: boolean;
  readonly everSynced: boolean;
  readonly elapsedMs: number;
  readonly syncProgress: SyncProgress | null;
  readonly syncState: McpSyncState;
}

export interface WalletRuntime {
  readonly walletName: string;
  readonly network: NetworkConfig;
  readonly unlocked: UnlockedWallet;
  /** The wallet's shielded (zswap) public identity — 64-char hex each.
   *  dApp endpoints that build a shielded output to this wallet need
   *  these, not just the bech32m address. Derived once at startup. */
  readonly shieldedKeys: {readonly coinPublicKey: string; readonly encryptionPublicKey: string};
  readonly syncState: McpSyncState;
  readonly syncError: string | null;
  readonly everSynced: boolean;
  getSynced(): SyncedWallet | null;
  getFacade(): SyncedWallet['facade'] | null;
  getBalances(): WalletBalances | null;
  getWalletKeys(): WalletKeys;
  /** Resolves once synced=true has been observed at least once, or on
   *  timeout — never rejects. Also covers the pre-facade window while
   *  startWalletSync is still initializing. */
  waitForSynced(timeoutMs: number): Promise<WaitForSyncResult>;
  /** Daemon verb handlers (buildWalletHandlers) — assigned by the
   *  command after construction, since the handler deps close over
   *  this runtime's getters. */
  handlers: Record<string, RpcHandler>;
  attachSynced(s: SyncedWallet): void;
  markFailed(message: string): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

export function createWalletRuntime(opts: {
  walletName: string;
  network: NetworkConfig;
  unlocked: UnlockedWallet;
  shieldedKeys: {coinPublicKey: string; encryptionPublicKey: string};
  /** Fired once, the first time the wallet reports synced=true. */
  onFirstSynced?: () => void;
}): WalletRuntime {
  let synced: SyncedWallet | null = null;
  let syncState: McpSyncState = 'starting';
  let syncError: string | null = null;
  let everSynced = false;

  const snapshot = (start: number): WaitForSyncResult => {
    const b = synced?.balances ?? null;
    return {
      synced: b?.synced ?? false,
      everSynced,
      elapsedMs: Date.now() - start,
      syncProgress: b?.syncProgress ?? null,
      syncState,
    };
  };

  const runtime: WalletRuntime = {
    walletName: opts.walletName,
    network: opts.network,
    unlocked: opts.unlocked,
    shieldedKeys: opts.shieldedKeys,
    get syncState() {
      return syncState;
    },
    get syncError() {
      return syncError;
    },
    get everSynced() {
      return everSynced;
    },
    getSynced: () => synced,
    getFacade: () => synced?.facade ?? null,
    getBalances: () => synced?.balances ?? null,
    getWalletKeys: () => opts.unlocked.walletKeys,
    handlers: {},

    attachSynced(s: SyncedWallet): void {
      synced = s;
      syncState = 'ready';
      // Permanent subscription that latches everSynced. subscribe()
      // fires immediately with the current snapshot, so a wallet that
      // is already at the tip latches right here.
      s.subscribe((b: WalletBalances) => {
        if (b.synced && !everSynced) {
          everSynced = true;
          opts.onFirstSynced?.();
        }
      });
    },

    markFailed(message: string): void {
      syncState = 'failed';
      syncError = message;
    },

    async waitForSynced(timeoutMs: number): Promise<WaitForSyncResult> {
      const start = Date.now();
      const deadline = start + timeoutMs;

      // Phase 1: wait out the pre-facade window (startWalletSync still
      // initializing). Cheap poll — this window is seconds, not minutes.
      while (!synced && syncState === 'starting' && Date.now() < deadline) {
        await sleep(250);
      }
      const s = synced;
      if (!s || everSynced) return snapshot(start);

      // Phase 2: subscribe until synced flips true or the deadline hits.
      await new Promise<void>((resolveOuter) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            unsub();
          } catch {
            /* idempotent */
          }
          clearTimeout(timer);
          resolveOuter();
        };
        const unsub = s.subscribe((b: WalletBalances) => {
          if (b.synced) finish();
        });
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        timer.unref();
      });
      return snapshot(start);
    },
  };

  return runtime;
}

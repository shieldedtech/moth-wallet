// Read wallet state from the running TUI's daemon socket instead of
// spinning up a parallel sync. Requires the TUI to be running with the
// target wallet selected on the same network — there's no fallback to
// in-process sync here because the whole point of this command is to
// avoid the resync cost.

import {BaseCommand, daemonClientFlags} from '../../base-command.js';

interface DaemonStateResult {
  ready: boolean;
  walletName?: string;
  networkId?: string;
  synced?: boolean;
  syncProgress?: {
    percentage: number;
    etaSeconds: number | null;
    shieldedSynced: boolean;
    unshieldedSynced: boolean;
    dustSynced: boolean;
  };
  balances?: {
    shielded: Record<string, string>;
    unshielded: Record<string, string>;
    dust: string;
  };
}

export default class WalletStatus extends BaseCommand {
  static override description =
    "Show the running TUI's view of a wallet's sync progress and balances. Talks to the TUI daemon socket — does not start its own sync, so this is fast and won't fight the TUI for the cache.";

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(WalletStatus);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const state = (await client.call<DaemonStateResult>('getState')) ?? {ready: false};

      if (this.outputFormat === 'json') {
        this.outputSuccess({...state, daemonVersion: client.daemonVersion});
        return;
      }

      // Text mode — human summary.
      this.log(`Wallet: ${state.walletName ?? walletName}`);
      this.log(`Network: ${state.networkId ?? network.id}`);
      this.log(`Daemon: ${client.daemonVersion}`);
      if (!state.ready) {
        this.log(
          'Status: TUI is running but the wallet facade is still initializing. The wallet may be unlocking, syncing, or in onboarding — give it a moment and retry.',
        );
        return;
      }
      const pct = state.syncProgress
        ? Math.round(state.syncProgress.percentage * 100)
        : 0;
      const eta = state.syncProgress?.etaSeconds;
      const etaStr =
        eta === null || eta === undefined
          ? ''
          : ` (~${Math.max(0, Math.round(eta))}s remaining)`;
      this.log(`Status: ${state.synced ? '● synced' : `○ syncing ${pct}%${etaStr}`}`);
      if (state.balances) {
        this.log('');
        this.log('Balances (raw, SPECK units):');
        const fmtMap = (m: Record<string, string>) =>
          Object.entries(m)
            .map(([k, v]) => `  ${k.slice(0, 16)}…  ${v}`)
            .join('\n') || '  (none)';
        this.log(`  shielded:`);
        this.log(fmtMap(state.balances.shielded));
        this.log(`  unshielded:`);
        this.log(fmtMap(state.balances.unshielded));
        this.log(`  dust: ${state.balances.dust}`);
      }
    } finally {
      client.close();
    }
  }
}

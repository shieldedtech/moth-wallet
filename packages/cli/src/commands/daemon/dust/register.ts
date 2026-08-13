// Register the wallet's NIGHT UTXOs for DUST generation through the
// running TUI daemon. The TUI handles the full pipeline (select
// UTXOs, build, sign, submit). Spending keys never leave the TUI.
// Triggers an L3 confirmation modal showing the wallet, the dust
// receiver (default: this wallet), and that every unregistered NIGHT
// UTXO will be registered.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

interface RegisterResult {
  txId: string | null;
  registered: boolean;
}

export default class DaemonDustRegister extends BaseCommand {
  static override description =
    'Register NIGHT UTXOs for DUST generation via the running TUI daemon. Registers every currently-unregistered NIGHT UTXO. Returns null txId when there\'s nothing to register.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    receiver: Flags.string({
      description: 'Dust receiver address (default: this wallet\'s own dust address)',
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 300000)',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonDustRegister);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const state = await client.call<{ready: boolean}>('getState');
      if (!state.ready) {
        this.outputError(
          'WALLET_ERROR',
          `TUI is running but the wallet facade for "${walletName}" is still initializing on ${network.id}. Wait for sync and retry.`,
        );
        this.exit(1);
        return;
      }

      const result = await client.call<RegisterResult>(
        'dustRegister',
        {receiver: flags.receiver},
        {timeoutMs: flags['timeout-ms']},
      );

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else if (result.registered) {
        this.log(`Registered. Transaction id: ${result.txId}`);
      } else {
        this.log('No unregistered NIGHT UTXOs — nothing to do.');
      }
    } catch (err) {
      const {category, message} = this.renderDaemonError(err);
      this.outputError(category, message);
      this.exit(1);
      return;
    } finally {
      client.close();
    }
  }
}

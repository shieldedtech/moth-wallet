// Deregister the wallet's NIGHT UTXOs from DUST generation through
// the running TUI daemon. Reverses dustRegister. The TUI handles the
// full pipeline. Triggers an L3 confirmation modal warning that DUST
// will stop generating from these UTXOs.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

interface DeregisterResult {
  txId: string;
}

export default class DaemonDustDeregister extends BaseCommand {
  static override description =
    'Deregister NIGHT UTXOs from DUST generation via the running TUI daemon. Deregisters every currently-registered NIGHT UTXO. DUST stops generating from these UTXOs afterward.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 300000)',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonDustDeregister);
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

      const result = await client.call<DeregisterResult>(
        'dustDeregister',
        {},
        {timeoutMs: flags['timeout-ms']},
      );

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Deregistered. Transaction id: ${result.txId}`);
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

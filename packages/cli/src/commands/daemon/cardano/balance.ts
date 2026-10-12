// Show ADA and cNIGHT held on Cardano, read through the running daemon.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

export default class DaemonCardanoBalance extends BaseCommand {
  static override description = 'Show ADA and cNIGHT held on Cardano via the running daemon.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 120000)',
      default: 120_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonCardanoBalance);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      this.outputSuccess(
        await client.call<Record<string, unknown>>('cardanoBalance', null, {
          timeoutMs: flags['timeout-ms'],
        }),
      );
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

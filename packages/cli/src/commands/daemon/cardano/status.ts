// Read cNIGHT holdings and DUST designation state through the running
// daemon. The daemon is the process holding the mnemonic, so this command
// carries no key material of its own.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

export default class DaemonCardanoStatus extends BaseCommand {
  static override description =
    'Show cNIGHT holdings and DUST designation status via the running daemon.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 120000)',
      default: 120_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonCardanoStatus);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const result = await client.call<Record<string, unknown>>(
        'cardanoStatus',
        null,
        {timeoutMs: flags['timeout-ms']},
      );
      this.outputSuccess(result);
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

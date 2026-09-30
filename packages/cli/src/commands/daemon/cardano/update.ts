// Point an existing cNIGHT registration at a different Midnight address,
// through the running daemon.

import {Args, Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

export default class DaemonCardanoUpdate extends BaseCommand {
  static override description =
    'Point an existing cNIGHT registration at a different Midnight address via the running daemon.';

  static override args = {
    receiver: Args.string({
      description: 'Midnight coin public key to generate DUST to, 64 hex chars',
      required: true,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 300000)',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const {args, flags} = await this.parse(DaemonCardanoUpdate);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const result = await client.call<{txHash: string; receiver: string}>(
        'cardanoUpdate',
        {receiver: args.receiver},
        {timeoutMs: flags['timeout-ms']},
      );
      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Updated. Transaction: ${result.txHash}`);
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

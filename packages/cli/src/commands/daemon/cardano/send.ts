// Send ADA and/or cNIGHT through the running daemon. The daemon holds the
// phrase and signs; this command carries no key material.

import {Args, Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';
import {parseAda, parseCnight} from '@shieldedtech/moth-wallet/cardano/send';

export default class DaemonCardanoSend extends BaseCommand {
  static override description =
    'Send ADA and/or cNIGHT to another Cardano address via the running daemon.';

  static override args = {
    to: Args.string({description: 'Destination Cardano address', required: true}),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    ada: Flags.string({description: 'ADA to send, e.g. 1.5'}),
    cnight: Flags.string({description: 'cNIGHT to send, e.g. 1.5 (6 decimal places)'}),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 300000)',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const {args, flags} = await this.parse(DaemonCardanoSend);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    if (!flags.ada && !flags.cnight) {
      this.outputError('INVALID_INPUT', 'Specify --ada, --cnight, or both.');
      this.exit(1);
      return;
    }

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const result = await client.call<{txHash: string}>(
        'cardanoSend',
        {
          to: args.to,
          // Parsed here so a malformed amount is rejected before a round trip.
          lovelace: (flags.ada ? parseAda(flags.ada) : 0n).toString(),
          cnight: (flags.cnight ? parseCnight(flags.cnight) : 0n).toString(),
        },
        {timeoutMs: flags['timeout-ms']},
      );
      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Sent. Transaction: ${result.txHash}`);
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

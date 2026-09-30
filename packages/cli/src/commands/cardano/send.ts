import { Args, Flags } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import {
  explorerTxUrl,
  findRegistration,
  formatAda,
  formatCnight,
  parseAda,
  parseCnight,
  readCardanoBalance,
  sendCardanoAssets,
} from '@shieldedtech/moth-wallet/cardano';

export default class CardanoSend extends CardanoCommand {
  static override description = 'Send ADA and/or cNIGHT to another Cardano address';

  static override args = {
    to: Args.string({ description: 'Destination Cardano address', required: true }),
  };

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
    ada: Flags.string({ description: 'ADA to send, e.g. 1.5' }),
    cnight: Flags.string({ description: 'cNIGHT to send, e.g. 1.5 (6 decimal places)' }),
    yes: Flags.boolean({ char: 'y', default: false, description: 'Skip confirmation prompt' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CardanoSend);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    if (!flags.ada && !flags.cnight) {
      this.outputError('INVALID_INPUT', 'Specify --ada, --cnight, or both.');
      this.exit(1);
      return;
    }
    const lovelace = flags.ada ? parseAda(flags.ada) : 0n;
    // Parsed as cNIGHT, not STARs: "10" means ten cNIGHT.
    const cnight = flags.cnight ? parseCnight(flags.cnight) : 0n;

    const walletName = await this.resolveWalletName(flags);
    const config = await this.getCardanoConfig(flags.network, flags);
    const passphrase = await getPassphrase();

    const txHash = await this.withCardano(walletName, passphrase, config, flags, async (session, account) => {
      const balance = await readCardanoBalance(session);
      // Moving cNIGHT changes what generates DUST, and spending its UTXOs
      // rotates them. Someone sending away registered cNIGHT should be told
      // that here, not discover it when generation drops.
      const registration = cnight > 0n ? await findRegistration(session) : null;

      await this.confirmTransaction(
        {
          'Operation': 'Send on Cardano',
          'Cardano net': config.network,
          'Wallet': walletName,
          'Account': `${account.label} (${account.kind})`,
          'To': args.to,
          ...(lovelace > 0n ? { 'ADA': formatAda(lovelace) } : {}),
          ...(cnight > 0n
            ? { 'cNIGHT': `${formatCnight(cnight)} of ${formatCnight(balance.cnight)}` }
            : {}),
          ...(registration
            ? { 'Warning': 'This account is registered for DUST — sent cNIGHT stops generating' }
            : {}),
        },
        flags,
      );

      return sendCardanoAssets(session, { to: args.to, lovelace, cnight }, (stage) => {
        process.stderr.write(`Cardano send: ${stage}\n`);
      });
    });

    this.outputSuccess({
      status: 'sent',
      txHash,
      explorer: explorerTxUrl(config, txHash),
      to: args.to,
      ...(lovelace > 0n ? { ada: formatAda(lovelace) } : {}),
      ...(cnight > 0n ? { cnight: formatCnight(cnight), cnightStars: cnight.toString() } : {}),
      wallet: walletName,
      cardanoNetwork: config.network,
    });
  }
}

import { Args, Flags } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { explorerTxUrl, findRegistration, updateDustAddress } from '@shieldedtech/moth-wallet/cardano';

export default class CardanoUpdate extends CardanoCommand {
  static override description = 'Point an existing cNIGHT registration at a different Midnight address';

  static override args = {
    receiver: Args.string({
      description: 'Midnight DUST address (mn_dust_…) or its 66-hex serialization',
      required: true,
    }),
  };

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip confirmation prompt',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CardanoUpdate);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const config = await this.getCardanoConfig(flags.network, flags);
    const passphrase = await getPassphrase();

    const txHash = await this.withCardano(walletName, passphrase, config, flags, async (session, account) => {
      const existing = await findRegistration(session);
      await this.confirmTransaction(
        {
          'Operation': 'Update cNIGHT DUST receiver',
          'Cardano net': config.network,
          'Wallet': walletName,
          'Account': `${account.label} (${account.kind})`,
          ...(existing ? { 'Currently to': existing.dustAddress } : {}),
          'New DUST to': args.receiver,
        },
        flags,
      );

      return updateDustAddress(session, args.receiver, (stage) => {
        process.stderr.write(`Cardano update: ${stage}\n`);
      });
    });

    this.outputSuccess({
      status: 'updated',
      txHash,
      explorer: explorerTxUrl(config, txHash),
      wallet: walletName,
      cardanoNetwork: config.network,
      receiver: args.receiver,
    });
  }
}

import { Flags } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { deregisterFromDust, explorerTxUrl, findRegistration } from '@shieldedtech/moth-wallet/cardano';

export default class CardanoDeregister extends CardanoCommand {
  static override description = 'Stop generating DUST from this wallet\'s cNIGHT';

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
    const { flags } = await this.parse(CardanoDeregister);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const config = await this.getCardanoConfig(flags.network, flags);
    const passphrase = await getPassphrase();

    const txHash = await this.withCardano(walletName, passphrase, config, flags, async (session, account) => {
      const existing = await findRegistration(session);
      await this.confirmTransaction(
        {
          'Operation': 'Deregister cNIGHT from DUST generation',
          'Cardano net': config.network,
          'Wallet': walletName,
          'Account': `${account.label} (${account.kind})`,
          'Cardano addr': session.addresses.address,
          ...(existing ? { 'Currently to': existing.coinPublicKey } : {}),
        },
        flags,
      );

      return deregisterFromDust(session, (stage) => {
        process.stderr.write(`Cardano deregister: ${stage}\n`);
      });
    });

    this.outputSuccess({
      status: 'deregistered',
      txHash,
      explorer: explorerTxUrl(config, txHash),
      wallet: walletName,
      cardanoNetwork: config.network,
      note: 'Registration burned and every cNIGHT UTXO rotated, so nothing keeps generating under the old mapping.',
    });
  }
}

import { Flags } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { explorerTxUrl, registerForDust } from '@shieldedtech/moth-wallet/cardano';

export default class CardanoRegister extends CardanoCommand {
  static override description =
    'Register this wallet\'s cNIGHT on Cardano to generate DUST on Midnight';

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
    receiver: Flags.string({
      description:
        "Midnight DUST address (mn_dust_…) or its 66-hex serialization (default: this wallet's own)",
    }),
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip confirmation prompt',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CardanoRegister);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const config = await this.getCardanoConfig(flags.network, flags);
    const passphrase = await getPassphrase();

    const own = await this.getOwnDustAddress(walletName, passphrase, flags.network);
    const txHash = await this.withCardano(walletName, passphrase, config, flags, async (session, account) => {
      const receiver = flags.receiver ?? own;

      // SR-003: confirm before building. Registering to someone else's key is
      // legitimate — it is how you generate DUST for a wallet that holds no
      // cNIGHT — but it is also the expensive mistake, so say which it is.
      await this.confirmTransaction(
        {
          'Operation': 'Register cNIGHT for DUST generation',
          'Cardano net': config.network,
          'Wallet': walletName,
          'Account': `${account.label} (${account.kind})`,
          'Cardano addr': session.addresses.address,
          'DUST to': receiver === own ? `${receiver} (this wallet)` : `${receiver} (NOT this wallet)`,
        },
        flags,
      );

      return registerForDust(session, receiver, (stage) => {
        process.stderr.write(`Cardano register: ${stage}\n`);
      });
    });

    this.outputSuccess({
      status: 'registered',
      txHash,
      explorer: explorerTxUrl(config, txHash),
      wallet: walletName,
      cardanoNetwork: config.network,
      // The Cardano transaction is what this command owns. DUST does not start
      // accruing until the Midnight side observes it, which is minutes later —
      // `moth cardano status` is where that shows up.
      note: 'Registered on Cardano. DUST generation starts once the Midnight indexer observes it.',
    });
  }
}

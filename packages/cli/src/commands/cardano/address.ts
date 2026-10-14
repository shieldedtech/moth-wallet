import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { deriveCardanoAddresses } from '@shieldedtech/moth-wallet/cardano';

export default class CardanoAddress extends CardanoCommand {
  static override description = "Show a Cardano account's addresses for cNIGHT";

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CardanoAddress);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const config = await this.getCardanoConfig(flags.network, flags);

    // Derivation is pure, so this needs the passphrase but not Blockfrost —
    // someone can be told where to send ADA without any API credential at all.
    const passphrase = await getPassphrase();
    const account = await this.getCardanoAccount(walletName, flags);
    const { mnemonic, accountIndex } = await this.resolveAccountKey(walletName, passphrase, account);
    const addresses = await deriveCardanoAddresses(mnemonic, config, accountIndex);
    const dustAddress = await this.getOwnDustAddress(walletName, passphrase, flags.network);

    this.outputSuccess({
      wallet: walletName,
      account: account.label,
      accountId: account.id,
      accountKind: account.kind,
      accountIndex,
      cardanoNetwork: config.network,
      address: addresses.address,
      rewardAddress: addresses.rewardAddress,
      stakeKeyHash: addresses.stakeKeyHash,
      paymentKeyHash: addresses.paymentKeyHash,
      midnightDustAddress: dustAddress,
    });
  }
}

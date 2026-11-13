import { Args } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../../cardano-command.js';
import { addDerivedCardanoAccount } from '@shieldedtech/moth-wallet/cardano';
import { WalletError } from '@shieldedtech/moth-wallet';

export default class CardanoAccountAdd extends CardanoCommand {
  static override description =
    'Add a Cardano account derived from this wallet\'s recovery phrase, and make it active';

  static override args = {
    label: Args.string({ description: 'Name for the account (default: "Account N")' }),
  };

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CardanoAccountAdd);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);

    // A derived account is an index of the wallet's recovery phrase, so a
    // hex-seed wallet cannot have one. Refused here rather than at first use:
    // adding it would otherwise succeed and leave a dead account in the list.
    // `backupKind` is public metadata, so this costs no passphrase prompt.
    const info = (await this.walletManager.list()).find((w) => w.name === walletName);
    if (info?.backupKind === 'seed') {
      throw new WalletError(
        'WALLET_ERROR',
        `Wallet "${walletName}" was imported from a raw hex seed, so it has no recovery phrase `
          + 'to derive Cardano accounts from. Use `moth cardano account import` instead.',
      );
    }

    const { account } = await addDerivedCardanoAccount(this.storage, walletName, args.label);

    this.outputSuccess({
      id: account.id,
      label: account.label,
      kind: account.kind,
      accountIndex: account.accountIndex,
      active: true,
      wallet: walletName,
      // No new backup artifact: this is an index of a phrase they already have.
      note: 'Derived from this wallet\'s recovery phrase — nothing extra to back up.',
    });
  }
}

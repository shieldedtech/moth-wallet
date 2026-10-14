import { Args, Flags } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../../cardano-command.js';
import { listCardanoAccounts, removeCardanoAccount } from '@shieldedtech/moth-wallet/cardano';
import { WalletError } from '@shieldedtech/moth-wallet';

export default class CardanoAccountRemove extends CardanoCommand {
  static override description = 'Remove a Cardano account from this wallet';

  static override args = {
    account: Args.string({ description: 'Account id or label', required: true }),
  };

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
    yes: Flags.boolean({ char: 'y', default: false, description: 'Skip confirmation prompt' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CardanoAccountRemove);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const { accounts } = await listCardanoAccounts(this.storage, walletName);
    const match = accounts.find((a) => a.id === args.account || a.label === args.account);
    if (!match) {
      throw new WalletError(
        'INVALID_INPUT',
        `No Cardano account "${args.account}" on wallet "${walletName}".`,
      );
    }

    await this.confirmTransaction(
      {
        'Operation': 'Remove Cardano account',
        'Wallet': walletName,
        'Account': `${match.label} (${match.kind})`,
        // Only an imported account loses anything irrecoverable; a derived one
        // comes back by adding it again at the same index.
        'Effect': match.kind === 'imported'
          ? 'Deletes the only copy of its recovery phrase held here'
          : 'Removes the account; its index is not reused',
      },
      flags,
    );

    await removeCardanoAccount(this.storage, walletName, match.id);
    this.outputSuccess({ removed: match.id, label: match.label, kind: match.kind });
  }
}

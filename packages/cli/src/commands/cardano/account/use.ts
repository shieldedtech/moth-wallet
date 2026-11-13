import { Args } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../../cardano-command.js';
import { listCardanoAccounts, setActiveCardanoAccount } from '@shieldedtech/moth-wallet/cardano';
import { WalletError } from '@shieldedtech/moth-wallet';

export default class CardanoAccountUse extends CardanoCommand {
  static override description = 'Make a Cardano account the active one';

  static override args = {
    account: Args.string({ description: 'Account id or label', required: true }),
  };

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CardanoAccountUse);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    // Accept a label as well as an id: ids are generated, and nobody types one.
    const { accounts } = await listCardanoAccounts(this.storage, walletName);
    const match = accounts.find((a) => a.id === args.account || a.label === args.account);
    if (!match) {
      throw new WalletError(
        'INVALID_INPUT',
        `No Cardano account "${args.account}" on wallet "${walletName}".`,
      );
    }
    await setActiveCardanoAccount(this.storage, walletName, match.id);
    this.outputSuccess({ id: match.id, label: match.label, kind: match.kind, active: true });
  }
}

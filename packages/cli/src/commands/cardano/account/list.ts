import { CardanoCommand, cardanoFlags } from '../../../cardano-command.js';
import { getPassphrase } from '../../../adapters/passphrase.js';
import { deriveCardanoAddresses, listCardanoAccounts } from '@shieldedtech/moth-wallet/cardano';
import { Flags } from '@oclif/core';

export default class CardanoAccountList extends CardanoCommand {
  static override description = 'List this wallet\'s Cardano accounts';

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
    addresses: Flags.boolean({
      default: false,
      description: 'Also derive each account\'s address (needs the passphrase)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CardanoAccountList);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const { accounts, activeId } = await listCardanoAccounts(this.storage, walletName);

    // Listing is storage-only. Addresses need key material, so they are opt-in
    // rather than making every `list` prompt for a passphrase.
    let addressOf: Map<string, string> | null = null;
    if (flags.addresses) {
      const config = await this.getCardanoConfig(flags.network, flags);
      const passphrase = await getPassphrase();
      addressOf = new Map();
      for (const account of accounts) {
        try {
          const { mnemonic, accountIndex } = await this.resolveAccountKey(walletName, passphrase, account);
          const derived = await deriveCardanoAddresses(mnemonic, config, accountIndex);
          addressOf.set(account.id, derived.address);
        } catch (err) {
          // One unreadable account must not hide the rest — an imported
          // keystore can go missing independently of the others.
          addressOf.set(account.id, `(unavailable: ${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }

    this.outputSuccess(
      accounts.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        accountIndex: a.accountIndex,
        active: a.id === activeId,
        ...(addressOf ? { address: addressOf.get(a.id) } : {}),
      })),
    );
  }
}

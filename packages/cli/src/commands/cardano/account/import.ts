import { Flags } from '@oclif/core';
import { CardanoCommand, cardanoFlags } from '../../../cardano-command.js';
import { getPassphrase } from '../../../adapters/passphrase.js';
import { importCardanoAccount } from '@shieldedtech/moth-wallet/cardano';
import { WalletError } from '@shieldedtech/moth-wallet';

export default class CardanoAccountImport extends CardanoCommand {
  static override description =
    'Import a Cardano-only account from a separate BIP-39 recovery phrase';

  static override flags = {
    ...CardanoCommand.baseFlags,
    ...cardanoFlags,
    label: Flags.string({ description: 'Name for the account' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CardanoAccountImport);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);

    // Stdin pipe or interactive prompt — never a flag, an argument or an env
    // var. SR-001: a recovery phrase must not reach the process list or the
    // shell history. Same pattern as `moth wallet import`.
    //   echo "$PHRASE" | moth cardano account import
    process.stderr.write(
      'Importing a Cardano-only account. It will not hold Midnight funds, and this\n' +
      "wallet's recovery phrase does NOT restore it — keep the phrase you are importing\n" +
      'backed up yourself.\n',
    );
    let mnemonic: string;
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      mnemonic = Buffer.concat(chunks).toString('utf-8').trim();
      if (!mnemonic) {
        throw new WalletError(
          'INVALID_INPUT',
          'No recovery phrase on stdin. Pipe it: echo "$PHRASE" | moth cardano account import',
        );
      }
    } else {
      mnemonic = await this.promptIfMissing(undefined, 'Cardano recovery phrase');
    }
    const passphrase = await getPassphrase();

    const { account } = await importCardanoAccount(
      this.storage,
      walletName,
      mnemonic,
      passphrase,
      flags.label,
    );

    this.outputSuccess({
      id: account.id,
      label: account.label,
      kind: account.kind,
      active: true,
      wallet: walletName,
      note: 'Encrypted with the wallet passphrase. Not covered by this wallet\'s recovery phrase.',
    });
  }
}

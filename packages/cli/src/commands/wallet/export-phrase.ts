import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';

/**
 * Print a wallet's recovery phrase, or its raw seed.
 *
 * The capability existed everywhere except here: `WalletManager.exportPhrase` and
 * `exportSeedHex` have been in core throughout, and the extension exposes them —
 * but no CLI command did (#59). The consequences were a CLI with no backup path
 * (the phrase is shown once at `wallet generate` and never again), no supported
 * way to move a wallet between machines, and no way to recover a seed a user
 * already holds the keystore and passphrase for.
 *
 * Nothing here weakens the security posture: anyone who can run this already has
 * the keystore file and the passphrase that decrypts it. What it does is stop
 * pretending otherwise.
 */
export default class WalletExportPhrase extends BaseCommand {
  static override description = "Print a wallet's recovery phrase or seed (prompts for the passphrase)";

  static override examples = [
    '<%= config.bin %> wallet export-phrase --wallet my-wallet',
    '<%= config.bin %> wallet export-phrase --wallet my-wallet --seed-hex',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Wallet name (alias for --wallet)' }),
    'seed-hex': Flags.boolean({
      description: 'Print the raw hex seed instead of the mnemonic',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletExportPhrase);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = flags.name ?? (await this.resolveWalletName(flags));

    // Confirmed by default, because the failure mode is a phrase left in
    // scrollback or a CI log by someone who did not realise what the command
    // prints. --yes exists for deliberate scripted use.
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        // Same rule `wallet remove` applies: a destructive-or-disclosing action
        // in a non-interactive context has to be asked for explicitly, or a
        // pipeline discloses a phrase nobody meant to print.
        this.outputError('INVALID_INPUT', 'Non-interactive export requires --yes');
        this.exit(2);
        return;
      }
      const answer = await this.promptIfMissing(
        undefined,
        `Print the recovery phrase for "${walletName}"? Anyone who sees it controls the wallet. (yes/no)`,
      );
      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        this.log('Cancelled.');
        return;
      }
    }

    const passphrase = await getPassphrase();
    const exported = await this.walletManager.exportPhrase(walletName, passphrase);

    // A wallet imported from a hex seed has no mnemonic to give back — say which
    // one this is rather than presenting a seed as a phrase.
    if (flags['seed-hex'] || exported.kind === 'seed') {
      const seedHex =
        exported.kind === 'seed'
          ? exported.value
          : await this.walletManager.exportSeedHex(walletName, passphrase);

      if (this.outputFormat === 'json') {
        this.outputSuccess({ wallet: walletName, kind: 'seed', seedHex });
      } else {
        if (exported.kind === 'seed' && !flags['seed-hex']) {
          this.log('This wallet was imported from a hex seed, so it has no recovery phrase.');
        }
        this.log('');
        this.log(`  ${seedHex}`);
        this.log('');
      }
      return;
    }

    if (this.outputFormat === 'json') {
      this.outputSuccess({ wallet: walletName, kind: 'mnemonic', mnemonic: exported.value });
    } else {
      this.log('');
      this.log('RECOVERY PHRASE — anyone who sees this controls the wallet:');
      this.log('');
      this.log(`  ${exported.value}`);
      this.log('');
    }
  }
}

import { Flags } from '@oclif/core';
import { BaseCommand } from './base-command.js';
import { WalletError, canonicalNetworkId, deriveAllAddressesFromSeed } from '@shieldedtech/moth-wallet';
import {
  getActiveCardanoAccount,
  dustAddressBytes,
  CardanoNetworkUnavailableError,
  loadCardanoConfig,
  resolveCardanoAccountKey,
  withCardanoSession,
  type CardanoAccountRecord,
  type CardanoNetworkConfig,
  type CardanoSession,
} from '@shieldedtech/moth-wallet/cardano';

/**
 * Flags shared by every `moth cardano` subcommand.
 *
 * The Blockfrost project id is deliberately NOT a flag. Flag values are visible
 * in the process list to any other user on the machine, and this one is a
 * credential — it comes from the environment or from stored config, the same
 * rule `--bind`/MOTH_DAEMON_TOKEN already follows.
 */
export const cardanoFlags = {
  'blockfrost-url': Flags.string({
    description: 'Blockfrost API base URL override',
  }),
  'cnight-policy-id': Flags.string({
    description: 'cNIGHT minting policy id override (hex)',
  }),
  'cnight-asset-name': Flags.string({
    description: 'cNIGHT asset name override (hex; empty on the testnet token)',
  }),
  account: Flags.string({
    description: 'Cardano account id to act on (default: the active one — see `moth cardano account list`)',
  }),
} as const;

export abstract class CardanoCommand extends BaseCommand {
  /**
   * Resolve the Cardano config for this invocation. The precedence ladder
   * itself lives in core so the CLI, the TUI and `daemon serve` cannot drift.
   * A network with no Cardano pair is a usage error, reported as one.
   */
  protected async getCardanoConfig(
    midnightNetworkId: string,
    flags: Record<string, unknown>,
  ): Promise<CardanoNetworkConfig> {
    try {
      return await loadCardanoConfig(this.storage, canonicalNetworkId(midnightNetworkId), {
        blockfrostUrl: flags['blockfrost-url'] as string | undefined,
        cnightPolicyId: flags['cnight-policy-id'] as string | undefined,
        cnightAssetName: flags['cnight-asset-name'] as string | undefined,
      });
    } catch (err) {
      if (err instanceof CardanoNetworkUnavailableError) {
        throw new WalletError(
          'INVALID_INPUT',
          `${err.message} This command needs cNIGHT on Cardano; use --network preprod or preview.`,
        );
      }
      throw err;
    }
  }

  /**
   * The wallet's own BIP-39 mnemonic, or null when it has none.
   *
   * Null is a legitimate answer, not an error: a wallet imported from a raw hex
   * seed has no derived Cardano accounts, but it can still hold *imported*
   * ones, which carry their own phrase. Whether null is fatal depends on which
   * account is selected, so the decision belongs to resolveCardanoAccountKey.
   */
  protected async getWalletMnemonic(walletName: string, passphrase: string): Promise<string | null> {
    const phrase = await this.walletManager.exportPhrase(walletName, passphrase);
    return phrase.kind === 'mnemonic' ? phrase.value : null;
  }

  /**
   * The Cardano account this invocation acts on: `--account`, else the active
   * one. Every wallet has at least the default, so this never returns null.
   */
  protected async getCardanoAccount(
    walletName: string,
    flags: Record<string, unknown>,
  ): Promise<CardanoAccountRecord> {
    const requested = flags.account as string | undefined;
    if (!requested) return getActiveCardanoAccount(this.storage, walletName);
    const { listCardanoAccounts } = await import('@shieldedtech/moth-wallet/cardano');
    const { accounts } = await listCardanoAccounts(this.storage, walletName);
    const match = accounts.find((a) => a.id === requested || a.label === requested);
    if (!match) {
      throw new WalletError(
        'INVALID_INPUT',
        `No Cardano account "${requested}" on wallet "${walletName}". `
          + 'Run `moth cardano account list` to see them.',
      );
    }
    return match;
  }

  /**
   * The phrase and CIP-1852 index to sign a given account with.
   *
   * Derived accounts use the wallet's own phrase; imported ones are decrypted
   * from their own keystore with the same passphrase.
   */
  protected async resolveAccountKey(
    walletName: string,
    passphrase: string,
    account: CardanoAccountRecord,
  ): Promise<{ mnemonic: string; accountIndex: number }> {
    const walletMnemonic = await this.getWalletMnemonic(walletName, passphrase);
    return resolveCardanoAccountKey(this.storage, walletName, account, walletMnemonic, passphrase);
  }

  /**
   * The wallet's own serialized DUST address — the default DUST receiver.
   *
   * Taken from the seed rather than the mnemonic so it also works for a
   * hex-seed wallet, which can still own imported Cardano accounts and so
   * still needs somewhere for their DUST to go.
   */
  protected async getOwnDustAddress(
    walletName: string,
    passphrase: string,
    midnightNetworkId: string,
  ): Promise<string> {
    const seedHex = await this.walletManager.exportSeedHex(walletName, passphrase);
    const bech32 = deriveAllAddressesFromSeed(seedHex).dust.bech32m[canonicalNetworkId(midnightNetworkId)];
    if (!bech32) {
      throw new WalletError('WALLET_ERROR', `No DUST address for network "${midnightNetworkId}"`);
    }
    return dustAddressBytes(bech32);
  }

  /**
   * Open a Cardano session for the active wallet and run `fn`.
   *
   * Turns the "no project id" case into CLI guidance rather than a bare throw:
   * it is the one piece of setup moth cannot supply for the user.
   */
  protected async withCardano<T>(
    walletName: string,
    passphrase: string,
    config: CardanoNetworkConfig,
    flags: Record<string, unknown>,
    fn: (session: CardanoSession, account: CardanoAccountRecord) => Promise<T>,
  ): Promise<T> {
    if (!config.blockfrostProjectId) {
      throw new WalletError(
        'INVALID_INPUT',
        'No Blockfrost project id configured. Set MOTH_BLOCKFROST_PROJECT_ID, or run '
          + '`moth config set blockfrost-project-id <id>`. Get one free at https://blockfrost.io.',
      );
    }
    const account = await this.getCardanoAccount(walletName, flags);
    const { mnemonic, accountIndex } = await this.resolveAccountKey(walletName, passphrase, account);
    return withCardanoSession(mnemonic, config, (session) => fn(session, account), accountIndex);
  }
}

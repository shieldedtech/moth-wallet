import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import type { AddressEncoding, WalletInfo, ImportOptions } from '@shieldedtech/moth-wallet';
import type { BirthdayClaim } from '@shieldedtech/moth-wallet';
import {
  WalletError,
  birthdayOutlook,
  chainTip,
  mnemonicToSeed,
  resolveBirthdayClaim,
  shieldedCaveat,
} from '@shieldedtech/moth-wallet';

/**
 * Hex seed for a mnemonic, for the birthday checks' address derivation.
 *
 * The manager derives its own copy during the import proper; this one exists
 * because the birthday must be settled BEFORE the wallet is written. The buffer
 * is zeroed, though the hex string cannot be — same trade the manager makes.
 */
async function seedHexFor(mnemonic: string): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic);
  const hex = Array.from(seed).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  seed.fill(0);
  return hex;
}

export default class WalletImport extends BaseCommand {
  static override description = 'Import a wallet from an existing mnemonic or hex seed';

  static override flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Wallet name' }),
    // Three ways to say the same thing: "this seed had no activity before X".
    // Without one, an imported wallet must scan from genesis, because moth
    // cannot know whether the seed is fresh or has years of history.
    'birthday-date': Flags.string({
      description:
        'Assert the seed had no activity before this date (ISO 8601, e.g. 2026-08-01). ' +
        'Resolved to a block height. Too early only costs sync time; too late hides shielded funds and their DUST.',
      exclusive: ['birthday-height', 'birthday-tip', 'birthday-discover'],
    }),
    'birthday-height': Flags.integer({
      description: 'Assert the seed had no activity before this block height.',
      exclusive: ['birthday-date', 'birthday-tip', 'birthday-discover'],
    }),
    'birthday-tip': Flags.boolean({
      description: 'Assert this seed is brand new — start from the current chain tip.',
      default: false,
      exclusive: ['birthday-date', 'birthday-height', 'birthday-discover'],
    }),
    'birthday-discover': Flags.boolean({
      description:
        "Ask the indexer for the seed's first UNSHIELDED transaction and use that height. " +
        'Shielded history cannot be discovered this way — see the warning it prints.',
      default: false,
      exclusive: ['birthday-date', 'birthday-height', 'birthday-tip'],
    }),
    'birthday-force': Flags.boolean({
      description:
        'Accept a birthday even when the indexer shows earlier unshielded activity. ' +
        'The unshielded funds are still found; the risk is shielded funds received before it.',
      default: false,
    }),
    'seed-hex': Flags.boolean({ description: 'Import from hex seed instead of mnemonic', default: false }),
  };

  /**
   * Turn the birthday flags into ImportOptions.
   *
   * currentHeight is recorded whatever happens — it is the informational "when
   * did this account start here". birthdayHeight is only set when the user
   * actually asserted one, because it is a safety claim the pre-seed acts on.
   */
  private async resolveImportOptions(flags: Record<string, unknown>, seedHex: string): Promise<ImportOptions> {
    const network = await this.getNetworkConfig(flags.network as string, this.getNetworkOverrides(flags));
    const tip = await chainTip(network.indexerUrl).catch(() => null);
    const options: {currentHeight?: number; birthdayHeight?: number} = {};
    if (tip) options.currentHeight = tip.height;

    const claim = this.claimFrom(flags);
    if (claim) {
      const resolved = await resolveBirthdayClaim({
        indexerUrl: network.indexerUrl,
        networkId: network.id,
        claim,
        seedHex,
        tipHeight: tip?.height,
      });

      // A claim the chain contradicts is refused rather than warned about: too
      // early only costs sync time, too late hides funds, and this half of "too
      // late" is provable.
      if (resolved.conflict && !flags['birthday-force']) {
        throw new WalletError(
          'INVALID_INPUT',
          `Refusing that birthday: ${resolved.conflict.message} Use --birthday-discover to take ` +
            `${resolved.conflict.firstActivityHeight}, an earlier --birthday-date, or --birthday-force if you meant it.`,
        );
      }
      if (resolved.conflict) {
        this.warn(`Birthday is later than known activity: ${resolved.conflict.message} Continuing because --birthday-force was given.`);
      }

      // Findings go to stdout; the shielded caveat goes to stderr as a warning,
      // once. It is filtered out of the notes here because core includes it in
      // them for surfaces that have nowhere else to put it.
      const caveat = resolved.height === undefined ? null : shieldedCaveat(resolved.height);
      for (const note of resolved.notes) {
        if (note !== caveat) this.log(note);
      }
      if (caveat) this.warn(caveat);
      options.birthdayHeight = resolved.height;
    }

    // A birthday earlier than the reference is refused by the pre-seed guard,
    // so the import succeeds and the first sync still walks from genesis. Say so
    // now rather than letting an hour-long sync be the explanation.
    if (options.birthdayHeight !== undefined) {
      const outlook = await birthdayOutlook(network, options.birthdayHeight).catch(() => null);
      if (outlook && !outlook.seedable && outlook.reason) {
        this.warn(`Pre-seed will not apply: ${outlook.reason}`);
      }
    }
    return options;
  }

  /** Map the mutually exclusive flags onto the shared claim type. */
  private claimFrom(flags: Record<string, unknown>): BirthdayClaim | undefined {
    if (flags['birthday-tip']) return {kind: 'tip'};
    if (flags['birthday-discover']) return {kind: 'discover'};
    if (flags['birthday-height'] !== undefined) return {kind: 'height', value: flags['birthday-height'] as number};
    if (flags['birthday-date'] !== undefined) {
      const when = new Date(flags['birthday-date'] as string);
      if (Number.isNaN(when.getTime())) {
        throw new WalletError('INVALID_INPUT', `Invalid --birthday-date "${flags['birthday-date']}"`);
      }
      return {kind: 'date', value: when.toISOString()};
    }
    return undefined;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletImport);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const name = flags.name ?? `wallet-${Date.now().toString(36)}`;
    const passphrase = await getPassphrase('New passphrase: ');

    let info: WalletInfo;

    if (flags['seed-hex']) {
      // Hex seed via stdin pipe or interactive prompt — never as CLI argument.
      // SR-001: seed material MUST NOT appear in process arguments.
      //   echo "abcdef..." | moth wallet import --seed-hex --name my-wallet
      let hexSeed: string;
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        hexSeed = Buffer.concat(chunks).toString('utf-8').trim();
        if (!hexSeed) {
          throw new (await import('@shieldedtech/moth-wallet')).WalletError(
            'INVALID_INPUT',
            'No hex seed provided on stdin. Pipe it: echo "$SEED" | moth wallet import --seed-hex',
          );
        }
      } else {
        hexSeed = await this.promptIfMissing(undefined, 'Hex seed');
      }
      info = await this.walletManager.importFromSeed(
        name,
        hexSeed,
        passphrase,
        flags.network,
        await this.resolveImportOptions(flags, hexSeed.trim()),
      );
    } else {
      // Mnemonic via stdin pipe or interactive prompt — never as env var or argument.
      // SR-001: mnemonics MUST NOT appear in environment variables or process arguments.
      //   echo "word1 word2 ..." | moth wallet import --name ci-wallet
      let mnemonic: string;
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        mnemonic = Buffer.concat(chunks).toString('utf-8').trim();
        if (!mnemonic) {
          throw new (await import('@shieldedtech/moth-wallet')).WalletError(
            'INVALID_INPUT',
            'No mnemonic provided on stdin. Pipe it: echo "$MNEMONIC" | moth wallet import',
          );
        }
      } else {
        mnemonic = await this.promptIfMissing(undefined, 'Recovery phrase (24 words)');
      }
      info = await this.walletManager.import(
        name,
        mnemonic.trim(),
        passphrase,
        flags.network,
        await this.resolveImportOptions(flags, await seedHexFor(mnemonic.trim())),
      );
    }

    if (this.outputFormat === 'json') {
      this.outputSuccess({
        name: info.name,
        network: info.network,
        addresses: info.addresses,
      });
    } else {
      const a = info.addresses;
      this.log(`Wallet imported: ${info.name}`);
      this.log(`Default network: ${info.network}`);
      this.log('');
      this.logAddress('NIGHT receive', 'Share this to receive unshielded NIGHT', a.nightExternal);
      this.logAddress('NIGHT change', 'Internal change address (do not share)', a.nightInternal);
      this.logAddress('DUST', 'DUST registration and fee payments', a.dust);
      this.logAddress('Shielded', 'Zswap viewing key for private transactions', a.zswap);
      this.logAddress('Contract authority', 'Signs contract maintenance operations', a.metadata);
    }
  }

  private logAddress(label: string, description: string, addr: AddressEncoding): void {
    this.log(`  ${label}  (${description})`);
    for (const [network, bech32m] of Object.entries(addr.bech32m)) {
      this.log(`    ${network.padEnd(8)}  ${bech32m}`);
    }
    this.log('');
  }
}

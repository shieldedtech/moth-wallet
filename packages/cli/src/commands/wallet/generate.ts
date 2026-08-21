import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import type { AddressEncoding } from '@shieldedtech/moth-wallet';
import { chainTip } from '@shieldedtech/moth-wallet';

export default class WalletGenerate extends BaseCommand {
  static override description = 'Generate a new wallet from a random BIP-39 mnemonic';

  static override flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Wallet name (auto-generated if omitted)' }),
    'show-mnemonic': Flags.boolean({
      description: 'Include mnemonic in JSON output (use with caution)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletGenerate);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const name = flags.name ?? `wallet-${Date.now().toString(36)}`;
    const passphrase = await getPassphrase('New passphrase: ');

    // A wallet generated here cannot have existed before now, so the current tip
    // is a sound birthday — and it is what lets the first sync pre-seed instead
    // of walking the chain. Without it the account is indistinguishable from an
    // imported seed of unknown age and always scans from genesis. Unreachable
    // indexer means no birthday: slow, but never wrong.
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const tip = await chainTip(network.indexerUrl).catch(() => null);
    if (!tip) this.warn('Could not read a chain tip — this wallet gets no birthday and will sync from genesis.');
    this.log_verbose(`Generating wallet "${name}"${tip ? ` with birthday ${tip.height}` : ''}`);
    const info = await this.walletManager.generate(name, passphrase, flags.network, tip?.height);

    if (this.outputFormat === 'json') {
      const output: Record<string, unknown> = {
        name: info.name,
        network: info.network,
        addresses: info.addresses,
      };
      // Mnemonic only in JSON if explicitly requested — prevents capture in
      // CI logs, command wrappers, piped output. SR-001 / CWE-200.
      if (flags['show-mnemonic']) {
        output.mnemonic = info.mnemonic;
      }
      this.outputSuccess(output);

      // Always show mnemonic on stderr (not stdout) so it's not captured
      // by JSON consumers but still visible to the human operator.
      if (!flags['show-mnemonic']) {
        process.stderr.write('\nRECOVERY PHRASE (write this down and store it safely):\n');
        process.stderr.write(`\n  ${info.mnemonic}\n`);
        process.stderr.write('\nThis phrase will NOT be shown again.\n\n');
      }
    } else {
      const a = info.addresses;
      this.log(`Wallet created: ${info.name}`);
      this.log(`Default network: ${info.network}`);
      this.log('');
      this.logAddress('NIGHT receive', 'Share this to receive unshielded NIGHT', a.nightExternal);
      this.logAddress('NIGHT change', 'Internal change address (do not share)', a.nightInternal);
      this.logAddress('DUST', 'DUST registration and fee payments', a.dust);
      this.logAddress('Shielded', 'Zswap viewing key for private transactions', a.zswap);
      this.logAddress('Contract authority', 'Signs contract maintenance operations', a.metadata);
      this.log('');

      // Mnemonic to stderr in text mode too — keeps stdout clean for piping
      // while still showing the phrase to the operator's terminal.
      if (process.stderr.isTTY) {
        process.stderr.write('RECOVERY PHRASE (write this down and store it safely):\n');
        process.stderr.write(`\n  ${info.mnemonic}\n`);
        process.stderr.write('\nThis phrase will NOT be shown again.\n');
      } else {
        // Non-interactive (CI) — suppress mnemonic entirely unless --show-mnemonic
        process.stderr.write('Recovery phrase generated but not displayed (non-interactive mode).\n');
        process.stderr.write('Use --show-mnemonic to include it in JSON output.\n');
      }
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

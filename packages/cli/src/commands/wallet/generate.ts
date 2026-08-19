import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import type { AddressEncoding } from '@shieldedtech/moth-wallet';

export default class WalletGenerate extends BaseCommand {
  static override description = 'Generate a new wallet from a random BIP-39 mnemonic';

  static override flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Wallet name (auto-generated if omitted)' }),
    'signature-kind': Flags.string({
      options: ['schnorr', 'ecdsa'],
      default: 'schnorr',
      description:
        'Unshielded signing algorithm. ECDSA needs a ledger v9 network and gives a different ' +
        'unshielded address; it cannot be changed after creation.',
    }),
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

    this.log_verbose(`Generating wallet "${name}"`);
    const info = await this.walletManager.generate(
      name,
      passphrase,
      flags.network,
      undefined,
      undefined,
      flags['signature-kind'] as 'schnorr' | 'ecdsa',
    );

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

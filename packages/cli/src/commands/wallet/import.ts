import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import type { AddressEncoding, WalletInfo } from '@shieldedtech/moth-wallet';

export default class WalletImport extends BaseCommand {
  static override description = 'Import a wallet from an existing mnemonic or hex seed';

  static override flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Wallet name' }),
    'seed-hex': Flags.boolean({ description: 'Import from hex seed instead of mnemonic', default: false }),
  };

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
      info = await this.walletManager.importFromSeed(name, hexSeed, passphrase, flags.network);
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
      info = await this.walletManager.import(name, mnemonic.trim(), passphrase, flags.network);
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

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import type { AddressEncoding } from '@shieldedtech/moth-wallet';

/**
 * Show an EXISTING wallet's addresses by unlocking its keystore offline — no
 * daemon, no network sync. Fills the gap where the only way to see a wallet's
 * shielded (zswap) address was `wallet generate` (which mints a NEW wallet).
 * Needed to recover addresses for keystores that already exist.
 */
export default class WalletAddress extends BaseCommand {
  static override description = "Show an existing wallet's addresses (unlocks the keystore; offline)";

  static override flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Wallet name', required: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletAddress);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(flags.name, passphrase);
    try {
      if (this.outputFormat === 'json') {
        this.outputSuccess({ name: wallet.name, addresses: wallet.addresses });
      } else {
        const a = wallet.addresses;
        this.log(`Wallet: ${wallet.name}`);
        this.log('');
        this.logAddress('NIGHT receive', a.nightExternal);
        this.logAddress('DUST', a.dust);
        this.logAddress('Shielded (zswap)', a.zswap);
      }
    } finally {
      wallet.lock();
    }
  }

  private logAddress(label: string, addr: AddressEncoding): void {
    this.log(`  ${label}`);
    for (const [network, bech32m] of Object.entries(addr.bech32m)) {
      this.log(`    ${network.padEnd(8)}  ${bech32m}`);
    }
    this.log('');
  }
}

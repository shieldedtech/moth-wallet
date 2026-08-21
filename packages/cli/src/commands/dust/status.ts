import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { dustGenerationsFor } from '@shieldedtech/moth-wallet';

export default class DustStatus extends BaseCommand {
  static override description = 'Show DUST generation status';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DustStatus);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Unlocked because the DUST address has to be derived: `list()` returns empty
    // address encodings for a locked wallet, so there is no way to read it from
    // metadata.
    const passphrase = await getPassphrase();
    const unlocked = await this.walletManager.unlock(walletName, passphrase);
    let dustAddress: string | undefined;
    try {
      dustAddress = unlocked.addresses.dust.bech32m[network.id];
    } finally {
      unlocked.lock();
    }

    if (!dustAddress) {
      this.outputError('WALLET_ERROR', `No DUST address for "${walletName}" on ${network.id}`);
      this.exit(1);
      return;
    }

    // Keyed by the DUST address, not a Cardano reward address. The
    // `dustGenerationStatus` query this command used to call takes
    // `cardanoRewardAddresses` and rejected a Midnight address on the HRP before
    // looking anything up, so it could never work (#54). Registration and
    // capacity for a cNIGHT holder remain unavailable until moth can supply a
    // Cardano stake address — see ADR-0007.
    const result = await dustGenerationsFor(network.indexerUrl, dustAddress);

    const total = result.entries.reduce((sum, e) => sum + BigInt(e.value || '0'), 0n);
    const newest = result.entries.reduce((max, e) => (e.ctime > max ? e.ctime : max), 0);

    this.outputSuccess({
      wallet: walletName,
      network: network.id,
      dustAddress,
      // A decay-time update is not new generation, but it only exists for an
      // address that IS generating — so it counts as evidence even when no entry
      // itself came back.
      generating: result.entries.length > 0 || result.dtimeUpdates > 0,
      entries: result.entries.length,
      decayUpdates: result.dtimeUpdates,
      totalValue: total.toString(),
      highestIndex: result.highestIndex,
      newestEntryAt: newest > 0 ? new Date(newest * 1000).toISOString() : null,
      // Said out loud: a time-bounded collection that stopped early is a partial
      // answer, and presenting it as complete is how "no DUST" gets misread.
      ...(result.truncated ? {truncated: true, note: 'stopped on the time budget — the list may be incomplete'} : {}),
      ...(result.entries.length === 0 && result.dtimeUpdates === 0
        ? {note: 'No DUST generation for this address. NIGHT must be designated (moth dust register), or held as cNIGHT on Cardano and registered there.'}
        : {}),
    });
  }
}

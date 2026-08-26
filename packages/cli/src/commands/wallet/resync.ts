// Discard a wallet's cached sync state so the next sync rebuilds it.
//
// The escape hatch for a wallet whose cache has gone wrong in a way nothing
// else can repair — the case that prompted this was a booking whose transaction
// never confirmed, which the SDK never releases and which then duplicated a
// UTXO across its available and pending lists: balance doubled, and the coin
// unspendable (docs/upstream/wallet-sdk-unshielded-booking-never-released.md).
//
// `clearSyncCache` already existed and did exactly this, per wallet, per network,
// per part — it simply had no way in from the CLI, so the only remedy anyone
// could find was `rm -rf ~/.moth/sync/<network>/<wallet>/`, which nobody
// discovers and which is easy to point at the wrong directory.

import {Flags} from '@oclif/core';
import {clearSyncCache, clearDustSyncCache} from '@shieldedtech/moth-wallet';
import {BaseCommand} from '../../base-command.js';

export default class WalletResync extends BaseCommand {
  static override description =
    "Discard a wallet's cached sync state so the next command rebuilds it from the chain. Use when balances look wrong in a way a restart does not fix — a doubled balance, or a coin the wallet refuses to spend. Costs a full rescan (dust is the slow part), so it is not a routine operation. --dust-only rebuilds just the DUST view and keeps the much larger shielded and unshielded caches.";

  static override examples = [
    '<%= config.bin %> <%= command.id %> --wallet alice --network preprod',
    '<%= config.bin %> <%= command.id %> --dust-only',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    'dust-only': Flags.boolean({
      default: false,
      description: 'Clear only the DUST cache, keeping the shielded and unshielded caches warm',
    }),
    yes: Flags.boolean({default: false, description: 'Skip confirmation'}),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(WalletResync);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const wallet = await this.resolveWalletName(flags);
    const network = flags.network;
    const dustOnly = flags['dust-only'];
    const scope = dustOnly ? 'the DUST cache' : 'all cached sync state';

    // A rescan is expensive rather than dangerous — no key material is touched
    // and nothing on chain changes — but on preprod a full dust walk is tens of
    // minutes, so it should never happen because someone typed the wrong thing.
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        throw new (await import('@shieldedtech/moth-wallet')).WalletError(
          'INVALID_INPUT',
          'Non-interactive resync requires --yes',
        );
      }
      const confirm = await this.promptIfMissing(
        undefined,
        `Discard ${scope} for "${wallet}" on ${network}? The next sync rescans. (yes/no)`,
      );
      if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
        this.log('Cancelled.');
        return;
      }
    }

    if (dustOnly) await clearDustSyncCache(wallet, network);
    else await clearSyncCache(wallet, network);

    this.outputSuccess({
      wallet,
      network,
      cleared: dustOnly ? ['dust'] : ['shielded', 'unshielded', 'dust', 'history'],
      note: 'The next command that syncs this wallet rebuilds what it needs from the chain.',
    });
  }
}

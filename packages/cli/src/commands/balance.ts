// In-process balance query. Spins up its own sync, waits for it to
// reach synced=true, reads the WalletBalances snapshot, and exits.
//
// This is the standalone counterpart to `moth wallet status` (which
// reads the same snapshot from a daemon-hosted facade). Use the
// daemon-mode version when a daemon is already running — it's
// instant. This command is for "no daemon, one-off check".

import {Flags} from '@oclif/core';
import {BaseCommand} from '../base-command.js';
import {getPassphrase} from '../adapters/passphrase.js';
import {
  startWalletSync,
  NIGHT_TOKEN_ID,
  NIGHT_DENOMINATION,
  formatBalance,
  type SyncedWallet,
  type WalletBalances,
} from '@shieldedtech/moth-wallet';

interface BalanceResult {
  readonly wallet: string;
  readonly network: string;
  readonly synced: boolean;
  readonly balances: {
    readonly night: {
      readonly unshielded: string; // raw STARS
      readonly shielded: string; // raw STARS
      readonly total: string; // raw STARS
      readonly totalDecimal: string; // major units, formatted
    };
    readonly dust: string; // raw SPECK
    readonly otherTokens: ReadonlyArray<{
      readonly tokenId: string;
      readonly type: 'unshielded' | 'shielded';
      readonly amount: string; // raw smallest units
    }>;
  };
}

export default class Balance extends BaseCommand {
  static override description =
    "Show the wallet's NIGHT (shielded + unshielded), DUST, and any non-NIGHT token balances. Spins up its own sync, so first-call latency is the full sync time; subsequent calls share the on-disk cache and complete faster. Use `moth wallet status` instead when a daemon is already running for this wallet — that path is instant.";

  static override flags = {
    ...BaseCommand.baseFlags,
    'wait-timeout-ms': Flags.integer({
      description:
        'How long to wait for the sync to reach synced=true before reading balances. Default 5 minutes. After timeout the command emits whatever the latest snapshot showed (likely 0s if sync was still catching up) with synced=false.',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(Balance);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    process.stderr.write('Syncing wallet…\n');
    const synced: SyncedWallet = await startWalletSync(
      wallet.walletKeys,
      network,
      (msg) => this.log_verbose(`[sync] ${msg}`),
      walletName,
    );

    try {
      await waitForSynced(synced, flags['wait-timeout-ms']);

      const b = synced.balances;
      const unshNight = (b.unshielded[NIGHT_TOKEN_ID] ?? 0n) as bigint;
      const shNight = (b.shielded[NIGHT_TOKEN_ID] ?? 0n) as bigint;
      const totalNight = unshNight + shNight;

      const otherTokens: BalanceResult['balances']['otherTokens'][number][] = [];
      for (const [tokenId, amount] of Object.entries(b.unshielded)) {
        if (tokenId === NIGHT_TOKEN_ID) continue;
        otherTokens.push({tokenId, type: 'unshielded', amount: amount.toString()});
      }
      for (const [tokenId, amount] of Object.entries(b.shielded)) {
        if (tokenId === NIGHT_TOKEN_ID) continue;
        otherTokens.push({tokenId, type: 'shielded', amount: amount.toString()});
      }

      const result: BalanceResult = {
        wallet: walletName,
        network: network.id,
        synced: b.synced,
        balances: {
          night: {
            unshielded: unshNight.toString(),
            shielded: shNight.toString(),
            total: totalNight.toString(),
            totalDecimal: formatBalance(totalNight, NIGHT_DENOMINATION),
          },
          dust: b.dust.toString(),
          otherTokens,
        },
      };

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
        return;
      }

      this.log(`Wallet:  ${walletName}`);
      this.log(`Network: ${network.id}`);
      this.log(`Synced:  ${b.synced ? 'yes' : 'no (snapshot may be incomplete)'}`);
      this.log('');
      this.log('NIGHT:');
      this.log(`  unshielded: ${formatBalance(unshNight, NIGHT_DENOMINATION)}  (${unshNight.toString()} STARS)`);
      this.log(`  shielded:   ${formatBalance(shNight, NIGHT_DENOMINATION)}  (${shNight.toString()} STARS)`);
      this.log(`  total:      ${formatBalance(totalNight, NIGHT_DENOMINATION)}  (${totalNight.toString()} STARS)`);
      this.log('');
      this.log(`DUST:     ${b.dust.toString()} SPECK`);
      if (otherTokens.length > 0) {
        this.log('');
        this.log('Other tokens:');
        for (const t of otherTokens) {
          this.log(`  ${t.tokenId.slice(0, 16)}…  ${t.type.padEnd(10)}  ${t.amount}`);
        }
      }
    } finally {
      // Always stop the sync subscription so the process can exit
      // cleanly. Without this, leftover WS handles keep the event
      // loop alive past the command's nominal completion.
      await synced.stop().catch(() => {});
    }
  }
}

/**
 * Resolve once `balances.synced` flips to true, or once `timeoutMs`
 * elapses (whichever comes first). On timeout the latest snapshot is
 * returned — the caller can read `b.synced` to know whether the
 * answer is authoritative or pending.
 */
function waitForSynced(synced: SyncedWallet, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveOuter) => {
    if (synced.balances.synced) return resolveOuter();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        unsub();
      } catch {
        /* idempotent */
      }
      clearTimeout(timer);
      resolveOuter();
    };
    const unsub = synced.subscribe((b: WalletBalances) => {
      if (b.synced) finish();
    });
    const timer = setTimeout(finish, timeoutMs).unref();
  });
}

import { Flags } from '@oclif/core';
import { BaseCommand, daemonClientFlags } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import {
  checkCachedDustView,
  dustAddressForKey,
  dustViewToWire,
  formatDustBalance,
  type DaemonCheckDustViewResult,
  type DaemonDustViewWire,
} from '@shieldedtech/moth-wallet';

type CheckResult = DaemonCheckDustViewResult;

function formatNightStar(star: string): string {
  const v = BigInt(star);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export default class DustCheck extends BaseCommand {
  static override description =
    "Compare the wallet's DUST view with the chain. Every live generation entry the indexer holds for this dust address must have a coin in the local view, " +
    'and the local dust cursor must be at the indexer\'s tip. With a running daemon or TUI hosting the wallet the live view is checked; otherwise the cached dust state is read and compared offline.';

  static override examples = [
    '<%= config.bin %> dust check --wallet bot-0 --network preprod',
    '<%= config.bin %> dust check --wallet bot-0 --network preprod --offline --output json',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    offline: Flags.boolean({
      default: false,
      description: 'Do not look for a daemon; read the cached dust state and compare it with the indexer',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DustCheck);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    if (!flags.offline) {
      const { client } = await this.probeDaemon(network.id, walletName, { bind: flags.bind });
      if (client) {
        // The report exits 2 on an incomplete view, and oclif's exit is a throw —
        // so it runs outside the try, or the catch would turn it into a daemon error.
        let result: CheckResult;
        try {
          result = await client.call<CheckResult>('checkDustView', undefined, { timeoutMs: 120_000 });
        } catch (err) {
          const { category, message } = this.renderDaemonError(err);
          this.outputError(category, message);
          this.exit(1);
          return;
        } finally {
          client.close();
        }
        this.report(result.dustView, { via: 'daemon', walletName, networkId: network.id, balance: null });
        return;
      }
      this.log_verbose(`No daemon is hosting "${walletName}" on ${network.id}; checking the cached dust state instead.`);
    }

    // Offline: the dust address comes from the key, so the wallet has to be
    // unlocked — nothing is synced or signed.
    const passphrase = await getPassphrase();
    const unlocked = await this.walletManager.unlock(walletName, passphrase);
    const dustAddress = dustAddressForKey(unlocked.walletKeys.dustSecretKey, network.id);
    const { snapshot, dustView } = await checkCachedDustView({
      walletName,
      networkId: network.id,
      indexerUrl: network.indexerUrl,
      dustAddress,
    });
    this.report(dustViewToWire(dustView)!, {
      via: snapshot ? 'cache' : 'no-cache',
      walletName,
      networkId: network.id,
      balance: snapshot?.balance ?? null,
      syncTime: snapshot?.syncTime ?? null,
      coins: snapshot?.coins.length ?? 0,
    });
  }

  private report(
    view: DaemonDustViewWire,
    meta: { via: string; walletName: string; networkId: string; balance: bigint | null; syncTime?: Date | null; coins?: number },
  ): void {
    if (this.outputFormat === 'json') {
      this.outputSuccess({
        via: meta.via,
        wallet: meta.walletName,
        network: meta.networkId,
        ...(meta.balance !== null ? { cachedBalance: meta.balance.toString() } : {}),
        ...(meta.syncTime ? { cachedSyncTime: meta.syncTime.toISOString() } : {}),
        ...(meta.coins !== undefined ? { cachedCoins: meta.coins } : {}),
        dustView: view,
      });
      if (!view.complete) this.exit(2);
      return;
    }

    this.log(`Wallet: ${meta.walletName}`);
    this.log(`Network: ${meta.networkId}`);
    this.log(`Source: ${meta.via === 'daemon' ? 'live view on the running daemon' : meta.via === 'cache' ? 'cached dust state' : 'no cached dust state'}`);
    if (meta.syncTime) this.log(`Cache last applied an event at: ${meta.syncTime.toISOString()}`);
    if (meta.balance !== null) this.log(`Cache balance now: ${formatDustBalance(meta.balance)} DUST across ${meta.coins ?? 0} coin(s)`);
    this.log('');
    this.log(view.complete ? '● Dust view is whole' : `○ Dust view is INCOMPLETE — ${view.reason}`);
    this.log(`  live generation entries on chain: ${view.liveEntries ?? '?'}`);
    this.log(`  local cursor ${view.localApplied ?? '?'} vs indexer tip ${view.indexerMaxId ?? '?'}${view.behindBy ? ` (behind by ${view.behindBy})` : ''}${view.stalled ? ' — STALLED' : ''}`);
    if (view.excluded > 0) this.log(`  coins without a generation record (excluded from balance): ${view.excluded}`);
    if (view.inconsistent) this.log('  the ledger rejected a replay: this cache cannot recover on retry');
    if (view.revertedSubmissions > 0) this.log(`  submissions never seen on chain, reverted: ${view.revertedSubmissions}`);
    for (const m of view.missing) {
      this.log(
        `  missing coin: ${formatNightStar(m.night)} NIGHT (generation ${m.generationMtIndex}, backing ${m.backingNight.slice(0, 12)}…) generating since ${m.generatingSince}, absent since ${m.missingSince}`,
      );
    }
    if (!view.complete) {
      this.log('');
      this.log(`Repair: moth dust rebuild --wallet ${meta.walletName} --network ${meta.networkId}`);
      this.exit(2);
    }
  }
}

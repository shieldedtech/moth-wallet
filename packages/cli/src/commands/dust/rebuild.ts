import { Flags } from '@oclif/core';
import { BaseCommand, daemonClientFlags } from '../../base-command.js';
import { clearDustSyncCache } from '@shieldedtech/moth-wallet';

interface RestartResult {
  started: boolean;
  reason?: string;
}

export default class DustRebuild extends BaseCommand {
  static override description =
    'Rebuild the DUST view from the chain: evict only the dust sync cache and resync it, keeping shielded, unshielded and history. ' +
    'With a running daemon or TUI hosting the wallet, the rebuild starts in place; otherwise the cache is evicted and the next sync rebuilds it. ' +
    'The resync starts from the pre-seed reference when the indexer proves the wallet has no earlier DUST history, and from genesis (slow) otherwise.';

  static override examples = [
    '<%= config.bin %> dust rebuild --wallet bot-0 --network preprod',
    '<%= config.bin %> dust rebuild --wallet bot-0 --network preprod --offline',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    offline: Flags.boolean({
      default: false,
      description: 'Do not look for a daemon; evict the cached dust state so the next sync rebuilds it',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DustRebuild);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    if (!flags.offline) {
      const { client } = await this.probeDaemon(network.id, walletName, { bind: flags.bind });
      if (client) {
        try {
          const result = await client.call<RestartResult>('rebuildDust', undefined, { timeoutMs: 120_000 });
          if (this.outputFormat === 'json') {
            this.outputSuccess({ via: 'daemon', ...result });
          } else if (result.started) {
            this.log(`Dust view rebuild started on the running daemon for "${walletName}" (${network.id}).`);
            this.log('Follow it with `moth wallet status` — dustSynced turns true again when the resync reaches the tip.');
          } else {
            this.log(`The daemon did not start a rebuild: ${result.reason ?? 'no reason given'}`);
          }
          return;
        } catch (err) {
          const { category, message } = this.renderDaemonError(err);
          this.outputError(category, message);
          this.exit(1);
          return;
        } finally {
          client.close();
        }
      }
      this.log_verbose(`No daemon is hosting "${walletName}" on ${network.id}; evicting the cached dust state instead.`);
    }

    await clearDustSyncCache(walletName, network.id);
    if (this.outputFormat === 'json') {
      this.outputSuccess({ via: 'cache', started: false, evicted: ['dust'] });
    } else {
      this.log(`Evicted the cached dust state of "${walletName}" on ${network.id}.`);
      this.log('The next sync of this wallet rebuilds its DUST view from the chain. Shielded, unshielded and history caches were left in place.');
    }
  }
}

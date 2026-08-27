// What is my DUST doing — answered from the wallet's own sync, not from a
// Cardano-side lookup.
//
// This command used to hand `WalletInfo.address` to the indexer's
// `dustGenerationStatus(cardanoRewardAddresses:)` query, with a comment saying
// the address was a placeholder. Two things were wrong with that (#107): the
// stored address is written once at create/import and carries THAT network's
// HRP, so `--network preprod` changed the indexer and not the address; and a
// Midnight address is never a valid Cardano reward address, so the query could
// only ever answer by accident. On preprod it failed outright:
//
//   Error [NETWORK_ERROR]: Indexer error: invalid Cardano reward address:
//   invalid HRP for Cardano reward address: mn_addr_devnet
//
// The wallet's own generation state answers the question directly, on any
// network the wallet is on, and is what the TUI's DUST panel already shows.
// `--reward-address` keeps the Cardano lookup available for the different
// question it actually answers.

import {Flags} from '@oclif/core';
import {
  IndexerClient,
  startWalletSync,
  NIGHT_DENOMINATION,
  formatBalance,
  type SyncedWallet,
  type WalletBalances,
} from '@shieldedtech/moth-wallet';
import {BaseCommand} from '../../base-command.js';
import {getPassphrase} from '../../adapters/passphrase.js';

/** Cardano reward (stake) address prefixes — mainnet and test networks. */
const REWARD_ADDRESS_PREFIXES = ['stake1', 'stake_test1'] as const;

export function isCardanoRewardAddress(value: string): boolean {
  return REWARD_ADDRESS_PREFIXES.some((p) => value.startsWith(p));
}

export default class DustStatus extends BaseCommand {
  static override description =
    "Show this wallet's DUST generation: whether its NIGHT is registered, how much is generating, the rate and the cap. Reads the wallet's own state, so it works on whichever network the wallet is used on. Use --reward-address to ask the indexer about a Cardano reward address instead — a different question, answered from the Cardano side.";

  static override examples = [
    '<%= config.bin %> <%= command.id %> --wallet alice --network preprod',
    '<%= config.bin %> <%= command.id %> --reward-address stake1u9...',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    'reward-address': Flags.string({
      description:
        'Ask the indexer whether this Cardano reward address (stake1… / stake_test1…) is registered for DUST generation. Skips the wallet entirely — no unlock, no sync.',
    }),
    'wait-timeout-ms': Flags.integer({
      description:
        "How long to wait for the wallet's DUST state to arrive. The dust stream is the slowest, but registration comes from the unshielded one, so this usually returns well before a full sync.",
      default: 120_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DustStatus);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Cardano-side lookup: an explicit reward address, validated rather than
    // assumed. The old code forwarded whatever it had and let the indexer's
    // parser produce the diagnostic.
    const rewardAddress = flags['reward-address'];
    if (rewardAddress) {
      if (!isCardanoRewardAddress(rewardAddress)) {
        this.outputError(
          'INVALID_INPUT',
          `--reward-address expects a Cardano reward address (stake1… or stake_test1…); got "${rewardAddress}". A Midnight address (mn_addr_…) is a different thing — omit the flag to read this wallet's own DUST state instead.`,
        );
        this.exit(2);
        return;
      }
      const client = new IndexerClient(network.indexerUrl);
      const [status] = await client.getDustGenerationStatus([rewardAddress]);
      this.outputSuccess({
        source: 'cardano-reward-address',
        rewardAddress,
        network: network.id,
        registered: status?.registered ?? false,
        dustAddress: status?.dustAddress ?? null,
        nightBalance: status?.nightBalance ?? '0',
        generationRate: status?.generationRate ?? '0',
        maxCapacity: status?.maxCapacity ?? '0',
        currentCapacity: status?.currentCapacity ?? '0',
      });
      return;
    }

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const unlocked = await this.walletManager.unlock(walletName, passphrase);

    process.stderr.write('Reading DUST state…\n');
    const synced: SyncedWallet = await startWalletSync(
      unlocked.walletKeys,
      network,
      (msg) => this.log_verbose(`[sync] ${msg}`),
      walletName,
    );

    try {
      const balances = await waitForDustState(synced, flags['wait-timeout-ms']);
      const gen = balances.dustGeneration;

      if (!gen) {
        this.outputSuccess({
          source: 'wallet',
          wallet: walletName,
          network: network.id,
          available: false,
          note: 'The wallet has not reported DUST generation state yet. Its dust stream may still be starting; try again, or raise --wait-timeout-ms.',
        });
        return;
      }

      this.outputSuccess({
        source: 'wallet',
        wallet: walletName,
        network: network.id,
        available: true,
        registered: gen.registered,
        // Registered NIGHT is the part that actually generates: balance beyond it
        // contributes no capacity until it is registered too.
        registeredNight: gen.registeredNight.toString(),
        registeredNightDecimal: formatBalance(gen.registeredNight, NIGHT_DENOMINATION),
        dust: gen.balance.toString(),
        designated: gen.designated.toString(),
        ratePerDay: gen.ratePerDay.toString(),
        limit: gen.limit.toString(),
        utxos: gen.numUtxos,
        fillsAt: gen.fillTime.toISOString(),
        // Says whether the numbers above are final or still catching up, rather
        // than presenting a mid-sync reading as settled.
        dustSynced: balances.syncProgress.dustSynced,
        synced: balances.synced,
      });
    } finally {
      await synced.stop().catch(() => {});
    }
  }
}

/**
 * Resolve once the wallet reports DUST generation, or on timeout.
 *
 * Deliberately not gated on `balances.synced`: the dust stream is the slowest by
 * two orders of magnitude, and registration state comes from the unshielded one —
 * the same reason `operations.ts` gates registration on unshielded strict-complete
 * rather than the aggregate. Waiting for everything would turn a question about
 * registration into a full chain walk.
 */
function waitForDustState(synced: SyncedWallet, timeoutMs: number): Promise<WalletBalances> {
  if (synced.balances.dustGeneration) return Promise.resolve(synced.balances);

  return new Promise<WalletBalances>((resolveOuter) => {
    let settled = false;
    const finish = (b: WalletBalances) => {
      if (settled) return;
      settled = true;
      try {
        unsub();
      } catch {
        /* idempotent */
      }
      clearTimeout(timer);
      resolveOuter(b);
    };
    const unsub = synced.subscribe((b: WalletBalances) => {
      if (b.dustGeneration) finish(b);
    });
    // On timeout, hand back whatever the latest snapshot holds; the caller
    // reports `available: false` rather than pretending to know.
    const timer = setTimeout(() => finish(synced.balances), timeoutMs).unref();
  });
}

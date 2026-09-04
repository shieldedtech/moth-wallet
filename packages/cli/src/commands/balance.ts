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
  unshieldedSplit,
  startWalletSync,
  NIGHT_TOKEN_ID,
  NIGHT_DENOMINATION,
  formatBalance,
  formatDustBalance,
  type SyncedWallet,
  type WalletBalances,
} from '@shieldedtech/moth-wallet';

interface TokenRow {
  readonly tokenId: string;
  /** Protocol name where one exists ("NIGHT"); absent for contract-issued tokens. */
  readonly name?: string;
  /** Raw smallest-unit amount. */
  readonly amount: string;
  /**
   * Major-unit amount, present ONLY for tokens with a protocol denomination.
   * Contract-issued tokens have no decimals, so a "decimal" form would be a
   * fiction — see the note on `unit`.
   */
  readonly decimal?: string;
  /**
   * Name of the smallest unit ("STARS"), present only where one exists.
   * Deliberately absent for contract-issued tokens: STARS is the base unit of
   * NIGHT specifically, and labelling any other token's raw amount in STARS is
   * simply wrong.
   */
  readonly unit?: string;
}

interface BalanceResult {
  readonly wallet: string;
  readonly network: string;
  readonly synced: boolean;
  /**
   * Grouped by what the ledger actually distinguishes: unshielded, shielded,
   * DUST. NIGHT is a token, not a category, so it appears as a row under
   * unshielded rather than heading a section.
   *
   * No per-category total: different tokens are not summable, so a total is
   * only ever meaningful per token id.
   */
  readonly balances: {
    readonly unshielded: readonly TokenRow[];
    readonly shielded: readonly TokenRow[];
    readonly dust: {
      readonly speck: string;
      readonly dust: string;
    };
  };
  /**
   * NIGHT spendability. Separate from the rows because it is a property of the
   * UTxO set, not of the balance: a wallet can show NIGHT it cannot currently
   * spend because a transaction in flight reserves it.
   */
  readonly nightSpendable?: {
    readonly available: string;
    readonly reserved: string;
  };
  /**
   * Individual spendable shielded coins, present only with --coins.
   *
   * These are what a Compact circuit needs to SPEND a coin: `nonce`, `type`,
   * `value` and `mtIndex` together form a `QualifiedShieldedCoinInfo`. A DApp
   * cannot derive them — the DApp connector exposes no coin enumeration, and
   * the indexer's contract-filtered Zswap state cannot yield a global Merkle
   * index — so the wallet has to report them.
   */
  readonly shieldedCoins?: ReadonlyArray<{
    readonly nonce: string | null;
    readonly type: string;
    readonly value: string;
    readonly mtIndex: string | null;
    readonly commitment: string | null;
    readonly nullifier: string | null;
    readonly status: 'available' | 'pending';
  }>;
}

export default class Balance extends BaseCommand {
  static override description =
    "Show the wallet's NIGHT (shielded + unshielded), DUST, and any non-NIGHT token balances. Spins up its own sync, so first-call latency is the full sync time; subsequent calls share the on-disk cache and complete faster. Use `moth wallet status` instead when a daemon is already running for this wallet — that path is instant.";

  static override flags = {
    ...BaseCommand.baseFlags,
    coins: Flags.boolean({
      description:
        'Also list individual shielded coins with the fields needed to spend them ' +
        '(nonce, type, value, Merkle index, commitment, nullifier). Required when ' +
        'passing a coin to a Compact circuit as a QualifiedShieldedCoinInfo — for ' +
        'example `moth call unwrap --args` on a contract that takes a coin.',
      default: false,
    }),
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
    // Same instrument the extension uses, writing ~/.moth/timings.json. Off
    // unless enabled, so this costs one file read otherwise. Worth having here
    // in particular: a headless sync gives no other signal about where the time
    // went, and sync is the phase that takes it.
    await this.timings.record('marker', 'balance: sync start');
    const synced: SyncedWallet = await startWalletSync(
      wallet.walletKeys,
      network,
      (msg) => {
        this.log_verbose(`[sync] ${msg}`);
        void this.timings.record('sync', msg);
      },
      walletName,
      false,
      await this.syncBirthday(walletName, network.id),
    );

    try {
      await waitForSynced(synced, flags['wait-timeout-ms']);
      await this.timings.record('marker', 'balance: synced (balances readable)');

      const b = synced.balances;
      const split = unshieldedSplit(b.coins, NIGHT_TOKEN_ID);

      // NIGHT is an UNSHIELDED token. There is no shielded NIGHT, so it is not
      // read from b.shielded and no permanently-zero "shielded NIGHT" line is
      // printed. token-list.ts, dust-view.ts and dust/register.ts already treat
      // it this way.
      const unshNight = (b.unshielded[NIGHT_TOKEN_ID] ?? 0n) as bigint;

      const nightRow = (amount: bigint): TokenRow => ({
        tokenId: NIGHT_TOKEN_ID,
        name: 'NIGHT',
        amount: amount.toString(),
        decimal: formatBalance(amount, NIGHT_DENOMINATION),
        unit: 'STARS',
      });
      // Contract-issued tokens have no protocol decimals, so they carry a raw
      // amount and no unit — anything else would invent a denomination.
      const tokenRow = (tokenId: string, amount: bigint): TokenRow => ({
        tokenId,
        amount: amount.toString(),
      });

      const unshielded: TokenRow[] = [
        ...(unshNight > 0n || Object.keys(b.unshielded).length === 0 ? [nightRow(unshNight)] : [nightRow(unshNight)]),
        ...Object.entries(b.unshielded)
          .filter(([tokenId]) => tokenId !== NIGHT_TOKEN_ID)
          .map(([tokenId, amount]) => tokenRow(tokenId, amount as bigint)),
      ];
      const shielded: TokenRow[] = Object.entries(b.shielded)
        // Defensive: a shielded NIGHT entry would be meaningless, and some
        // callers still synthesise one.
        .filter(([tokenId]) => tokenId !== NIGHT_TOKEN_ID)
        .map(([tokenId, amount]) => tokenRow(tokenId, amount as bigint));

      // Individual shielded coins, only when asked for: this is the spendable
      // detail (nonce + Merkle index) that a circuit needs and that nothing
      // outside the wallet can reconstruct.
      const shieldedCoins = flags.coins
        ? [
            ...b.coins.shielded.available.map((c) => ({
              nonce: c.nonce ?? null,
              type: c.type,
              value: c.value.toString(),
              mtIndex: c.mtIndex?.toString() ?? null,
              commitment: c.commitment ?? null,
              nullifier: c.nullifier ?? null,
              status: 'available' as const,
            })),
            ...b.coins.shielded.pending.map((c) => ({
              nonce: c.nonce ?? null,
              type: c.type,
              value: c.value.toString(),
              // Pending coins are not in the commitment tree yet.
              mtIndex: null,
              commitment: c.commitment ?? null,
              nullifier: c.nullifier ?? null,
              status: 'pending' as const,
            })),
          ]
        : undefined;

      const result: BalanceResult = {
        wallet: walletName,
        network: network.id,
        synced: b.synced,
        balances: {
          unshielded,
          shielded,
          dust: {
            speck: b.dust.toString(),
            dust: formatDustBalance(b.dust),
          },
        },
        ...(split.reserved > 0n
          ? {
              nightSpendable: {
                available: split.available.toString(),
                reserved: split.reserved.toString(),
              },
            }
          : {}),
        ...(shieldedCoins ? {shieldedCoins} : {}),
      };

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
        return;
      }

      const idCol = (row: TokenRow) => (row.name ?? `${row.tokenId.slice(0, 16)}…`).padEnd(18);

      this.log(`Wallet:  ${walletName}`);
      this.log(`Network: ${network.id}`);
      this.log(`Synced:  ${b.synced ? 'yes' : 'no (snapshot may be incomplete)'}`);

      // Three categories, each listing every token it holds in its own correct
      // unit. No cross-token totals: different tokens are not summable.
      this.log('');
      this.log('Unshielded:');
      for (const row of unshielded) {
        const suffix = row.unit ? `  (${row.amount} ${row.unit})` : '  (raw)';
        this.log(`  ${idCol(row)}${row.decimal ?? row.amount}${suffix}`);
      }
      // Only when it matters. On a wallet with nothing reserved this is noise;
      // on one that cannot spend what it shows, it is the whole story.
      if (split.reserved > 0n) {
        this.log(`    NIGHT available:  ${formatBalance(split.available, NIGHT_DENOMINATION)}  ← what a transfer can use`);
        this.log(`    NIGHT reserved:   ${formatBalance(split.reserved, NIGHT_DENOMINATION)}  (a transaction in flight holds these)`);
      }

      this.log('');
      this.log('Shielded:');
      if (shielded.length === 0) {
        this.log('  (none)');
      } else {
        for (const row of shielded) {
          this.log(`  ${idCol(row)}${row.amount}  (raw)`);
        }
      }

      this.log('');
      this.log('DUST:');
      this.log(`  ${formatDustBalance(b.dust)} DUST  (${b.dust.toString()} SPECK)`);

      if (shieldedCoins) {
        this.log('');
        if (shieldedCoins.length === 0) {
          this.log('Shielded coins: none');
        } else {
          this.log(`Shielded coins (${shieldedCoins.length}):`);
          for (const c of shieldedCoins) {
            this.log(`  ${c.value}  type ${c.type}`);
            this.log(`    nonce      ${c.nonce ?? '(unknown)'}`);
            this.log(`    mt_index   ${c.mtIndex ?? '(pending — not in the tree yet)'}`);
            this.log(`    commitment ${c.commitment ?? '(unknown)'}`);
            this.log(`    status     ${c.status}`);
          }
          this.log('');
          this.log('  To spend one in a circuit taking a QualifiedShieldedCoinInfo, pass');
          this.log('  {nonce, color/type, value, mt_index} — hex as "0x…", numbers as "123n".');
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

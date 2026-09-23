import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import { getPassphrase } from '../adapters/passphrase.js';
import {
  describeReservation,
  unshieldedSplit,
  formatBalance,
  NIGHT_DENOMINATION,
  sendTokensWithKeys,
  startWalletSync,
  NIGHT_TOKEN_ID,
  InvalidAmountError,
  parseNightAmount,
  submitWithHealthTracking,
  type SendRequest,
  type SyncedWallet,
  type WalletBalances,
  IndexerClient,
} from '@shieldedtech/moth-wallet';

export default class Transfer extends BaseCommand {
  static override description = 'Transfer NIGHT tokens';

  static override args = {
    amount: Args.string({ description: 'Amount to transfer (in NIGHT)', required: false }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    to: Flags.string({ required: false, description: 'Recipient address' }),
    // #62: the token was hardcoded, so a wallet holding anything other than
    // NIGHT could spend it only through `daemon transfer --token-id`. Same flag
    // name and the same NIGHT default, so the two paths agree.
    'token-id': Flags.string({
      description: 'Token id (64-char hex). Defaults to NIGHT.',
      default: NIGHT_TOKEN_ID,
    }),
    // Raw smallest units, for tokens whose decimals moth does not know. The
    // positional amount is a NIGHT decimal and is meaningless for those.
    amount: Flags.string({
      description: 'Amount in raw smallest units (required for non-NIGHT tokens)',
    }),
    shielded: Flags.boolean({ default: false, description: 'Use shielded transfer' }),
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip confirmation prompt',
    }),
    'wait-inclusion': Flags.boolean({
      default: false,
      description:
        'After submission, wait until the indexer shows the transaction before exiting. For scripted runs of several transfers from one wallet: each `moth transfer` re-syncs from the indexer, which runs seconds to minutes behind the chain, so the next transfer can otherwise select an input the chain has already spent and fail at submission.',
    }),
    'wait-inclusion-timeout-ms': Flags.integer({
      default: 180_000,
      description: 'How long --wait-inclusion waits before giving up (the transfer itself has already been submitted)',
    }),
    'wait-timeout-ms': Flags.integer({
      description:
        'How long to wait for the wallet to reach synced=true before building the transfer. ' +
        'Building against a not-yet-synced wallet spends against a stale root, which the node ' +
        'rejects ("Transaction submission error"). Default 5 minutes; after timeout it builds ' +
        'anyway against the latest snapshot.',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Transfer);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const to = await this.promptIfMissing(flags.to, 'Recipient address');
    const tokenId = flags['token-id'] ?? NIGHT_TOKEN_ID;
    const isNight = tokenId === NIGHT_TOKEN_ID;

    // Two ways in, and only one is valid per token. --amount is raw base units
    // and works for anything; the positional is a NIGHT decimal, so it is refused
    // for other tokens rather than silently scaled by NIGHT's 10^6 (#62).
    let amount: bigint;
    let amountLabel: string;
    if (flags.amount !== undefined) {
      if (!/^\d+$/.test(flags.amount.trim())) {
        this.outputError('INVALID_INPUT', `--amount must be a whole number of base units, got "${flags.amount}"`);
        this.exit(1);
        return;
      }
      amount = BigInt(flags.amount.trim());
      if (amount === 0n) {
        this.outputError('INVALID_INPUT', 'Amount is zero — that moves nothing and still pays a fee');
        this.exit(1);
        return;
      }
      amountLabel = isNight ? `${flags.amount} base units (NIGHT)` : `${flags.amount} base units`;
    } else if (!isNight) {
      this.outputError(
        'INVALID_INPUT',
        'A non-NIGHT token needs --amount in raw base units.',
        'The positional amount is a NIGHT decimal, and moth does not know this token\'s decimals.',
      );
      this.exit(1);
      return;
    } else {
      const amountStr = await this.promptIfMissing(args.amount, 'Amount to transfer (NIGHT)');
      try {
        // Strict, shared with the daemon path. The previous parseFloat accepted
        // "1,5" as 1 NIGHT and "0.0000001" as a zero transfer (#63).
        amount = parseNightAmount(amountStr);
      } catch (err) {
        if (err instanceof InvalidAmountError) {
          this.outputError('INVALID_INPUT', err.message);
          this.exit(1);
          return;
        }
        throw err;
      }
      amountLabel = `${amountStr} NIGHT`;
    }

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    this.log_verbose(`Transferring ${amountLabel} to ${to} (shielded: ${flags.shielded})`);

    // SR-003: Confirm transaction before proceeding
    await this.confirmTransaction({
      'Operation': flags.shielded ? 'Shielded transfer' : 'Unshielded transfer',
      'Amount': amountLabel,
      ...(isNight ? {} : {'Token': tokenId}),
      'Recipient': to,
      'Network': network.id,
      'Wallet': walletName,
    }, flags);

    process.stderr.write('Syncing wallet before transfer...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg) => {
      this.log_verbose(msg);
    }, walletName, false, await this.syncBirthday(walletName, network.id));

    try {
      // Wait for the wallet to reach synced=true BEFORE building the tx.
      // startWalletSync only kicks off syncing; without this wait the transfer
      // is built/proved/submitted against a stale (pre-tip) state and dust root,
      // which the node rejects as a generic "Transaction submission error". The
      // dust sub-wallet in particular must be synced to tip for the fee proof to
      // validate. (balance / daemon-serve already gate on this; transfer didn't.)
      await waitForSynced(syncedWallet, flags['wait-timeout-ms']);
      if (!syncedWallet.balances.synced) {
        process.stderr.write(
          'Warning: wallet not fully synced before wait-timeout-ms; building anyway (submission may fail).\n',
        );
      }

      const req: SendRequest = {
        type: flags.shielded ? 'shielded' : 'unshielded',
        tokenId,
        amount,
        to,
      };

      let txHash: string;
      try {
        // Reclassifies a persistent run of InvalidDustSpendProof rejections as a
        // wedged devnet dust ledger instead of a normal failure retried forever —
        // see core/sync/dust-ledger-health.ts.
        txHash = await submitWithHealthTracking(
          () => sendTokensWithKeys(syncedWallet.facade, wallet.walletKeys, network.id, [req], (stage) => {
            process.stderr.write(`Transfer: ${stage}\n`);
          }),
          {network, walletName},
        );
      } catch (err) {
        // "Insufficient funds" on a wallet that just reported a sufficient
        // balance is not a contradiction: the balance counts coins reserved by
        // transactions in flight, and only available coins can be spent (#72).
        // Say which number blocked it rather than leaving the two irreconcilable.
        const message = err instanceof Error ? err.message : String(err);
        if (/insufficient funds/i.test(message)) {
          const split = unshieldedSplit(syncedWallet.balances.coins, tokenId);
          const detail = describeReservation(split, amount, (raw) =>
            isNight ? `${formatBalance(raw, NIGHT_DENOMINATION)} NIGHT` : `${raw} base units`,
          );
          if (detail) {
            this.outputError('WALLET_ERROR', `Insufficient available funds. ${detail}`);
            this.exit(1);
            return;
          }
        }
        throw err;
      }

      let inclusion: {included: boolean; blockHeight?: number; waitedMs: number} | undefined;
      if (flags['wait-inclusion']) {
        process.stderr.write('Transfer: submitted, waiting for the indexer to show it...\n');
        inclusion = await waitForInclusion(new IndexerClient(network.indexerUrl), txHash, flags['wait-inclusion-timeout-ms']);
        process.stderr.write(
          inclusion.included
            ? `Transfer: included in block ${inclusion.blockHeight} after ${Math.round(inclusion.waitedMs / 1000)}s\n`
            : `Transfer: not seen by the indexer after ${Math.round(inclusion.waitedMs / 1000)}s — it may still land; check the hash before retrying\n`,
        );
      }

      this.outputSuccess({
        txHash,
        // Base units, unambiguously — the previous field echoed whatever the user
        // typed, which is a different thing from what was sent.
        amount: amount.toString(),
        amountLabel,
        tokenId,
        recipient: to,
        shielded: flags.shielded,
        network: network.id,
        ...(inclusion ? {inclusion} : {}),
      });
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

/**
 * Resolve once `balances.synced` flips to true, or once `timeoutMs` elapses
 * (whichever comes first). Mirrors balance.ts — on timeout the caller proceeds
 * with whatever the latest snapshot showed and can read `balances.synced` to
 * know whether it was authoritative.
 */
/** Poll the indexer for the transaction until it is included or the deadline passes. */
async function waitForInclusion(
  indexer: IndexerClient,
  txHash: string,
  timeoutMs: number,
  pollMs = 5_000,
): Promise<{included: boolean; blockHeight?: number; waitedMs: number}> {
  const started = Date.now();
  for (;;) {
    try {
      const found = await indexer.getTransactions({hash: txHash});
      if (found.length > 0) return {included: true, blockHeight: found[0]!.block?.height, waitedMs: Date.now() - started};
    } catch {
      /* indexer hiccup: keep polling until the deadline */
    }
    if (Date.now() - started >= timeoutMs) return {included: false, waitedMs: Date.now() - started};
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

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

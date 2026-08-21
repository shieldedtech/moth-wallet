import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import { getPassphrase } from '../adapters/passphrase.js';
import {
  sendTokensWithKeys,
  startWalletSync,
  NIGHT_TOKEN_ID,
  type SendRequest,
  type SyncedWallet,
  type WalletBalances,
} from '@shieldedtech/moth-wallet';

export default class Transfer extends BaseCommand {
  static override description = 'Transfer NIGHT tokens';

  static override args = {
    amount: Args.string({ description: 'Amount to transfer (in NIGHT)', required: false }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    to: Flags.string({ required: false, description: 'Recipient address' }),
    shielded: Flags.boolean({ default: false, description: 'Use shielded transfer' }),
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip confirmation prompt',
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

    const amountStr = await this.promptIfMissing(args.amount, 'Amount to transfer (NIGHT)');
    const to = await this.promptIfMissing(flags.to, 'Recipient address');

    // Parse amount: support decimal (e.g. "1.5") → multiply by 10^6 for base units
    const parsed = parseFloat(amountStr);
    if (Number.isNaN(parsed) || parsed <= 0) {
      this.outputError('INVALID_INPUT', `Invalid amount: ${amountStr}`);
      this.exit(1);
      return;
    }
    const amount = BigInt(Math.round(parsed * 1_000_000));

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    this.log_verbose(`Transferring ${amountStr} NIGHT to ${to} (shielded: ${flags.shielded})`);

    // SR-003: Confirm transaction before proceeding
    await this.confirmTransaction({
      'Operation': flags.shielded ? 'Shielded transfer' : 'Unshielded transfer',
      'Amount': `${amountStr} NIGHT`,
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
        tokenId: NIGHT_TOKEN_ID,
        amount,
        to,
      };

      const txHash = await sendTokensWithKeys(syncedWallet.facade, wallet.walletKeys, network.id, [req], (stage) => {
        process.stderr.write(`Transfer: ${stage}\n`);
      });

      this.outputSuccess({
        txHash,
        amount: amountStr,
        recipient: to,
        shielded: flags.shielded,
        network: network.id,
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

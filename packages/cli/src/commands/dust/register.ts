import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import {
  NIGHT_TOKEN_ID,
  designateForDustWithKeys,
  estimateDustRegistration,
  describeWait,
  DustRegistrationNotYetError,
  startWalletSync,
  submitWithHealthTracking,
} from '@shieldedtech/moth-wallet';

export default class DustRegister extends BaseCommand {
  static override description = 'Register wallet for DUST generation';

  static override flags = {
    ...BaseCommand.baseFlags,
    receiver: Flags.string({
      description: 'DUST receiver address override (default: own DUST address)',
    }),
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip confirmation prompt',
    }),
    // Registration self-funds from the DUST its NIGHT would already have
    // generated, so a freshly funded wallet has to wait. Without this the only
    // option is to re-run the command — which re-syncs first, so the wait costs
    // far more than it should.
    wait: Flags.boolean({
      default: false,
      description: 'Wait until the registration fee is covered, instead of exiting',
    }),
    'wait-timeout': Flags.integer({
      default: 3600,
      description: 'Seconds to keep waiting with --wait before giving up',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DustRegister);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // SR-003: Confirm transaction
    await this.confirmTransaction({
      'Operation': 'Register for DUST generation',
      'Network': network.id,
      'Wallet': walletName,
      ...(flags.receiver ? { 'Receiver': flags.receiver } : {}),
    }, flags);

    process.stderr.write('Syncing wallet before registration...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg) => {
      this.log_verbose(msg);
    }, walletName, false, await this.syncBirthday(walletName, network.id));

    try {
      // Ask before building. The estimate is the only place the wait is
      // knowable, and finding out by failing means paying for a sync first.
      let estimate = await estimateDustRegistration(syncedWallet.facade);
      if (!estimate.affordable) {
        if (estimate.secondsUntilAffordable === null) {
          this.outputError(
            'WALLET_ERROR',
            'This wallet does not hold enough NIGHT to cover the registration fee, and waiting will not change that.',
            'Registration pays its own fee from the DUST its NIGHT would already have generated; that amount is capped by how much NIGHT you hold. Fund the wallet with more NIGHT.',
          );
          this.exit(1);
        }
        if (!flags.wait) {
          this.outputSuccess({
            status: 'not_yet',
            message:
              `Registration pays its own fee from the DUST this NIGHT has generated since it arrived. ` +
              `Ready in ${describeWait(estimate.secondsUntilAffordable)}. Re-run with --wait to block until then.`,
            feeSpecks: estimate.fee.toString(),
            availableSpecks: estimate.available.toString(),
            secondsUntilAffordable: estimate.secondsUntilAffordable,
            wallet: walletName,
            network: network.id,
          });
          return;
        }
        // Poll rather than sleeping the whole predicted wait in one go: the
        // estimate moves if the wallet's NIGHT changes under us, and a long
        // blind sleep would report success or failure minutes late either way.
        const deadline = Date.now() + flags['wait-timeout'] * 1_000;
        while (!estimate.affordable) {
          if (Date.now() >= deadline) {
            this.outputError(
              'WALLET_ERROR',
              `Still short of the registration fee after ${flags['wait-timeout']}s.`,
              `Needed ${describeWait(estimate.secondsUntilAffordable ?? 0)} at the last check; raise --wait-timeout or hold more NIGHT.`,
            );
            this.exit(1);
          }
          const remaining = estimate.secondsUntilAffordable ?? 30;
          const sleepSeconds = Math.min(Math.max(remaining, 5), 30);
          process.stderr.write(
            `Waiting for generated DUST to cover the fee — ${describeWait(remaining)} to go...\n`,
          );
          await new Promise((r) => setTimeout(r, sleepSeconds * 1_000));
          estimate = await estimateDustRegistration(syncedWallet.facade);
        }
      }

      // Reclassifies a persistent run of InvalidDustSpendProof rejections as a
      // wedged devnet dust ledger instead of a normal failure the operator
      // retries forever — see core/sync/dust-ledger-health.ts.
      const txHash = await submitWithHealthTracking(
        () => designateForDustWithKeys(
          syncedWallet.facade,
          wallet.walletKeys,
          network.id,
          flags.receiver,
          (stage) => { process.stderr.write(`DUST register: ${stage}\n`); },
        ),
        {network, walletName},
      );

      if (txHash) {
        this.outputSuccess({
          status: 'registered',
          txHash,
          wallet: walletName,
          network: network.id,
        });
      } else {
        // A null tx hash means designateForDust found nothing to designate, and
        // that has TWO causes it cannot tell apart: every UTXO is already
        // designated, or there are no NIGHT UTXOs at all. Reporting the first for
        // both is vacuously true of an empty wallet and reads as success — which
        // is how an unfunded wallet looks configured (#58). The balance in hand
        // separates them.
        const night = (syncedWallet.balances.unshielded[NIGHT_TOKEN_ID] ?? 0n) as bigint;
        if (night === 0n) {
          this.outputError(
            'WALLET_ERROR',
            'No NIGHT to designate for DUST generation.',
            'Fund this wallet first — DUST is generated by NIGHT you hold, so there is nothing to register yet.',
          );
          this.exit(1);
          return;
        }
        this.outputSuccess({
          status: 'already_registered',
          message: 'All NIGHT UTXOs already registered for DUST generation',
          nightBalance: night.toString(),
          wallet: walletName,
        });
      }
    } catch (err) {
      // Belt and braces: the pre-flight above should have caught this, but the
      // wallet's NIGHT can change between the estimate and the build. Report it
      // as "not yet" rather than as a stack trace either way.
      if (err instanceof DustRegistrationNotYetError) {
        this.outputError('WALLET_ERROR', err.message, 'Re-run with --wait to block until the fee is covered.');
        this.exit(1);
      }
      throw err;
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

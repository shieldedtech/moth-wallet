import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import {
  loadBatchFile,
  executeBatchTransfer,
  batchExitCode,
  startWalletSync,
  type BatchTransferEntry,
} from '@shieldedtech/moth-wallet';
import { readFileSync } from 'node:fs';

export default class TransferBatch extends BaseCommand {
  static override description = 'Execute batch transfers from a JSON file';

  static override args = {
    file: Args.string({
      description: 'Path to JSON batch file (use @stdin to read from stdin)',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip confirmation prompt',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TransferBatch);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const filePath = await this.promptIfMissing(args.file, 'Path to batch JSON file (or @stdin)');

    let entries: BatchTransferEntry[];
    if (filePath === '@stdin' || filePath === '-') {
      const raw = readFileSync('/dev/stdin', 'utf-8');
      entries = JSON.parse(raw);
    } else {
      entries = loadBatchFile(filePath);
    }

    if (entries.length === 0) {
      this.outputError('INVALID_INPUT', 'Batch file contains no transfer entries');
      this.exit(1);
      return;
    }

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // SR-003: Confirm batch
    await this.confirmTransaction({
      'Operation': 'Batch transfer',
      'Entries': `${entries.length} transfers`,
      'Network': network.id,
      'Wallet': walletName,
    }, flags);

    process.stderr.write('Syncing wallet before batch transfer...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg) => {
      this.log_verbose(msg);
    }, walletName, false, await this.syncBirthday(walletName, network.id));

    try {
      const summary = await executeBatchTransfer(
        syncedWallet.facade,
        wallet.walletKeys,
        network.id,
        entries,
        (index, stage) => {
          process.stderr.write(`Transfer ${index + 1}/${entries.length}: ${stage}\n`);
        },
      );

      this.outputSuccess(summary);
      const exitCode = batchExitCode(summary);
      if (exitCode !== 0) {
        this.exit(exitCode);
      }
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

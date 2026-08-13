// Submit a pre-built finalized transaction through the running TUI's
// daemon. The CLI never sees or holds spending keys for this path —
// the caller produced the tx elsewhere (e.g., `moth transfer
// --no-submit --output-hex` once that flag exists, or via the SDK
// directly) and the TUI's facade does the actual on-chain submission
// after the human approves in the L3 modal.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../base-command.js';

interface SubmitTxResult {
  txId: string;
}

export default class DaemonSubmitTx extends BaseCommand {
  static override description =
    'Submit a pre-built finalized transaction through the running TUI daemon. The TUI surfaces an L3 confirmation modal; the call hangs until the user answers.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    hex: Flags.string({
      description: 'Hex-encoded FinalizedTransaction. Omit to read from stdin.',
    }),
    summary: Flags.string({
      description: 'Short description shown in the TUI confirmation modal',
      default: 'External CLI requested a transaction submit',
    }),
    detail: Flags.string({
      description: 'Additional context lines for the modal (repeatable)',
      multiple: true,
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 120000)',
      default: 120_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonSubmitTx);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Hex from --hex, else from stdin. CLI args are visible in `ps`, so a
    // tx hex containing nullifiers / commitments shouldn't go on the
    // command line — stdin is the recommended path.
    let hex = flags.hex;
    if (!hex) {
      if (process.stdin.isTTY) {
        this.outputError(
          'INVALID_INPUT',
          'No --hex provided and stdin is a TTY. Pipe the hex: moth transfer --no-submit ... | moth daemon submit-tx',
        );
        this.exit(2);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      hex = Buffer.concat(chunks).toString('utf-8').trim();
    }
    if (!hex) {
      this.outputError('INVALID_INPUT', 'Empty transaction hex');
      this.exit(2);
      return;
    }

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      // Pre-flight: if the daemon's wallet facade isn't ready yet (TUI
      // just started, wallet still unlocking, etc.), short-circuit
      // before we trigger a confirmation modal that can't proceed.
      const state = await client.call<{ready: boolean}>('getState');
      if (!state.ready) {
        this.outputError(
          'WALLET_ERROR',
          `TUI is running but the wallet facade for "${walletName}" is still initializing on ${network.id}. Wait for the TUI to finish unlocking / starting sync and retry.`,
        );
        this.exit(1);
        return;
      }

      this.log_verbose(`Sending submitTransaction (${Math.floor(hex.length / 2)} bytes) via daemon ${client.daemonVersion}`);
      const result = await client.call<SubmitTxResult>(
        'submitTransaction',
        {hex, summary: flags.summary, details: flags.detail},
        {timeoutMs: flags['timeout-ms']},
      );

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Submitted. Transaction id: ${result.txId}`);
      }
    } catch (err) {
      const {category, message} = this.renderDaemonError(err);
      this.outputError(category, message);
      this.exit(1);
      return;
    } finally {
      client.close();
    }
  }
}

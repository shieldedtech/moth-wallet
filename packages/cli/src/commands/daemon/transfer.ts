// High-level transfer through the TUI's daemon. The CLI sends operation
// intent (recipient + token + amount); the TUI's facade does the whole
// pipeline — balance, prove via the proof server, sign, submit — and
// returns the on-chain tx hash. Spending keys never leave the TUI.
//
// Amount input: the wire format is always raw smallest-unit decimal.
// On the CLI side, --amount is raw; --night is a convenience shortcut
// that multiplies a NIGHT decimal by 10^6 (STARS per NIGHT) and only
// works when the resolved tokenId is NIGHT.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../base-command.js';

const NIGHT_TOKEN_ID = '0'.repeat(64);
const STARS_PER_NIGHT = 1_000_000n;

interface TransferResult {
  txId: string;
}

export default class DaemonTransfer extends BaseCommand {
  static override description =
    'Transfer tokens through the running TUI daemon. The TUI builds, balances, proves (via the proof server) and submits the transaction; spending keys never leave the TUI. Triggers an L3 confirmation modal in the TUI before the transfer goes out.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    to: Flags.string({
      description: 'Recipient bech32m address',
      required: true,
    }),
    'token-id': Flags.string({
      description: 'Token id (64-char hex). Defaults to NIGHT.',
      default: NIGHT_TOKEN_ID,
    }),
    type: Flags.string({
      description: 'Transfer path',
      options: ['shielded', 'unshielded'],
      default: 'unshielded',
    }),
    amount: Flags.string({
      description:
        'Raw amount in the token\'s smallest unit (STARS for NIGHT). Mutually exclusive with --night.',
    }),
    night: Flags.string({
      description:
        'Convenience: amount expressed as NIGHT (will be multiplied by 10^6 STARS). Rejected if --token-id is not NIGHT. Mutually exclusive with --amount.',
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 600000)',
      default: 600_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonTransfer);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const tokenId = flags['token-id'].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tokenId)) {
      this.outputError('INVALID_INPUT', '--token-id must be a 64-char hex string');
      this.exit(2);
      return;
    }

    // Resolve amount. Exactly one of --amount or --night must be set.
    let rawAmount: bigint;
    if (flags.amount && flags.night) {
      this.outputError('INVALID_INPUT', '--amount and --night are mutually exclusive');
      this.exit(2);
      return;
    }
    if (flags.amount) {
      if (!/^\d+$/.test(flags.amount)) {
        this.outputError('INVALID_INPUT', '--amount must be a non-negative decimal');
        this.exit(2);
        return;
      }
      rawAmount = BigInt(flags.amount);
    } else if (flags.night) {
      if (tokenId !== NIGHT_TOKEN_ID) {
        this.outputError(
          'INVALID_INPUT',
          '--night is only valid when --token-id is NIGHT. For other tokens use --amount with the raw smallest-unit value.',
        );
        this.exit(2);
        return;
      }
      // Parse as decimal NIGHT, multiply by 10^6 STARS. We support up to
      // 6 decimal places (one STAR). More than that is silently truncated
      // — but we reject anything that doesn't even look like a decimal.
      const m = flags.night.match(/^(\d+)(?:\.(\d{1,6}))?$/);
      if (!m) {
        this.outputError(
          'INVALID_INPUT',
          '--night must be a decimal with at most 6 fractional digits',
        );
        this.exit(2);
        return;
      }
      const whole = BigInt(m[1]!);
      const frac = m[2] ? BigInt(m[2].padEnd(6, '0')) : 0n;
      rawAmount = whole * STARS_PER_NIGHT + frac;
    } else {
      this.outputError('INVALID_INPUT', 'one of --amount or --night is required');
      this.exit(2);
      return;
    }

    if (rawAmount <= 0n) {
      this.outputError('INVALID_INPUT', 'amount must be greater than zero');
      this.exit(2);
      return;
    }

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      // Pre-flight: short-circuit if the daemon's facade isn't ready.
      const state = await client.call<{ready: boolean}>('getState');
      if (!state.ready) {
        this.outputError(
          'WALLET_ERROR',
          `TUI is running but the wallet facade for "${walletName}" is still initializing on ${network.id}. Wait for the TUI to finish unlocking / starting sync and retry.`,
        );
        this.exit(1);
        return;
      }

      this.log_verbose(
        `Sending transferTokens (${flags.type}, ${rawAmount.toString()} raw of token ${tokenId.slice(0, 8)}…) via daemon ${client.daemonVersion}`,
      );

      const result = await client.call<TransferResult>(
        'transferTokens',
        {
          type: flags.type,
          tokenId,
          amount: rawAmount.toString(),
          to: flags.to,
        },
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

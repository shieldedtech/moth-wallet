// Deploy a compiled Compact contract through the running TUI daemon.
// The CLI sends the artifact path (a TUI-host-local filesystem path);
// the TUI loads the artifact, optionally imports a witness module,
// derives keys from its in-memory walletKeys, builds + balances +
// proves (via the proof server) + signs + submits the deploy
// transaction. Spending keys never leave the TUI; the CLI sees only
// the resulting on-chain TransactionResult including the new
// contract's bech32m address.

import {Args, Flags} from '@oclif/core';
import {resolve} from 'node:path';
import {BaseCommand, daemonClientFlags} from '../../base-command.js';

interface DeployResult {
  txHash: string;
  status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE';
  blockHash: string | null;
  blockHeight: number | null;
  contractAddress: string | null;
  fees: {paid: string; estimated: string} | null;
}

export default class DaemonDeploy extends BaseCommand {
  static override description =
    'Deploy a compiled Compact contract through the running TUI daemon. The TUI does the whole pipeline (load artifact, balance, prove via the proof server, sign, submit); spending keys never leave the TUI. Triggers an L3 confirmation modal showing the artifact, circuit list, and witness path.';

  static override args = {
    artifact: Args.string({
      description: 'Path to compiled contract artifact directory (managed/<contract>) on the TUI host',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    artifact: Flags.string({
      description: 'Path to compiled contract artifact (alternative to positional arg)',
    }),
    witnesses: Flags.string({
      description: 'Path to witness provider JS file on the TUI host',
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    args: Flags.string({
      description: 'Constructor arguments as JSON or @file.json (same convention as `deploy --args`; @file resolved on the TUI host)',
    }),
    'private-state': Flags.string({
      description: 'Initial private state as JSON or @file.json (same convention as `deploy --private-state`; @file resolved on the TUI host)',
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 600000 — deploys can take ~minutes to prove)',
      default: 600_000,
    }),
  };

  async run(): Promise<void> {
    const {args, flags} = await this.parse(DaemonDeploy);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const artifactRaw = flags.artifact ?? args.artifact;
    if (!artifactRaw) {
      this.outputError('INVALID_INPUT', 'artifact path required (positional or --artifact)');
      this.exit(2);
      return;
    }

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const artifactPath = resolve(artifactRaw);
    const witnessesPath = flags.witnesses ? resolve(flags.witnesses) : undefined;
    const projectDir = flags['project-dir'] ? resolve(flags['project-dir']) : undefined;

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const state = await client.call<{ready: boolean}>('getState');
      if (!state.ready) {
        this.outputError(
          'WALLET_ERROR',
          `TUI is running but the wallet facade for "${walletName}" is still initializing on ${network.id}. Wait for sync and retry.`,
        );
        this.exit(1);
        return;
      }

      this.log_verbose(`Deploying ${artifactPath} via daemon ${client.daemonVersion}`);

      const result = await client.call<DeployResult>(
        'deployContract',
        {
          artifactPath,
          witnessesPath,
          projectDir,
          args: flags.args,
          privateState: flags['private-state'],
        },
        {timeoutMs: flags['timeout-ms']},
      );

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Deployed. Transaction hash: ${result.txHash}`);
        if (result.contractAddress) this.log(`Contract address: ${result.contractAddress}`);
        this.log(`Status: ${result.status}`);
        if (result.blockHash) this.log(`Block hash: ${result.blockHash}`);
        if (result.blockHeight !== null) this.log(`Block height: ${result.blockHeight}`);
        if (result.fees) {
          this.log(`Fees: paid ${result.fees.paid}, estimated ${result.fees.estimated}`);
        }
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

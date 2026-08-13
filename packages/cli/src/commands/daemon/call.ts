// Call a contract circuit through the running TUI daemon. The CLI sends
// intent (contract address, circuit, args, artifact path); the TUI
// loads the artifact and witnesses, derives keys from its in-memory
// seed, builds + balances + proves + signs + submits the call.
// Spending keys never leave the TUI.
//
// Path-based fields (--artifact, --witnesses, --project-dir) refer to
// files on the TUI host's filesystem. In single-host mode (local
// daemon + local CLI) this is fine and matches the existing `moth
// call` UX. A future remote-host mode would have to ship artifact
// bytes over the wire.

import {Args, Flags} from '@oclif/core';
import {resolve} from 'node:path';
import {BaseCommand, daemonClientFlags} from '../../base-command.js';

interface CallResult {
  txHash: string;
  status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE';
  blockHash: string | null;
  blockHeight: number | null;
  contractAddress: string | null;
  fees: {paid: string; estimated: string} | null;
}

export default class DaemonCall extends BaseCommand {
  static override description =
    'Call a contract circuit through the running TUI daemon. The TUI does the whole pipeline (build, balance, prove via the proof server, sign, submit); spending keys never leave the TUI. Triggers an L3 confirmation modal showing the contract, circuit, and args.';

  static override args = {
    circuit: Args.string({
      description: 'Circuit name to call',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    address: Flags.string({
      description: 'Deployed contract address (bech32m)',
      required: true,
    }),
    artifact: Flags.string({
      description: 'Path to compiled contract artifact (managed/ directory) on the TUI host',
      required: true,
    }),
    witnesses: Flags.string({
      description: 'Path to witness provider JS file on the TUI host',
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    args: Flags.string({
      description: 'Circuit arguments as JSON or @file.json',
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 600000)',
      default: 600_000,
    }),
  };

  async run(): Promise<void> {
    const {args, flags} = await this.parse(DaemonCall);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const circuit = await this.promptIfMissing(args.circuit, 'Circuit name');

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Resolve filesystem paths now so we hand the daemon something
    // unambiguous. The daemon will re-resolve against its own CWD —
    // since CLI and TUI both run on the same host in this mode, the
    // results match.
    const artifactPath = resolve(flags.artifact);
    const witnessesPath = flags.witnesses ? resolve(flags.witnesses) : undefined;
    const projectDir = flags['project-dir'] ? resolve(flags['project-dir']) : undefined;

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const state = await client.call<{ready: boolean}>('getState');
      if (!state.ready) {
        this.outputError(
          'WALLET_ERROR',
          `TUI is running but the wallet facade for "${walletName}" is still initializing on ${network.id}. Wait for the TUI to finish unlocking / starting sync and retry.`,
        );
        this.exit(1);
        return;
      }

      this.log_verbose(`Calling circuit "${circuit}" on ${flags.address} via daemon ${client.daemonVersion}`);

      const result = await client.call<CallResult>(
        'callCircuit',
        {
          contractAddress: flags.address,
          circuitName: circuit,
          args: flags.args,
          artifactPath,
          witnessesPath,
          projectDir,
        },
        {timeoutMs: flags['timeout-ms']},
      );

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Circuit call submitted. Transaction hash: ${result.txHash}`);
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

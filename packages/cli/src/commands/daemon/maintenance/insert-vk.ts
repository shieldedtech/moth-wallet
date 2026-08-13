// Insert a single verifier key on a deployed contract via the running
// TUI daemon. The TUI's facade does the build + sign + submit; the CLI
// only sends paths + the circuit id. Spending keys never leave the
// TUI. Triggers an L3 confirmation modal showing the contract,
// circuit, artifact, and VK file path.

import {Flags} from '@oclif/core';
import {resolve} from 'node:path';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

interface InsertResult {
  txHash: string;
  status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE';
  blockHash: string | null;
  blockHeight: number | null;
  contractAddress: string | null;
  fees: {paid: string; estimated: string} | null;
}

export default class DaemonMaintenanceInsertVk extends BaseCommand {
  static override description =
    'Insert a verifier key on a deployed contract through the running TUI daemon. The TUI signs and submits the maintenance update; spending keys never leave the TUI.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    address: Flags.string({
      description: 'Deployed contract address (bech32m)',
      required: true,
    }),
    'circuit-id': Flags.string({
      description: 'Name of the circuit whose verifier key is being inserted',
      required: true,
    }),
    'vk-file': Flags.string({
      description: 'Path to the .verifier file (raw bytes from compact compile)',
      required: true,
    }),
    artifact: Flags.string({
      description: 'Path to the FULL compiled contract artifact (the one declaring this circuit)',
      required: true,
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 600000)',
      default: 600_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonMaintenanceInsertVk);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const artifactPath = resolve(flags.artifact);
    const verifierKeyPath = resolve(flags['vk-file']);
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

      const result = await client.call<InsertResult>(
        'insertVerifierKey',
        {
          contractAddress: flags.address,
          circuitId: flags['circuit-id'],
          verifierKeyPath,
          artifactPath,
          projectDir,
        },
        {timeoutMs: flags['timeout-ms']},
      );

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Inserted verifier key for ${flags['circuit-id']}.`);
        this.log(`Transaction hash: ${result.txHash}`);
        this.log(`Status: ${result.status}`);
        if (result.blockHeight !== null) this.log(`Block height: ${result.blockHeight}`);
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

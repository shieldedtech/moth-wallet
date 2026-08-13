// Batch verifier-key insert through the running TUI daemon. Same
// shape as the in-process `moth maintenance insert-vks-batch` but
// routed through the daemon's RPC. CLI enumerates the .verifier
// files (so the user can preview the circuit list on the CLI side
// before approving) and sends an explicit entries array to the
// daemon — the TUI doesn't have to re-scan the directory.

import {Flags} from '@oclif/core';
import {resolve, join} from 'node:path';
import {readdirSync, existsSync} from 'node:fs';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

interface BatchEntryResult {
  circuitId: string;
  status: 'inserted' | 'skipped-existing' | 'failed';
  txHash?: string;
  blockHeight?: number | null;
  error?: string;
}

interface BatchResult {
  contractAddress: string;
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
  entries: BatchEntryResult[];
}

export default class DaemonMaintenanceInsertVksBatch extends BaseCommand {
  static override description =
    'Insert multiple verifier keys on a deployed contract through the running TUI daemon (Level 1 batching — one tx per VK, shared wallet sync). Use for staged deployment of contracts whose verifier-key payload would exceed the per-tx block weight cap.';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    address: Flags.string({required: true, description: 'Deployed contract address (bech32m)'}),
    artifact: Flags.string({
      required: true,
      description: 'Path to the FULL compiled artifact directory (contains keys/*.verifier)',
    }),
    circuits: Flags.string({
      description: 'Comma-separated circuit names. Default: every .verifier in <artifact>/keys.',
    }),
    'skip-existing': Flags.boolean({
      default: false,
      description: 'Query the chain first and skip circuits already defined.',
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 1800000 — 30 minutes for large batches)',
      default: 1_800_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonMaintenanceInsertVksBatch);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const artifactPath = resolve(flags.artifact);
    const keysDir = join(artifactPath, 'keys');
    if (!existsSync(keysDir)) {
      this.outputError('INVALID_INPUT', `No keys/ directory in artifact: ${keysDir}`);
      this.exit(2);
      return;
    }
    const allKeyFiles = readdirSync(keysDir).filter((f) => f.endsWith('.verifier'));
    const allCircuitNames = allKeyFiles.map((f) => f.replace(/\.verifier$/, ''));

    let circuitsToInsert: string[];
    if (flags.circuits && flags.circuits.trim()) {
      circuitsToInsert = flags.circuits.split(',').map((s) => s.trim()).filter(Boolean);
      const missing = circuitsToInsert.filter((c) => !allCircuitNames.includes(c));
      if (missing.length > 0) {
        this.outputError('INVALID_INPUT', `Requested circuits not found in artifact keys/: ${missing.join(', ')}`);
        this.exit(2);
        return;
      }
    } else {
      circuitsToInsert = allCircuitNames;
    }
    if (circuitsToInsert.length === 0) {
      this.outputError('INVALID_INPUT', 'No circuits to insert.');
      this.exit(2);
      return;
    }

    const entries = circuitsToInsert.map((circuitId) => ({
      circuitId,
      verifierKeyPath: join(keysDir, `${circuitId}.verifier`),
    }));

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

      const result = await client.call<BatchResult>(
        'insertVerifierKeysBatch',
        {
          contractAddress: flags.address,
          entries,
          artifactPath,
          projectDir: flags['project-dir'] ? resolve(flags['project-dir']) : undefined,
          skipExisting: flags['skip-existing'],
        },
        {timeoutMs: flags['timeout-ms']},
      );

      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Total: ${result.total}  inserted: ${result.inserted}  skipped: ${result.skipped}  failed: ${result.failed}`);
        for (const e of result.entries) {
          let line = `  ${e.status.padEnd(16)} ${e.circuitId}`;
          if (e.txHash) line += `  tx=${e.txHash}`;
          if (e.error) line += `  error=${e.error}`;
          this.log(line);
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

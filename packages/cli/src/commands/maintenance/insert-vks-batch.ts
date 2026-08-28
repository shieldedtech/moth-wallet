import { Flags } from '@oclif/core';
import { resolve, join, basename } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { BaseCommand } from '../../base-command.js';
import {
  describeProver,
  insertVerifierKeys,
  loadContractArtifact,
  resolveProverConfig,
  startWalletSync,
} from '@shieldedtech/moth-wallet';
import { getPassphrase } from '../../adapters/passphrase.js';

export default class MaintenanceInsertVksBatch extends BaseCommand {
  static override description =
    'Insert multiple verifier keys for a deployed contract in one command (Level 1 batching — '
    + 'one tx per VK, shared wallet sync). Use for staged deployment of contracts whose '
    + 'verifier-key payload would exceed the per-tx block weight cap.';

  static override flags = {
    ...BaseCommand.baseFlags,
    address: Flags.string({ required: false, description: 'Deployed contract address' }),
    artifact: Flags.string({
      required: false,
      description: 'Path to the FULL compiled artifact directory (contains keys/*.verifier)',
    }),
    circuits: Flags.string({
      required: false,
      description: 'Comma-separated circuit names to insert. Default: every .verifier in <artifact>/keys.',
    }),
    'skip-existing': Flags.boolean({
      default: false,
      description: 'Query the chain first and skip circuits already on-chain.',
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dep resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MaintenanceInsertVksBatch);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const address = await this.promptIfMissing(flags.address, 'Contract address');
    const artifactPath = await this.promptIfMissing(flags.artifact, 'Full compiled artifact directory');
    const artifact = await loadContractArtifact(resolve(artifactPath));
    this.log_verbose(`Loaded artifact: ${artifact.path}`);

    // Resolve circuit list
    const keysDir = join(artifact.path, 'keys');
    if (!existsSync(keysDir)) {
      this.error(`No keys/ directory in artifact: ${keysDir}`);
    }
    const allKeyFiles = readdirSync(keysDir).filter(f => f.endsWith('.verifier'));
    const allCircuitNames = allKeyFiles.map(f => f.replace(/\.verifier$/, ''));

    let circuitsToInsert: string[];
    if (flags.circuits && flags.circuits.trim()) {
      circuitsToInsert = flags.circuits.split(',').map(s => s.trim()).filter(Boolean);
      const missing = circuitsToInsert.filter(c => !allCircuitNames.includes(c));
      if (missing.length > 0) {
        this.error(`Requested circuits not found in artifact keys/: ${missing.join(', ')}`);
      }
    } else {
      circuitsToInsert = allCircuitNames;
    }

    if (circuitsToInsert.length === 0) {
      this.error('No circuits to insert.');
    }

    const entries = circuitsToInsert.map(circuitId => ({
      circuitId,
      verifierKeyPath: join(keysDir, `${circuitId}.verifier`),
    }));

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    await this.confirmTransaction({
      'Operation': `Insert ${entries.length} verifier key(s)`,
      'Contract': address,
      'Artifact': artifact.path,
      'Circuits': entries.map(e => e.circuitId).join(', '),
      'Skip already-defined': flags['skip-existing'] ? 'yes' : 'no',
      'Network': network.id,
      'Wallet': walletName,
      'Prover': describeProver(resolveProverConfig(network)),
    }, flags);

    process.stderr.write('Syncing wallet before batch maintenance update...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg: string) => {
      this.log_verbose(msg);
      if (msg.includes('syncing') || msg.includes('synced')) {
        process.stderr.write(`\r  ${msg}${''.padEnd(20)}`);
      }
    }, walletName, false, await this.syncBirthday(walletName, network.id));
    process.stderr.write('\n');

    try {
      const result = await insertVerifierKeys({
        contractAddress: address,
        entries,
        keys: wallet.keys,
        walletKeys: wallet.walletKeys,
        network,
        syncedWallet,
        artifactPath: artifact.path,
        skipExisting: flags['skip-existing'],
        projectDir: flags['project-dir'] ? resolve(flags['project-dir']) : undefined,
        timeoutMs: flags.timeout ? flags.timeout * 1000 : 120_000,
        onProgress: (e) => {
          if (e.status === 'inserted') {
            process.stderr.write(`  ✓ ${e.circuitId} — tx ${e.txHash?.slice(0, 12) ?? ''} @ block ${e.blockHeight}\n`);
          } else if (e.status === 'skipped-existing') {
            process.stderr.write(`  · ${e.circuitId} — already on chain, skipped\n`);
          } else {
            process.stderr.write(`  ✗ ${e.circuitId} — ${e.error}\n`);
          }
        },
      });

      this.outputSuccess({
        contractAddress: result.contractAddress,
        total: result.total,
        inserted: result.inserted,
        skipped: result.skipped,
        failed: result.failed,
        entries: result.entries,
      });

      if (result.failed > 0) {
        process.stderr.write(
          `\n${result.failed} circuit(s) failed. Re-run with --skip-existing to retry only the missing ones.\n`,
        );
        process.exit(2);
      }
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

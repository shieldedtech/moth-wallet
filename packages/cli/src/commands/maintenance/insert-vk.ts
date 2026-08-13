import { Flags } from '@oclif/core';
import { resolve } from 'node:path';
import { BaseCommand } from '../../base-command.js';
import {
  describeProver,
  insertVerifierKey,
  loadContractArtifact,
  resolveProverConfig,
  startWalletSync,
} from '@shieldedtech/moth-wallet';
import { getPassphrase } from '../../adapters/passphrase.js';

export default class MaintenanceInsertVk extends BaseCommand {
  static override description = 'Insert a verifier key for a circuit on a deployed contract (maintenance update)';

  static override flags = {
    ...BaseCommand.baseFlags,
    address: Flags.string({
      required: false,
      description: 'Deployed contract address',
    }),
    'circuit-id': Flags.string({
      required: false,
      description: 'Name of the circuit whose verifier key is being inserted',
    }),
    'vk-file': Flags.string({
      required: false,
      description: 'Path to the .verifier file (raw bytes from compact compile)',
    }),
    artifact: Flags.string({
      required: false,
      description: 'Path to the FULL compiled contract artifact directory (the one declaring this circuit)',
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MaintenanceInsertVk);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const address = await this.promptIfMissing(flags.address, 'Contract address');
    const circuitId = await this.promptIfMissing(flags['circuit-id'], 'Circuit ID');
    const vkPath = await this.promptIfMissing(flags['vk-file'], 'Verifier key file (.verifier)');
    const artifactPath = await this.promptIfMissing(flags.artifact, 'Full compiled contract artifact directory');

    const artifact = await loadContractArtifact(resolve(artifactPath));
    this.log_verbose(`Loaded artifact: ${artifact.path}`);

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    await this.confirmTransaction({
      'Operation': `Insert verifier key for circuit "${circuitId}"`,
      'Contract': address,
      'Verifier key file': resolve(vkPath),
      'Artifact': artifact.path,
      'Network': network.id,
      'Wallet': walletName,
      'Prover': describeProver(resolveProverConfig(network)),
    }, flags);

    process.stderr.write('Syncing wallet before maintenance update...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg: string) => {
      this.log_verbose(msg);
      if (msg.includes('syncing') || msg.includes('synced')) {
        process.stderr.write(`\r  ${msg}${''.padEnd(20)}`);
      }
    }, walletName);
    process.stderr.write('\n');

    try {
      process.stderr.write(`Inserting verifier key for "${circuitId}"...\n`);
      const result = await insertVerifierKey({
        contractAddress: address,
        circuitId,
        verifierKeyPath: resolve(vkPath),
        keys: wallet.keys,
        walletKeys: wallet.walletKeys,
        network,
        syncedWallet,
        artifactPath: artifact.path,
        projectDir: flags['project-dir'] ? resolve(flags['project-dir']) : undefined,
        timeoutMs: flags.timeout ? flags.timeout * 1000 : 120_000,
      });

      this.outputSuccess({
        txHash: result.hash,
        status: result.status,
        blockHash: result.blockHash,
        blockHeight: result.blockHeight,
        circuitId,
        contractAddress: result.contractAddress,
      });
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

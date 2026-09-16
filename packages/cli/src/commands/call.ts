import { Args, Flags } from '@oclif/core';
import { resolve } from 'node:path';
import { BaseCommand } from '../base-command.js';
import {
  callCircuit,
  describeProver,
  loadContractArtifact,
  parseArgs,
  resolveProverConfig,
  startWalletSync,
} from '@shieldedtech/moth-wallet';
import { getPassphrase } from '../adapters/passphrase.js';

export default class Call extends BaseCommand {
  static override description = 'Call a circuit on a deployed contract';

  static override args = {
    circuit: Args.string({
      description: 'Circuit name to call',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    address: Flags.string({
      required: false,
      description: 'Deployed contract address',
    }),
    artifact: Flags.string({
      required: false,
      description: 'Path to compiled contract artifact (managed/ directory)',
    }),
    witnesses: Flags.string({
      description: 'Path to witness provider JS file',
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    args: Flags.string({
      description:
        'Circuit arguments as JSON or @file.json. A JSON array supplies positional arguments ' +
        'in circuit order; a single non-array value is treated as one argument. Bytes<N> values ' +
        'are hex strings like "0x0011..." (decoded to Uint8Array); Uint<..>/Field values MUST be ' +
        'bigint-literal strings like "5000000n" (a bare JSON number fails at proving time).',
    }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Call);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const circuit = await this.promptIfMissing(args.circuit, 'Circuit name');
    const address = await this.promptIfMissing(flags.address, 'Contract address');
    const artifactPath = await this.promptIfMissing(flags.artifact, 'Path to compiled contract artifact');
    const circuitArgs = flags.args ? await parseArgs(flags.args) : {};

    // Validate artifact
    const artifact = await loadContractArtifact(resolve(artifactPath));
    this.log_verbose(`Loaded artifact: ${artifact.path} (circuits: ${artifact.circuits.join(', ')})`);

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // SR-003: Confirm before transaction
    await this.confirmTransaction({
      'Operation': `Call circuit "${circuit}"`,
      'Contract': address,
      'Artifact': artifact.path,
      'Network': network.id,
      'Wallet': walletName,
      'Prover': describeProver(resolveProverConfig(network)),
      'Arguments': flags.args ?? '(none)',
    }, flags);

    // Sync wallet before call — needed for transaction balancing (DUST fees + signing)
    process.stderr.write('Syncing wallet before call...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg: string) => {
      this.log_verbose(msg);
      if (msg.includes('syncing') || msg.includes('synced')) {
        process.stderr.write(`\r  ${msg}${''.padEnd(20)}`);
      }
    }, walletName, false, await this.syncBirthday(walletName, network.id));
    process.stderr.write('\n');

    try {
      process.stderr.write('Calling circuit...\n');
      const result = await callCircuit({
        contractAddress: address,
        circuitName: circuit,
        args: circuitArgs,
        keys: wallet.keys,
        walletKeys: wallet.walletKeys,
        witnesses: flags.witnesses ? (await import(resolve(flags.witnesses))).default : undefined,
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
        fees: result.fees,
      });
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

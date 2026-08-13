import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import {
  loadContractArtifact,
  deployContract,
  describeProver,
  resolveProverConfig,
  startWalletSync,
  parseArgs,
  toPositionalArgs,
  resolveInitialPrivateState,
} from '@shieldedtech/moth-wallet';
import { getPassphrase } from '../adapters/passphrase.js';
import { resolve } from 'node:path';

export default class Deploy extends BaseCommand {
  static override description = [
    'Deploy a compiled Compact contract.',
    '',
    'Constructor arguments (for parameterized constructors) are supplied via --args, using',
    'the same JSON convention as `moth call --args`: inline JSON or "@file.json", with',
    'Bytes<N> values encoded as hex strings matching /^0x[0-9a-fA-F]+$/ (e.g. "0x0011..."),',
    'which are decoded to Uint8Array. Uint<..>/Field values MUST be encoded as bigint-literal',
    'strings matching /^-?\\d+n$/ (e.g. "5000000n") — a bare JSON number like 5000000 is passed',
    'through as a JS number and will fail at proving time, since the contract expects bigint.',
    'A JSON array supplies positional constructor arguments in the order defined by the',
    'contract; a single non-array value is treated as one argument.',
    '',
    'Initial private state (for contracts with non-trivial private state) can be supplied',
    'three ways, in this precedence order: (1) --private-state, parsed with the same JSON',
    'convention as --args; (2) the --witnesses module exporting a zero-arg',
    '`makeInitialPrivateState()` factory function, called to produce the value; (3) the',
    '--witnesses module exporting a plain `initialPrivateState` value, used as-is. If none',
    'apply, the initial private state defaults to `{}`.',
  ].join('\n');

  static override args = {
    artifact: Args.string({
      description: 'Path to compiled contract artifact directory',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    witnesses: Flags.string({
      description:
        'Path to witness provider JS file. May also export a zero-arg makeInitialPrivateState() ' +
        'factory or a plain initialPrivateState value, used when --private-state is not given.',
    }),
    'project-dir': Flags.string({
      description: 'Contract project directory (for resolving SDK dependencies)',
      env: 'MOTH_PROJECT_DIR',
    }),
    name: Flags.string({
      description: 'Label for the deployed contract',
    }),
    args: Flags.string({
      description:
        'Constructor arguments as JSON or @file.json (same convention as `call --args`). ' +
        'A JSON array supplies positional arguments in constructor order; Bytes<N> values are ' +
        'hex strings like "0x0011...".',
    }),
    'private-state': Flags.string({
      description:
        'Initial private state as JSON or @file.json. Overrides any initial private state ' +
        'exported by --witnesses. Defaults to {} if neither is given.',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Deploy);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const artifactInput = await this.promptIfMissing(
      args.artifact,
      'Path to compiled contract artifact',
    );
    const artifactPath = resolve(artifactInput);
    this.log_verbose(`Loading artifact from ${artifactPath}`);

    const artifact = await loadContractArtifact(artifactPath);
    this.log_verbose(`Found circuits: ${artifact.circuits.join(', ')}`);

    const constructorArgs = toPositionalArgs(flags.args ? await parseArgs(flags.args) : undefined);
    this.log_verbose(`Constructor arguments: ${constructorArgs.length}`);

    const witnessPath = flags.witnesses ? resolve(flags.witnesses) : undefined;
    const initialPrivateState = await resolveInitialPrivateState(flags['private-state'], witnessPath, {
      onVerbose: (msg) => this.log_verbose(msg),
    });

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Project directory for resolving SDK dependencies (handled by core via createRequire)
    const projectDir = flags['project-dir']
      ? resolve(flags['project-dir'])
      : resolve(artifactPath, '..', '..');  // Default: assume managed/ is 2 levels inside project
    this.log_verbose(`Project dir: ${projectDir}`);

    this.log_verbose(`Deploying to ${network.id} via ${describeProver(resolveProverConfig(network))}`);

    // SR-003: Confirm transaction before proceeding
    await this.confirmTransaction({
      'Operation': 'Deploy contract',
      'Artifact': artifactPath,
      'Network': network.id,
      'Wallet': walletName,
      'Prover': describeProver(resolveProverConfig(network)),
      'Constructor args': flags.args ?? '(none)',
    }, flags);

    // Deploy requires a synced wallet for transaction balancing
    process.stderr.write('Syncing wallet before deploy...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg) => {
      this.log_verbose(msg);
      // Show sync progress inline (overwrite same line)
      if (msg.includes('syncing') || msg.includes('synced')) {
        process.stderr.write(`\r  ${msg}${''.padEnd(20)}`);
      }
    }, walletName);
    process.stderr.write('\n');

    try {
      process.stderr.write('Deploying contract...\n');
      const result = await deployContract({
        artifact,
        walletKeys: wallet.walletKeys,
        network,
        syncedWallet,
        witnessPath,
        projectDir: projectDir,
        timeoutMs: flags.timeout ? flags.timeout * 1000 : 120_000,
        args: constructorArgs,
        initialPrivateState,
        onProgress: (stage) => {
          process.stderr.write(`Deploy: ${stage}\n`);
        },
      });

      this.outputSuccess({
        contractAddress: result.contractAddress,
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

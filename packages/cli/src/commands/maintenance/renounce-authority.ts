import { Flags } from '@oclif/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCommand } from '../../base-command.js';
import {
  type AuthoritySigner,
  describeProver,
  loadContractArtifact,
  readAuthority,
  replaceAuthority,
  resolveProverConfig,
  startWalletSync,
} from '@shieldedtech/moth-wallet';
import { getPassphrase } from '../../adapters/passphrase.js';

export default class MaintenanceRenounceAuthority extends BaseCommand {
  static override description =
    'Renounce a contract\'s maintenance authority, freezing its circuits permanently (irreversible)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --address 0abc... --artifact ./managed/MyContract -n preprod',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    address: Flags.string({required: false, description: 'Deployed contract address'}),
    signer: Flags.string({
      required: false,
      multiple: true,
      description: 'A signing key of the CURRENT authority as index:key or @file.json. ' +
        'Repeat to reach the current threshold. Omit to use the locally stored deploy-time key.',
    }),
    artifact: Flags.string({required: false, description: 'Path to the compiled contract artifact directory'}),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation prompt', default: false}),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(MaintenanceRenounceAuthority);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const address = await this.promptIfMissing(flags.address, 'Contract address');
    const artifactPath = await this.promptIfMissing(flags.artifact, 'Compiled contract artifact directory');

    const artifact = await loadContractArtifact(resolve(artifactPath));
    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Read the current authority first, so the confirmation says what is being
    // given up rather than asking about an abstraction.
    const current = await readAuthority(address, network);

    const signers: AuthoritySigner[] = (flags.signer ?? []).map(raw => {
      if (raw.startsWith('@')) {
        const parsed = JSON.parse(readFileSync(resolve(raw.slice(1)), 'utf8'));
        return {index: Number(parsed.index ?? parsed.member), signingKey: String(parsed.signingKey)};
      }
      const [idx, ...rest] = raw.split(':');
      return {index: Number(idx), signingKey: rest.join(':')};
    });

    await this.confirmTransaction({
      'Operation': 'RENOUNCE the maintenance authority -- IRREVERSIBLE',
      'Contract': address,
      'Giving up': `a ${current.threshold}-of-${current.committee.length} authority`,
      'Effect': 'No verifier key can ever be inserted, replaced, or removed again. ' +
        'No bug in any circuit can ever be fixed.',
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
      // Pre-seeding needs the birthday: without it this surface always syncs from
      // genesis, which the preseed-call-sites guard test enforces across the CLI.
    }, walletName, false, await this.syncBirthday(walletName, network.id));
    process.stderr.write('\n');

    try {
      const result = await replaceAuthority({
        contractAddress: address,
        committee: [],
        threshold: 1,
        renounce: true,
        currentSigners: signers.length > 0 ? signers : undefined,
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
        blockHeight: result.blockHeight,
        contractAddress: result.contractAddress,
        renounced: result.next.renounced,
        counter: result.next.counter.toString(),
        note: 'The circuit set is now permanently immutable. Verify with `moth maintenance show-authority`.',
      });
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

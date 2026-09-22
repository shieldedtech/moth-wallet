import { Flags } from '@oclif/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCommand } from '../../base-command.js';
import {
  type AuthoritySigner,
  describeProver,
  loadContractArtifact,
  replaceAuthority,
  resolveProverConfig,
  startWalletSync,
} from '@shieldedtech/moth-wallet';
import { getPassphrase } from '../../adapters/passphrase.js';

/** Accepts `{threshold, committee: [...]}`, or a bare array of verifying keys. */
const parseCommittee = (raw: string): {committee: string[]; threshold?: number} => {
  const text = raw.startsWith('@') ? readFileSync(resolve(raw.slice(1)), 'utf8') : raw;
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return {committee: parsed.map(String)};
  // A project's published parameters may nest it, as almost-surely's
  // public-params.json does under "maintenance".
  const node = parsed.maintenance ?? parsed;
  if (!Array.isArray(node.committee)) {
    throw new Error('committee JSON must be an array of verifying keys, or an object with a "committee" array');
  }
  return {
    committee: node.committee.map(String),
    threshold: node.threshold === undefined ? undefined : Number(node.threshold),
  };
};

/** Accepts `{index|member, signingKey}` -- the shape one custodian's file has. */
const parseSigner = (raw: string): AuthoritySigner => {
  const text = raw.startsWith('@') ? readFileSync(resolve(raw.slice(1)), 'utf8') : raw;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Bare `index:signingKey`, for the case where a custodian pastes one line.
    const [idx, ...rest] = raw.split(':');
    if (rest.length === 0) throw new Error(`could not read a signer from "${raw}"`);
    return {index: Number(idx), signingKey: rest.join(':')};
  }
  const index = parsed.index ?? parsed.member;
  if (index === undefined || typeof parsed.signingKey !== 'string') {
    throw new Error('signer JSON needs a signing key and its index in the current committee');
  }
  return {index: Number(index), signingKey: parsed.signingKey};
};

export default class MaintenanceReplaceAuthority extends BaseCommand {
  static override description =
    'Replace a deployed contract\'s maintenance authority with a committee (maintenance update)';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --address 0abc... --committee @public-params.json --artifact ./managed/MyContract -n preprod',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    address: Flags.string({required: false, description: 'Deployed contract address'}),
    committee: Flags.string({
      required: false,
      description: 'Incoming committee: inline JSON or @file.json. An array of verifying keys, ' +
        'or an object with "committee" and "threshold".',
    }),
    threshold: Flags.integer({
      required: false,
      description: 'Signatures required by the incoming committee (default: from the committee file)',
    }),
    signer: Flags.string({
      required: false,
      multiple: true,
      description: 'A signing key of the CURRENT authority: inline JSON, @file.json, or index:key. ' +
        'Repeat to reach the current threshold. Omit for a contract still under the key this ' +
        'wallet stored at deploy time.',
    }),
    artifact: Flags.string({
      required: false,
      description: 'Path to the compiled contract artifact directory',
    }),
    'project-dir': Flags.string({
      description: 'Project directory for SDK dependency resolution',
      env: 'MOTH_PROJECT_DIR',
    }),
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation prompt', default: false}),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(MaintenanceReplaceAuthority);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const address = await this.promptIfMissing(flags.address, 'Contract address');
    const committeeRaw = await this.promptIfMissing(flags.committee, 'Incoming committee (JSON or @file.json)');
    const artifactPath = await this.promptIfMissing(flags.artifact, 'Compiled contract artifact directory');

    const {committee, threshold: fileThreshold} = parseCommittee(committeeRaw);
    const threshold = flags.threshold ?? fileThreshold;
    if (threshold === undefined) {
      throw new Error('No threshold given and none in the committee file. Pass --threshold.');
    }
    const signers = (flags.signer ?? []).map(parseSigner);

    const artifact = await loadContractArtifact(resolve(artifactPath));
    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    await this.confirmTransaction({
      'Operation': `Replace maintenance authority with a ${threshold}-of-${committee.length} committee`,
      'Contract': address,
      'Signing as': signers.length > 0
        ? `${signers.length} given signer(s): index ${signers.map(s => s.index).join(', ')}`
        : 'the locally stored deploy-time key',
      'Effect': threshold > 1
        ? 'No single party can rewrite this contract afterwards'
        : 'WARNING: threshold 1 leaves a unilateral superuser',
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
        committee,
        threshold,
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
        previous: {
          threshold: result.previous.threshold,
          committeeSize: result.previous.committee.length,
          counter: result.previous.counter.toString(),
        },
        next: {
          threshold: result.next.threshold,
          committeeSize: result.next.committee.length,
          counter: result.next.counter.toString(),
        },
        localSigningKey: result.localKeyRetained
          ? 'retained'
          : 'dropped: this wallet can no longer maintain the contract alone',
        note: 'Insert every verifier key BEFORE handing the contract to a committee -- ' +
          'insert-vk signs with one local key and a committee-held contract will refuse it.',
      });
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}

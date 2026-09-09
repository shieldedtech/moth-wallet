import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { readAuthority } from '@shieldedtech/moth-wallet';

export default class MaintenanceShowAuthority extends BaseCommand {
  static override description =
    'Show the maintenance authority of a deployed contract -- who can rewrite its circuits';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --address 0abc... -n preprod',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    address: Flags.string({required: false, description: 'Deployed contract address'}),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(MaintenanceShowAuthority);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const address = await this.promptIfMissing(flags.address, 'Contract address');
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // No wallet, no keys: this is the check a consumer runs before trusting an
    // instance, and it must not require holding anything.
    const authority = await readAuthority(address, network);

    this.outputSuccess({
      contractAddress: address,
      network: network.id,
      threshold: authority.threshold,
      committeeSize: authority.committee.length,
      committee: authority.committee,
      counter: authority.counter.toString(),
      renounced: authority.renounced,
      note: authority.renounced
        ? 'Threshold exceeds committee size: no maintenance update can ever be signed. The circuit set is frozen.'
        : authority.threshold <= 1
          ? 'Threshold 1: whoever holds this key can rewrite the contract unilaterally.'
          : `Requires ${authority.threshold} of ${authority.committee.length} signatures.`,
    });
  }
}

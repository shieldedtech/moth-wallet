import { Args } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import { queryContractState } from '@shieldedtech/moth-wallet';

export default class State extends BaseCommand {
  static override description = 'Query public ledger state of a deployed contract';

  static override args = {
    address: Args.string({
      description: 'Contract address',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(State);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const address = await this.promptIfMissing(args.address, 'Contract address');
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    this.log_verbose(`Querying state for ${address} on ${network.indexerUrl}`);

    const state = await queryContractState(network.indexerUrl, address);

    if (!state) {
      this.outputError('INVALID_INPUT', `No contract found at address ${address}`);
      this.exit(1);
      return;
    }

    this.outputSuccess({
      address: state.address,
      state: state.state,
      lastUpdated: state.lastUpdated,
      unshieldedBalances: state.unshieldedBalances,
    });
  }
}

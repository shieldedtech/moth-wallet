import { BaseCommand } from '../base-command.js';
import { JsonRpcNodeClient, resolveProverConfig } from '@shieldedtech/moth-wallet';

export default class Info extends BaseCommand {
  static override description = 'Show network and node information';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Info);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    let blockHeight: number | string = 'unknown';
    let syncStatus = 'disconnected';

    try {
      const client = new JsonRpcNodeClient();
      await client.connect(network);
      blockHeight = await client.getBlockHeight();
      syncStatus = 'connected';
      await client.disconnect();
    } catch {
      syncStatus = 'unreachable';
    }

    const prover = resolveProverConfig(network);
    this.outputSuccess({
      network: network.id,
      nodeUrl: network.nodeUrl,
      indexerUrl: network.indexerUrl,
      prover: prover.type,
      proofServerUrl: prover.type === 'server' ? prover.url : null,
      blockHeight,
      syncStatus,
    });
  }
}

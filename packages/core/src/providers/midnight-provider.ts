import type {NetworkConfig} from '../types/network.js';
import type {PolkadotNodeClient} from '@midnightntwrk/wallet-sdk/node-client';
import {sdk} from '../sdk/index.js';

function toWsUrl(url: string): string {
  return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * MidnightProvider that submits finalized transactions to the node
 * via the SDK's PolkadotNodeClient (which uses @polkadot/api internally).
 */
export function createMidnightProvider(network: NetworkConfig) {
  let clientPromise: Promise<PolkadotNodeClient> | null = null;

  function getClient(): Promise<PolkadotNodeClient> {
    if (!clientPromise) {
      clientPromise = sdk().nodeClient.PolkadotNodeClient.init(
        sdk().nodeClient.makeConfig({
          nodeURL: new URL(toWsUrl(network.nodeUrl)),
        })
      );
    }
    return clientPromise;
  }

  return {
    async submitTx(finalizedTx: {serialize(): Uint8Array}): Promise<string> {
      const client = await getClient();
      const serialized = sdk().root.SerializedTransaction.from(finalizedTx);
      // Wait only for Submitted — finalization is tracked separately by publicDataProvider.
      const event = await client.sendMidnightTransactionAndWait(serialized, 'Submitted');
      return event.txHash;
    },
  };
}

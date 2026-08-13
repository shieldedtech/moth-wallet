import type {NetworkConfig} from '../types/network.js';
import {PolkadotNodeClient, makeConfig} from '@midnightntwrk/wallet-sdk/node-client';
import {SerializedTransaction} from '@midnightntwrk/wallet-sdk';

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
      clientPromise = PolkadotNodeClient.init(
        makeConfig({
          nodeURL: new URL(toWsUrl(network.nodeUrl)),
        })
      );
    }
    return clientPromise;
  }

  return {
    async submitTx(finalizedTx: {serialize(): Uint8Array}): Promise<string> {
      const client = await getClient();
      const serialized = SerializedTransaction.from(finalizedTx);
      // Wait only for Submitted — finalization is tracked separately by publicDataProvider.
      const event = await client.sendMidnightTransactionAndWait(serialized, 'Submitted');
      return event.txHash;
    },
  };
}

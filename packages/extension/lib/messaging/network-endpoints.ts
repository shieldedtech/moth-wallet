import type { NetworkConfig } from '@shieldedtech/moth-browser';
import { proverConfigsEqual, resolveProverConfig } from '@shieldedtech/moth-wallet/types/network';

/** Whether a sync engine started with `a` talks to the same node, indexer and prover as one started with `b`. */
export function sameEndpoints(a: NetworkConfig, b: NetworkConfig): boolean {
  return (
    a.nodeUrl === b.nodeUrl &&
    a.indexerUrl === b.indexerUrl &&
    proverConfigsEqual(resolveProverConfig(a), resolveProverConfig(b))
  );
}

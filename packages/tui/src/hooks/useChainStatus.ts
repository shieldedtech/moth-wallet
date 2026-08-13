// Chain status polling — epoch, slot, peers, block hash, indexer height.
// Polls via JSON-RPC like mn-tui's useMidnightNode. See NOTICE for attribution.

import { useState, useEffect, useRef } from 'react';
import type { NetworkConfig } from '@shieldedtech/moth-wallet';

export interface ChainStatus {
  peers: number;
  epoch: number;
  slot: number;
  blockHeight: number;
  blockHash: string;
  indexerHeight: number;
  synced: boolean;
  connected: boolean;
}

const INITIAL: ChainStatus = {
  peers: 0, epoch: 0, slot: 0, blockHeight: 0,
  blockHash: '', indexerHeight: 0, synced: false, connected: false,
};

// Midnight: 300 slots/epoch, 3s/slot
const SLOTS_PER_EPOCH = 300;

async function rpcCall<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const httpUrl = url.replace('ws://', 'http://').replace('wss://', 'https://');
  const res = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

async function graphqlQuery<T>(url: string, query: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(5_000),
  });
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

export function useChainStatus(network: NetworkConfig | null, intervalMs = 6_000) {
  const [status, setStatus] = useState<ChainStatus>(INITIAL);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!network) {
      setStatus(INITIAL);
      return;
    }

    const poll = async () => {
      try {
        // Parallel RPC calls
        const [header, health, indexerData] = await Promise.all([
          rpcCall<{ number: string; parentHash: string }>(network.nodeUrl, 'chain_getHeader'),
          rpcCall<{ peers: number; isSyncing: boolean }>(network.nodeUrl, 'system_health'),
          graphqlQuery<{ block: { height: number } }>(network.indexerUrl, '{ block { height } }').catch(() => ({ block: { height: 0 } })),
        ]);

        const blockHeight = parseInt(header.number, 16);
        // Get block hash for the current block
        const blockHash = await rpcCall<string>(network.nodeUrl, 'chain_getBlockHash', []).catch(() => '');

        // Derive epoch/slot from sidechain RPC if available. Public networks may not
        // expose sidechain_getStatus, or may return partial data — fall back per-field
        // to a block-height-based estimate so we never render NaN/undefined.
        let epoch: number | undefined;
        let slot: number | undefined;
        try {
          const sidechain = await rpcCall<{ slot?: number; epoch?: number } | null>(network.nodeUrl, 'sidechain_getStatus', []);
          if (sidechain && typeof sidechain === 'object') {
            if (typeof sidechain.slot === 'number') slot = sidechain.slot;
            if (typeof sidechain.epoch === 'number') epoch = sidechain.epoch;
          }
        } catch { /* method not supported — fall through to estimate */ }
        if (typeof slot !== 'number' || !Number.isFinite(slot)) slot = blockHeight;
        if (typeof epoch !== 'number' || !Number.isFinite(epoch)) epoch = Math.floor(slot / SLOTS_PER_EPOCH);

        setStatus({
          peers: health.peers,
          epoch,
          slot,
          blockHeight,
          blockHash: blockHash || header.parentHash,
          indexerHeight: indexerData.block.height,
          synced: !health.isSyncing,
          connected: true,
        });
      } catch {
        setStatus(prev => ({ ...prev, connected: false }));
      }
    };

    poll();
    intervalRef.current = setInterval(poll, intervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [network?.nodeUrl, network?.indexerUrl, intervalMs]);

  return status;
}

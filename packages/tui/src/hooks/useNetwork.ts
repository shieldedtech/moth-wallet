import { useState, useEffect, useCallback, useRef } from 'react';
import {
  JsonRpcNodeClient,
  canonicalNetworkId,
  DEFAULT_NETWORKS,
  resolveProverConfig,
  serverProver,
  type NetworkConfig,
} from '@shieldedtech/moth-wallet';
import type { NetworkState } from '../types.js';
import type { NetworkOverrides } from '../settings.js';

export function useNetwork(initialNetworkId: string = 'devnet') {
  const [state, setState] = useState<NetworkState>({
    id: initialNetworkId,
    nodeUrl: '',
    indexerUrl: '',
    proverType: 'server',
    proofServerUrl: '',
    blockHeight: 0,
    connected: false,
  });

  const clientRef = useRef<JsonRpcNodeClient | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track current network ID for polling — mutable ref so interval closure sees updates
  const currentIdRef = useRef(initialNetworkId);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  const connect = useCallback(async (id: string, overrides: NetworkOverrides = {}) => {
    // Stop existing polling
    stopPolling();

    // The id reaches here from persisted TUI settings and from --network, so a
    // renamed one is resolved before it is used to look up a preset or to key
    // the per-network overrides.
    id = canonicalNetworkId(id);

    const preset = DEFAULT_NETWORKS[id] ?? {
      id,
      nodeUrl: 'ws://localhost:9944',
      // The GraphQL path is part of the endpoint, not decoration: the indexer
      // client posts queries to it, and the bare origin is not a GraphQL endpoint.
      indexerUrl: 'http://localhost:8088/api/v4/graphql',
      prover: serverProver(),
    };
    const presetProver = resolveProverConfig(preset);
    const legacyProver = overrides.proofServerUrl
      ? serverProver(overrides.proofServerUrl)
      : presetProver;
    const prover = overrides.prover ?? legacyProver;
    const proofServerUrl = prover.type === 'server'
      ? prover.url
      : (presetProver.type === 'server' ? presetProver.url : serverProver().url);
    const config: NetworkConfig = {
      id,
      nodeUrl: overrides.nodeUrl ?? preset.nodeUrl,
      indexerUrl: overrides.indexerUrl ?? preset.indexerUrl,
      prover,
    };

    currentIdRef.current = id;

    setState({
      id,
      nodeUrl: config.nodeUrl,
      indexerUrl: config.indexerUrl,
      proverType: prover.type,
      proofServerUrl,
      blockHeight: 0,
      connected: false,
    });

    // Connect to new network
    const client = new JsonRpcNodeClient();
    try {
      await client.connect(config);
      const height = await client.getBlockHeight();
      clientRef.current = client;
      setState(prev => prev.id === id ? { ...prev, connected: true, blockHeight: height } : prev);
    } catch {
      setState(prev => prev.id === id ? { ...prev, connected: false } : prev);
    }

    // Start polling for new network
    intervalRef.current = setInterval(async () => {
      if (currentIdRef.current !== id) return; // Network changed, stop this interval
      if (clientRef.current?.isConnected()) {
        try {
          const height = await clientRef.current.getBlockHeight();
          setState(prev => prev.id === id ? { ...prev, blockHeight: height, connected: true } : prev);
        } catch {
          setState(prev => prev.id === id ? { ...prev, connected: false } : prev);
        }
      }
    }, 6_000);
  }, [stopPolling]);

  // Cleanup on unmount — initial connect is triggered by the app after settings load
  useEffect(() => {
    return stopPolling;
  }, [stopPolling]);

  const getConfig = useCallback((): NetworkConfig => {
    return {
      id: state.id,
      nodeUrl: state.nodeUrl,
      indexerUrl: state.indexerUrl,
      prover: state.proverType === 'wasm'
        ? { type: 'wasm' }
        : serverProver(state.proofServerUrl),
    };
  }, [state.id, state.nodeUrl, state.indexerUrl, state.proverType, state.proofServerUrl]);

  return { ...state, connect, getConfig };
}

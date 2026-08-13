export type ProverConfig =
  | { readonly type: 'server'; readonly url: string }
  | { readonly type: 'wasm' };

export interface NetworkEndpoints {
  readonly id: string;
  readonly nodeUrl: string;
  readonly indexerUrl: string;
  /**
   * Optional header attached to node requests, for endpoints that gate access
   * behind one (preprod rate-limits and answers 403 without the operator's
   * bypass header). SECRET — never log it, never include it in diagnostics.
   *
   * Carried here so every surface can reach it, but only the extension applies
   * it today, via declarativeNetRequest: a browser cannot set headers on a
   * WebSocket handshake, and the node connection is a WebSocket.
   */
  readonly nodeAuthHeader?: { readonly name: string; readonly value: string };
}

/**
 * Network services used by the wallet.
 *
 * `proofServerUrl` is retained as an input-only compatibility shape for
 * consumers built before prover selection was introduced. New configurations
 * should use the discriminated `prover` field.
 */
export type NetworkConfig = NetworkEndpoints &
  (
    | { readonly prover: ProverConfig; readonly proofServerUrl?: never }
    | { readonly prover?: never; readonly proofServerUrl: string }
  );

export function serverProver(
  url = 'http://localhost:6300',
): Extract<ProverConfig, { readonly type: 'server' }> {
  return { type: 'server', url };
}

/** Normalize the legacy proofServerUrl shape into the current prover config. */
export function resolveProverConfig(config: NetworkConfig): ProverConfig {
  return config.prover ?? serverProver(config.proofServerUrl);
}

export function isProverConfig(value: unknown): value is ProverConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProverConfig> & { url?: unknown };
  return candidate.type === 'wasm' || (candidate.type === 'server' && typeof candidate.url === 'string');
}

export function proverConfigsEqual(left: ProverConfig, right: ProverConfig): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'wasm') return true;
  return right.type === 'server' && left.url === right.url;
}

export function describeProver(config: ProverConfig): string {
  return config.type === 'wasm' ? 'WASM (local)' : `proof server (${config.url})`;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * Validate that a URL uses an allowed scheme (http/https/ws/wss).
 * Prevents SSRF via file://, ftp://, or other protocols (CWE-918).
 */
export function validateNetworkUrl(url: string, label: string): void {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new Error(`${label}: scheme "${parsed.protocol}" not allowed. Use http, https, ws, or wss.`);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`${label}: invalid URL "${url}"`);
    }
    throw err;
  }
}

/** Validate all URLs in a network config */
export function validateNetworkConfig(config: NetworkConfig): void {
  validateNetworkUrl(config.nodeUrl, 'Node URL');
  validateNetworkUrl(config.indexerUrl, 'Indexer URL');
  const prover = resolveProverConfig(config);
  if (prover.type === 'server') validateNetworkUrl(prover.url, 'Proof server URL');
}

// Endpoint values mirror midnight-wallet-cli/src/config/environments.ts.
// Format follows moth-wallet's NetworkConfig: HTTP-style URLs that the sync
// layer auto-converts to WS where needed.
export const DEFAULT_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    id: 'mainnet',
    nodeUrl: 'https://rpc.mainnet.midnight.network',
    indexerUrl: 'https://indexer.mainnet.midnight.network/api/v4/graphql',
    prover: serverProver(),
  },
  preprod: {
    id: 'preprod',
    nodeUrl: 'https://rpc.preprod.midnight.network',
    indexerUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    prover: serverProver(),
  },
  preview: {
    id: 'preview',
    nodeUrl: 'https://rpc.preview.midnight.network',
    indexerUrl: 'https://indexer.preview.midnight.network/api/v4/graphql',
    prover: serverProver(),
  },
  qanet: {
    id: 'qanet',
    nodeUrl: 'https://rpc.qanet.midnight.network',
    indexerUrl: 'https://indexer.qanet.midnight.network/api/v4/graphql',
    prover: serverProver(),
  },
  devnet: {
    id: 'devnet',
    nodeUrl: 'https://rpc.devnet.midnight.network',
    indexerUrl: 'https://indexer.devnet.midnight.network/api/v4/graphql',
    prover: serverProver(),
  },
  undeployed: {
    id: 'undeployed',
    nodeUrl: 'ws://localhost:9944',
    indexerUrl: 'http://localhost:8088/api/v4/graphql',
    prover: serverProver(),
  },
  local: {
    id: 'local',
    nodeUrl: 'ws://localhost:9933',
    indexerUrl: 'http://localhost:8088/api/v4/graphql',
    prover: serverProver(),
  },
};

/**
 * Networks the wallet fully supports — it derives addresses for these and can
 * build and submit transactions on them. Mirrors `ALL_NETWORKS` in
 * wallet/address.ts; keep the two in sync. Mainnet is first because it is the
 * default network.
 *
 * Note this is a subset of `DEFAULT_NETWORKS`: `undeployed` has a preset but the
 * wallet can't derive addresses for it, so it is not offered as a choice.
 */
export const SUPPORTED_NETWORKS = ['mainnet', 'devnet', 'preview', 'preprod', 'qanet', 'local'] as const;

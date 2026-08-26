/**
 * Which ledger a network speaks. Midnight is hard-forking from v8 to v9, so the
 * two coexist: `v8` covers mainnet, preprod, preview and qanet; `v9` covers the
 * forked networks. Absent means `v8`, so configs written before the fork keep
 * their behavior. See ADR-0006.
 */
export type LedgerVersion = 'v8' | 'v9';

export type ProverConfig =
  | { readonly type: 'server'; readonly url: string }
  | { readonly type: 'wasm' };

export interface NetworkEndpoints {
  readonly id: string;
  readonly nodeUrl: string;
  readonly indexerUrl: string;
  /** Faucet for test funds. Absent on networks that have none, mainnet included. */
  readonly faucetUrl?: string;
  /** Defaults to `v8` — see {@link resolveLedgerVersion}. */
  readonly ledgerVersion?: LedgerVersion;
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

/** The ledger a config speaks, defaulting to v8 for pre-fork configurations. */
export function resolveLedgerVersion(config: NetworkEndpoints): LedgerVersion {
  return config.ledgerVersion ?? 'v8';
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
  if (config.faucetUrl !== undefined) validateNetworkUrl(config.faucetUrl, 'Faucet URL');
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
  // Forked ahead of the other midnight.network networks: its indexer reports
  // protocolVersion 2000000, and its transactions are tagged transaction[v12],
  // which only ledger v9 accepts.
  devnet: {
    id: 'devnet',
    nodeUrl: 'https://rpc.devnet.midnight.network',
    indexerUrl: 'https://indexer.devnet.midnight.network/api/v4/graphql',
    ledgerVersion: 'v9',
    prover: serverProver(),
  },
  // The MNF demo network, and the first stack Moth targets on ledger v9. Unlike
  // the midnight.network networks it is operated by Shielded and carries a faucet.
  stagenet: {
    id: 'stagenet',
    nodeUrl: 'https://rpc.stagenet.shielded.tools',
    indexerUrl: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
    faucetUrl: 'https://faucet.stagenet.shielded.tools',
    ledgerVersion: 'v9',
    prover: serverProver(),
  },
  undeployed: {
    id: 'undeployed',
    nodeUrl: 'ws://localhost:9944',
    indexerUrl: 'http://localhost:8088/api/v4/graphql',
    prover: serverProver(),
  },
};

/**
 * Networks the wallet offers as a choice — it derives addresses for these, and
 * can build and submit transactions on them. Mainnet is first because it is the
 * default network.
 *
 * This list and the keys of `DEFAULT_NETWORKS` are the same set, and a test
 * holds them equal: a preset with no entry here is a network the UI cannot
 * reach, and an entry here with no preset falls through to a localhost guess.
 *
 * `ALL_NETWORKS` in wallet/address.ts is deliberately WIDER — it is the set of
 * bech32m prefixes a wallet may hold an address for, which includes retired and
 * unoffered ids. Do not narrow it to match this list.
 */
export const SUPPORTED_NETWORKS = [
  'mainnet',
  'devnet',
  'preview',
  'preprod',
  'qanet',
  'stagenet',
  'undeployed',
] as const;

/**
 * Network ids that were renamed, mapped to what they are now called.
 *
 * `local` was a second preset for the same local devnet stack as `undeployed`,
 * pointing at a node port nothing in that stack listens on. It reached storage
 * as a wallet's network and as the extension's selected network, so read paths
 * canonicalise rather than leaving a stored `local` to miss every preset and
 * fall through to a localhost guess.
 */
const RENAMED_NETWORK_IDS = new Map<string, string>([['local', 'undeployed']]);

/**
 * Resolve a stored or user-supplied network id to the id in use today.
 *
 * Apply this wherever a network id is READ from persistence or from a flag —
 * never when writing one, so the mapping stays a migration rather than a
 * permanent alias.
 *
 * A Map rather than an object literal because the input is arbitrary: network
 * ids are not restricted to a known list (endpoints are overridable, so a custom
 * id is a legitimate target), and an object lookup answers `toString` and
 * `constructor` from `Object.prototype` — returning a function where a string is
 * declared, which would then reach setNetworkId(), socket paths and JSON output.
 */
export function canonicalNetworkId(id: string): string {
  return RENAMED_NETWORK_IDS.get(id) ?? id;
}

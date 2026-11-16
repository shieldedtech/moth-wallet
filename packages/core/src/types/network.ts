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

// Hosted endpoints live under *.shielded.tools, except preview, which stays on
// *.midnight.network until its shielded.tools hosts have DNS records. The
// extension's host_permissions in wxt.config.ts must cover every host here, so
// change both together.
// Format follows moth-wallet's NetworkConfig: HTTP-style URLs that the sync
// layer auto-converts to WS where needed.
export const DEFAULT_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    id: 'mainnet',
    nodeUrl: 'https://rpc.mainnet.shielded.tools',
    indexerUrl: 'https://indexer.mainnet.shielded.tools/api/v4/graphql',
    prover: serverProver(),
  },
  preprod: {
    id: 'preprod',
    nodeUrl: 'https://rpc.preprod.shielded.tools',
    indexerUrl: 'https://indexer.preprod.shielded.tools/api/v4/graphql',
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
    nodeUrl: 'https://rpc.qanet.shielded.tools',
    indexerUrl: 'https://indexer.qanet.shielded.tools/api/v4/graphql',
    prover: serverProver(),
  },
  devnet: {
    id: 'devnet',
    nodeUrl: 'https://rpc.devnet.shielded.tools',
    indexerUrl: 'https://indexer.devnet.shielded.tools/api/v4/graphql',
    prover: serverProver(),
  },
  undeployed: {
    id: 'undeployed',
    nodeUrl: 'ws://localhost:9944',
    indexerUrl: 'http://localhost:8088/api/v4/graphql',
    prover: serverProver(),
  },
  // midnight-node's local-env (CFG_PRESET=local): a separate chain from the
  // `undeployed` dev stack, not an alias for it. Its network id reaches the
  // addresses (`mn_addr_local1…`), so serving it as `undeployed` derives the
  // wrong HRP and reads every unshielded balance as zero. Node-1 serves 9933.
  local: {
    id: 'local',
    nodeUrl: 'ws://localhost:9933',
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
export const SUPPORTED_NETWORKS = ['mainnet', 'devnet', 'preview', 'preprod', 'qanet', 'local', 'undeployed'] as const;

/**
 * Network ids that were renamed, mapped to what they are now called.
 *
 * Empty today. `local` was once mapped to `undeployed`, but it is midnight-node's
 * local-env — a chain of its own (see DEFAULT_NETWORKS) — and the rename sent
 * its wallets to the wrong address prefix.
 */
const RENAMED_NETWORK_IDS = new Map<string, string>();

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
 * declared, which would then reach the providers' network id, socket paths and JSON output.
 */
export function canonicalNetworkId(id: string): string {
  return RENAMED_NETWORK_IDS.get(id) ?? id;
}

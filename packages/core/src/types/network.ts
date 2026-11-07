import { InvalidInputError } from './errors.js';

/**
 * Measurements of one Lace proof server, captured ahead of time.
 * Phase 3 of a local attestation session checks the quote against this pin.
 * The pin is not read from the VM under check.
 */
export interface ProofServerMeasurementPin {
  /** 48-byte SEV-SNP launch measurement, hex. */
  readonly launchMeasurement: string;
  /** 16-byte image id, hex. */
  readonly imageId: string;
  /** Minimum acceptable microcode SVN. */
  readonly microcodeSvn: number;
  /** Minimum acceptable SNP firmware SVN. */
  readonly snpfwSvn: number;
  /** PCR 0–4. PCR 15 is recomputed from the quote; it is not a pin field. */
  readonly pcrs: {
    readonly 0: string;
    readonly 1: string;
    readonly 2: string;
    readonly 3: string;
    readonly 4: string;
  };
  /** 32-byte dm-verity root hash of the application disk, hex. */
  readonly applicationDiskRoothash: string;
}

/** Where to fetch the quote, and the measurements it must match. */
export interface ProofServerAttestation {
  /** Host that serves `/tee_attestation` and `attestation.json`. */
  readonly attestationHost: string;
  readonly pin: ProofServerMeasurementPin;
}

export type ProverConfig =
  | { readonly type: 'server'; readonly url: string; readonly attestation?: ProofServerAttestation }
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

/** A remote proof server whose quote must match `attestation` before a witness leaves. */
export function attestedServerProver(
  url: string,
  attestation: ProofServerAttestation,
): Extract<ProverConfig, { readonly type: 'server' }> {
  return { type: 'server', url, attestation };
}

/**
 * A proof server on this machine. Loopback stays on the plain HTTP client;
 * every other host needs a measurement pin before a witness is sent.
 */
export function isLoopbackProofServer(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Attach a stored pin to a remote server prover.
 * A loopback URL keeps the plain client, so a pin saved for Lace does not
 * change `http://localhost:6300`.
 */
export function applyStoredProofServerPin(
  prover: ProverConfig,
  attestation: ProofServerAttestation | undefined,
): ProverConfig {
  if (!attestation || prover.type !== 'server' || isLoopbackProofServer(prover.url)) return prover;
  return { ...prover, attestation };
}

/** Parse the `proof-server-pin` config value. Throws when a field is missing. */
export function parseProofServerAttestation(raw: string): ProofServerAttestation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidInputError('Proof server pin is not valid JSON');
  }
  if (!isProofServerAttestation(value)) {
    throw new InvalidInputError('Proof server pin is missing a host or a measurement field');
  }
  return value;
}

/** Normalize the legacy proofServerUrl shape into the current prover config. */
export function resolveProverConfig(config: NetworkConfig): ProverConfig {
  return config.prover ?? serverProver(config.proofServerUrl);
}

function isHexField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isProofServerAttestation(value: unknown): value is ProofServerAttestation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProofServerAttestation>;
  if (typeof candidate.attestationHost !== 'string' || candidate.attestationHost.trim() === '') return false;
  const pin = candidate.pin;
  if (!pin || typeof pin !== 'object') return false;
  const pcrs = pin.pcrs;
  if (!pcrs) return false;
  return isHexField(pin.launchMeasurement)
    && isHexField(pin.imageId)
    && isHexField(pin.applicationDiskRoothash)
    && typeof pin.microcodeSvn === 'number'
    && Number.isInteger(pin.microcodeSvn)
    && pin.microcodeSvn >= 0
    && typeof pin.snpfwSvn === 'number'
    && Number.isInteger(pin.snpfwSvn)
    && pin.snpfwSvn >= 0
    && isHexField(pcrs[0])
    && isHexField(pcrs[1])
    && isHexField(pcrs[2])
    && isHexField(pcrs[3])
    && isHexField(pcrs[4]);
}

export function isProverConfig(value: unknown): value is ProverConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProverConfig> & { url?: unknown; attestation?: unknown };
  if (candidate.type === 'wasm') return true;
  if (candidate.type !== 'server' || typeof candidate.url !== 'string') return false;
  return candidate.attestation === undefined || isProofServerAttestation(candidate.attestation);
}

function attestationIdentity(attestation: ProofServerAttestation | undefined): string {
  if (!attestation) return '';
  const pin = attestation.pin;
  const hex = (value: string) => value.toLowerCase();
  return [
    attestation.attestationHost.toLowerCase(),
    hex(pin.launchMeasurement),
    hex(pin.imageId),
    String(pin.microcodeSvn),
    String(pin.snpfwSvn),
    hex(pin.pcrs[0]),
    hex(pin.pcrs[1]),
    hex(pin.pcrs[2]),
    hex(pin.pcrs[3]),
    hex(pin.pcrs[4]),
    hex(pin.applicationDiskRoothash),
  ].join('\n');
}

export function proverConfigsEqual(left: ProverConfig, right: ProverConfig): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'wasm') return true;
  return right.type === 'server'
    && left.url === right.url
    && attestationIdentity(left.attestation) === attestationIdentity(right.attestation);
}

export function describeProver(config: ProverConfig): string {
  if (config.type === 'wasm') return 'WASM (local)';
  return config.attestation
    ? `attested proof server (${config.url})`
    : `proof server (${config.url})`;
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
export const SUPPORTED_NETWORKS = ['mainnet', 'devnet', 'preview', 'preprod', 'qanet', 'undeployed'] as const;

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

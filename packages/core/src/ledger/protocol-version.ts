// Mapping between a network's reported protocol version and the ledger it
// speaks, and the guard that stops a wallet transacting across that boundary.
//
// The mapping is measured, not published: the wallet SDK deliberately keeps the
// fork version out of its code while it is unsettled. Cross-decoding real
// transactions on 2026-08-18 showed preprod (1000000) accepted only by v8 and
// devnet (2000000) accepted only by v9, in both directions. See ADR-0006, and
// tests/unit/ledger/fork-incompatibility.test.ts which pins the wire tags.
//
// A guard is needed because the fork is partial. Collapsed Merkle updates are
// tagged [v1] on both sides and decode under either ledger, so a mismatched
// wallet syncs without complaint and only fails once it touches a transaction —
// by which point the user has been given every reason to think it worked.

import {WalletError} from '../types/errors.js';
import type {LedgerVersion} from '../types/network.js';

/** Pre-fork: mainnet, preprod, preview, qanet. */
export const PROTOCOL_VERSION_V8 = 1_000_000;
/** Post-fork: devnet, stagenet. */
export const PROTOCOL_VERSION_V9 = 2_000_000;

/**
 * The ledger a protocol version implies, or undefined if we have never seen it.
 * Unknown is deliberately not an error here — the caller decides whether an
 * unrecognised network is fatal.
 */
export function ledgerVersionForProtocol(protocolVersion: number): LedgerVersion | undefined {
  if (protocolVersion === PROTOCOL_VERSION_V8) return 'v8';
  if (protocolVersion === PROTOCOL_VERSION_V9) return 'v9';
  return undefined;
}

export interface LedgerNetworkCheck {
  /** Network being addressed, for the message. */
  readonly networkId: string;
  /** The ledger this wallet has loaded. */
  readonly using: LedgerVersion;
  /** protocolVersion as reported by the network's indexer. */
  readonly observedProtocolVersion: number;
  /**
   * What was about to happen, so the message can say what did not. Defaults to
   * submission — the case where saying so matters most.
   */
  readonly action?: 'submit' | 'sync';
}

function didNotHappen(action: 'submit' | 'sync' = 'submit'): string {
  return action === 'sync' ? 'Sync did not start.' : 'Nothing was submitted.';
}

/**
 * Throw unless the loaded ledger matches the network. Call before submitting
 * anything — the message assumes the caller has not yet transacted.
 */
export function assertLedgerForNetwork({
  networkId,
  using,
  observedProtocolVersion,
  action,
}: LedgerNetworkCheck): void {
  const expected = ledgerVersionForProtocol(observedProtocolVersion);

  if (expected === undefined) {
    throw new WalletError(
      'NETWORK_ERROR',
      `${networkId} reports an unrecognised protocol version (${observedProtocolVersion}), so the ledger it ` +
        `needs cannot be determined. This wallet is using ledger ${using}. ${didNotHappen(action)}`,
    );
  }

  if (expected !== using) {
    throw new WalletError(
      'NETWORK_ERROR',
      `${networkId} is on ledger ${expected} (protocol ${observedProtocolVersion}) but this wallet is using ` +
        `ledger ${using}. The two ledgers cannot read each other's transactions. ${didNotHappen(action)} ` +
        `Reconnect to ${networkId} to pick up the ledger it is running.`,
    );
  }
}

/**
 * Ask the network what protocol it is on and check it against the loaded
 * ledger. The probe is injectable so callers can supply a cached value rather
 * than paying an indexer round-trip on every submission.
 */
export async function verifyNetworkLedger(
  network: {readonly id: string; readonly indexerUrl: string},
  options: {
    readonly using: LedgerVersion;
    readonly probe?: (indexerUrl: string) => Promise<number | undefined>;
    readonly action?: 'submit' | 'sync';
  },
): Promise<void> {
  const probe = options.probe ?? defaultProbe;
  const observed = await probe(network.indexerUrl);
  if (observed === undefined) {
    throw new WalletError(
      'NETWORK_ERROR',
      `${network.id} did not report a protocol version, so its ledger could not be confirmed. ` +
        didNotHappen(options.action),
    );
  }
  assertLedgerForNetwork({
    networkId: network.id,
    using: options.using,
    observedProtocolVersion: observed,
    action: options.action,
  });
}

async function defaultProbe(indexerUrl: string): Promise<number | undefined> {
  // Imported lazily to keep the ledger module free of a network dependency for
  // callers that supply their own probe.
  const {IndexerClient} = await import('../network/indexer-client.js');
  const block = await new IndexerClient(indexerUrl).getBlock();
  return block?.protocolVersion;
}

/** What a network turned out to be running, and where that answer came from. */
export interface DetectedLedger {
  readonly version: LedgerVersion;
  /** `network` when the indexer answered and we recognised it; `config` otherwise. */
  readonly source: 'network' | 'config';
  /** Present whenever the indexer answered, even if we did not recognise it. */
  readonly observedProtocolVersion?: number;
}

const detected = new Map<string, DetectedLedger>();

/**
 * Which ledger a network is actually running, preferring what it reports over
 * what Moth was shipped believing.
 *
 * The static table in DEFAULT_NETWORKS is a starting point, not the truth. It
 * was wrong about devnet from the moment devnet forked, and it will be wrong
 * about preprod the moment preprod does — for every install, until a release
 * ships. Asking the network costs one indexer round-trip per network per
 * process and removes that whole class of staleness.
 *
 * Detection is deliberately forgiving: an unreachable indexer or an
 * unrecognised protocol version falls back to the configured value rather than
 * refusing to start, because a wallet that will not open is worse than one that
 * opens with a stale guess. The unforgiving check is {@link verifyNetworkLedger}
 * at submission, which runs live and refuses rather than guessing — so a fork
 * that happens mid-session is caught before anything is sent.
 */
export async function detectLedgerVersion(
  network: {readonly id: string; readonly indexerUrl: string; readonly ledgerVersion?: LedgerVersion},
  options: {readonly probe?: (indexerUrl: string) => Promise<number | undefined>} = {},
): Promise<DetectedLedger> {
  const cached = detected.get(network.id);
  if (cached) return cached;

  const configured: LedgerVersion = network.ledgerVersion ?? 'v8';
  const probe = options.probe ?? defaultProbe;

  let observed: number | undefined;
  try {
    observed = await probe(network.indexerUrl);
  } catch {
    // Offline, blocked, or still syncing — the configured value stands.
    observed = undefined;
  }

  const fromNetwork = observed === undefined ? undefined : ledgerVersionForProtocol(observed);
  const result: DetectedLedger =
    fromNetwork !== undefined
      ? {version: fromNetwork, source: 'network', observedProtocolVersion: observed}
      : {version: configured, source: 'config', ...(observed !== undefined ? {observedProtocolVersion: observed} : {})};

  detected.set(network.id, result);
  return result;
}

/** Forget what every network reported. For tests, and after a network edit. */
export function resetLedgerDetectionCache(networkId?: string): void {
  if (networkId === undefined) detected.clear();
  else detected.delete(networkId);
}

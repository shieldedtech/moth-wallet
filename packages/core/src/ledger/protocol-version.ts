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
}

/**
 * Throw unless the loaded ledger matches the network. Call before submitting
 * anything — the message assumes the caller has not yet transacted.
 */
export function assertLedgerForNetwork({networkId, using, observedProtocolVersion}: LedgerNetworkCheck): void {
  const expected = ledgerVersionForProtocol(observedProtocolVersion);

  if (expected === undefined) {
    throw new WalletError(
      'NETWORK_ERROR',
      `${networkId} reports an unrecognised protocol version (${observedProtocolVersion}), so the ledger it ` +
        `needs cannot be determined. This wallet is using ledger ${using}. Nothing was submitted.`,
    );
  }

  if (expected !== using) {
    throw new WalletError(
      'NETWORK_ERROR',
      `${networkId} is on ledger ${expected} (protocol ${observedProtocolVersion}) but this wallet is using ` +
        `ledger ${using}. The two ledgers cannot read each other's transactions, so nothing was submitted. ` +
        `Switch to a ${expected} network, or reconnect with ledgerVersion '${expected}' configured for ${networkId}.`,
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
  },
): Promise<void> {
  const probe = options.probe ?? defaultProbe;
  const observed = await probe(network.indexerUrl);
  if (observed === undefined) {
    throw new WalletError(
      'NETWORK_ERROR',
      `${network.id} did not report a protocol version, so its ledger could not be confirmed. Nothing was submitted.`,
    );
  }
  assertLedgerForNetwork({networkId: network.id, using: options.using, observedProtocolVersion: observed});
}

async function defaultProbe(indexerUrl: string): Promise<number | undefined> {
  // Imported lazily to keep the ledger module free of a network dependency for
  // callers that supply their own probe.
  const {IndexerClient} = await import('../network/indexer-client.js');
  const block = await new IndexerClient(indexerUrl).getBlock();
  return block?.protocolVersion;
}

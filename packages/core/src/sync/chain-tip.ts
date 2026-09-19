// A network's current block height, for recording as a new wallet's birthday.
//
// The birthday is what lets a wallet's first sync start from a pre-seed
// reference instead of walking the chain from genesis — the `reference.height
// <= birthday` guard in wallet-sync refuses to seed any wallet that might have
// history the reference does not cover, and a wallet with no birthday is
// exactly that case. So a missing birthday is not a small loss: it is the
// difference between 29.3s and 78.6 min on preprod.
//
// This lived in the extension's background handlers, where it was reachable
// only from the panel. The CLI and TUI create wallets through the same
// WalletManager and want the same thing, so it belongs here.

import {IndexerClient} from '../network/indexer-client.js';

/**
 * Current tip height for `network`, or undefined if it cannot be determined.
 *
 * Deliberately best-effort. An unreachable indexer must never block wallet
 * creation: a wallet the user can hold and sync slowly is worth more than a
 * failed create, and the only consequence of a missing birthday is that the
 * first sync takes the long path.
 *
 * IMPORTANT: only ever record this for wallets generated locally. A wallet
 * restored from a mnemonic may hold funds at any height, and giving it today's
 * tip as a birthday would let a reference seed it past its own history — its
 * earlier coins would never be scanned and would silently vanish. See
 * WalletManager.setNetwork and ADR 0003.
 */
export async function chainTip(indexerUrl: string): Promise<number | undefined> {
  try {
    const block = await new IndexerClient(indexerUrl).getBlock();
    return block?.height;
  } catch {
    return undefined;
  }
}

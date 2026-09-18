import * as ledger from '@midnight-ntwrk/ledger-v8';
import {collapseDustReference} from './dust-reference-collapse.js';
import {deriveWalletKeys} from './operations.js';
import {preSeedNewWallet, type EmptyRefStates} from './preseed.js';

function hexBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(value)) throw new Error('Invalid snapshot state');
  return Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));
}

/**
 * v8's utxos getter hides pending spends and exposes no ownership-map getter.
 * Pin its debug representation, failing CLOSED if the ledger changes it. Both
 * maps must be empty: a zero balance, or even an empty utxos getter, is not proof
 * that a snapshot is safe to donate. Never attempt to strip owned ledger data.
 */
export function hasNoDustOwnership(state: ledger.DustLocalState): boolean {
  return state.utxos.length === 0 &&
    /, night_indices: \{\}, dust_utxos: \{\}, sync_time: Timestamp\(\d+\), params: DustParameters \{[^{}]*\} \}$/.test(state.toString(true));
}

/**
 * Convert a captured first-sync snapshot to a reference in an isolated worker.
 * No user keys are accepted. Any ownership/pending records make it ineligible;
 * only the public tree state survives, under a fresh throwaway public identity.
 * The input strings (and the live wallet) are never modified.
 */
export function optimizeReferenceCandidate(networkId: string, snapshot: EmptyRefStates): EmptyRefStates {
  if (!Number.isSafeInteger(snapshot.height) || snapshot.height <= 0) throw new Error('Invalid reference height');
  const sh = JSON.parse(snapshot.shielded);
  const un = JSON.parse(snapshot.unshielded);
  const du = JSON.parse(snapshot.dust);
  for (const envelope of [sh, un, du]) {
    if (envelope.networkId !== networkId || !/^\d+$/.test(String(envelope.protocolVersion))) throw new Error('Snapshot network/protocol mismatch');
  }
  for (const envelope of [sh, du]) {
    if (!/^\d+$/.test(String(envelope.offset)) || BigInt(envelope.offset) <= 0n) throw new Error('Snapshot has no sync cursor');
  }
  if (!/^\d+$/.test(String(un.appliedId))) throw new Error('Snapshot has no transaction cursor');
  const shielded = ledger.ZswapLocalState.deserialize(hexBytes(sh.state));
  if (shielded.coins.size || shielded.pendingOutputs.size || shielded.pendingSpends.size ||
      !sh.coinHashes || Object.keys(sh.coinHashes).length) throw new Error('Snapshot contains shielded ownership records');
  if (!Array.isArray(un.state?.availableUtxos) || !Array.isArray(un.state?.pendingUtxos) ||
      un.state.availableUtxos.length || un.state.pendingUtxos.length) throw new Error('Snapshot contains unshielded ownership records');
  const dust = ledger.DustLocalState.deserialize(hexBytes(du.state));
  if (!hasNoDustOwnership(dust)) throw new Error('Snapshot contains DUST ownership records, or the ledger ownership check is unsupported');

  const collapsed = collapseDustReference(snapshot.dust);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    const keys = deriveWalletKeys(Array.from(seed, b => b.toString(16).padStart(2, '0')).join(''));
    const reference = preSeedNewWallet(keys, networkId, {...snapshot, dust: collapsed.json});
    if (!reference?.dust) throw new Error('Could not construct an empty reference');
    const restored = ledger.ZswapLocalState.deserialize(hexBytes(JSON.parse(reference.shielded).state));
    if (restored.merkleTreeRoot !== shielded.merkleTreeRoot || restored.firstFree !== shielded.firstFree ||
        restored.coins.size || restored.pendingOutputs.size || restored.pendingSpends.size) {
      throw new Error('Reference conversion changed shielded state');
    }
    return {...reference, dust: reference.dust, height: snapshot.height};
  } finally { seed.fill(0); }
}

import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {hasNoDustOwnership, optimizeReferenceCandidate} from '../../../src/sync/reference-candidate.js';
import {preSeedNewWallet, type EmptyRefStates} from '../../../src/sync/preseed.js';
import {deriveWalletKeys} from '../../../src/sync/operations.js';
import {serializeReferenceCandidate} from '../../../src/sync/wallet-sync.js';
import type {FacadeState} from '@midnightntwrk/wallet-sdk/facade';

const fixture = (part: string) => gunzipSync(readFileSync(new URL(`../../../../extension/public/preseed/preview/${part}.dat.gz`, import.meta.url))).toString();
const height = JSON.parse(readFileSync(new URL('../../../../extension/public/preseed/preview/manifest.json', import.meta.url), 'utf8')).height;
const original: EmptyRefStates = {height, shielded: fixture('shielded'), unshielded: fixture('unshielded'), dust: fixture('dust')};
const keys = deriveWalletKeys('01'.repeat(32));
const dustOf = (snapshot: EmptyRefStates) => ledger.DustLocalState.deserialize(Buffer.from(JSON.parse(snapshot.dust).state, 'hex'));
const shieldedOf = (snapshot: EmptyRefStates) => ledger.ZswapLocalState.deserialize(Buffer.from(JSON.parse(snapshot.shielded).state, 'hex'));
function replaceState(part: 'dust' | 'shielded', state: {serialize(): Uint8Array}): EmptyRefStates {
  return {...original, [part]: JSON.stringify({...JSON.parse(original[part]), state: Buffer.from(state.serialize()).toString('hex')})};
}
const output = {initialValue: 1n, owner: 0n, nonce: 0n, seq: 0, ctime: new Date(0), backingNight: '00'.repeat(32), mtIndex: 0n};

describe('background reference snapshot conversion', () => {
  it('converts a newly seeded wallet without changing its trees, cursors, or live snapshot', () => {
    const wallet = preSeedNewWallet(keys, 'preview', original)!;
    const captured = {...original, ...wallet};
    const before = JSON.stringify(captured);
    const reference = optimizeReferenceCandidate('preview', captured);
    expect(JSON.stringify(captured)).toBe(before);
    expect(JSON.parse(reference.shielded).publicKeys).not.toEqual(JSON.parse(captured.shielded).publicKeys);
    expect(JSON.parse(reference.unshielded).publicKey).not.toEqual(JSON.parse(captured.unshielded).publicKey);
    expect(JSON.parse(reference.dust).publicKey).not.toEqual(JSON.parse(captured.dust).publicKey);
    for (const part of ['shielded', 'dust'] as const) expect(JSON.parse(reference[part]).offset).toBe(JSON.parse(captured[part]).offset);
    expect(JSON.parse(reference.unshielded).appliedId).toBe(JSON.parse(captured.unshielded).appliedId);
    expect(shieldedOf(reference).merkleTreeRoot).toBe(shieldedOf(captured).merkleTreeRoot);
    expect(shieldedOf(reference).firstFree).toBe(shieldedOf(captured).firstFree);
    expect(dustOf(reference).generatingTreeRoot()).toBe(dustOf(captured).generatingTreeRoot());
    expect(dustOf(reference).commitmentTreeRoot()).toBe(dustOf(captured).commitmentTreeRoot());
    expect(hasNoDustOwnership(dustOf(reference))).toBe(true);
    // The result is itself eligible, independent of the temporary public identity.
    expect(() => optimizeReferenceCandidate('preview', reference)).not.toThrow();
  });

  it('rejects shielded coins and expected outputs, including zero-value coins', () => {
    const coin = {type: '00'.repeat(32), nonce: '00'.repeat(32), value: 0n};
    const withCoin = shieldedOf(original).insertCoin(keys.shieldedSecretKeys, coin);
    expect(() => optimizeReferenceCandidate('preview', replaceState('shielded', withCoin))).toThrow(/shielded ownership/);
    const pending = shieldedOf(original).watchFor(keys.shieldedSecretKeys.coinPublicKey, coin);
    expect(() => optimizeReferenceCandidate('preview', replaceState('shielded', pending))).toThrow(/shielded ownership/);
  });

  it('rejects unshielded available and pending records even if their value is zero', () => {
    for (const field of ['availableUtxos', 'pendingUtxos']) {
      const un = JSON.parse(original.unshielded);
      un.state[field] = [{value: '0'}];
      expect(() => optimizeReferenceCandidate('preview', {...original, unshielded: JSON.stringify(un)})).toThrow(/unshielded ownership/);
    }
  });

  it('rejects DUST outputs, including pending spends hidden by the public utxos getter', () => {
    const state = dustOf(original);
    const pending = state.addUtxo(1n, output, new Date('2099-01-01'));
    expect(pending.utxos).toHaveLength(0); // The subtle case: empty public list is insufficient.
    expect(hasNoDustOwnership(pending)).toBe(false);
    expect(() => optimizeReferenceCandidate('preview', replaceState('dust', pending))).toThrow(/DUST ownership/);
    expect(() => optimizeReferenceCandidate('preview', replaceState('dust', state.addUtxo(1n, output)))).toThrow(/DUST ownership/);
  });

  it('rejects owned NIGHT generation records even before DUST appears', () => {
    const state = dustOf(original);
    const firstFree = BigInt(/generating_tree_first_free: (\d+)/.exec(state.toString(true))![1]);
    const owned = state.insertGenerationInfo(firstFree, {value: 1n, owner: 0n, nonce: '01'.repeat(32), dtime: undefined}, '02'.repeat(32));
    expect(owned.utxos).toHaveLength(0);
    expect(hasNoDustOwnership(owned)).toBe(false);
    expect(() => optimizeReferenceCandidate('preview', replaceState('dust', owned))).toThrow(/DUST ownership/);
  });

  it('fails closed when the pinned ledger ownership representation changes', () => {
    expect(hasNoDustOwnership({utxos: [], toString: () => 'NewLedgerFormat'} as unknown as ledger.DustLocalState)).toBe(false);
  });

  it('rejects wrong networks, missing progress and private coin metadata', () => {
    expect(() => optimizeReferenceCandidate('preprod', original)).toThrow(/network/);
    const sh = JSON.parse(original.shielded);
    expect(() => optimizeReferenceCandidate('preview', {...original, shielded: JSON.stringify({...sh, offset: '0'})})).toThrow(/cursor/);
    expect(() => optimizeReferenceCandidate('preview', {...original, shielded: JSON.stringify({...sh, coinHashes: {owned: {}}})})).toThrow(/ownership/);
  });

  it('captures immutable strings from the same fully synced emission and refuses pending transactions', () => {
    const sub = (value: string) => ({state: {value}, capabilities: {serialization: {serialize: (state: {value: string}) => state.value}}});
    const state = {isSynced: true, pending: {all: []}, shielded: sub(original.shielded), unshielded: sub(original.unshielded), dust: sub(original.dust)};
    const captured = serializeReferenceCandidate(state as unknown as FacadeState);
    state.dust.state.value = 'later wallet state';
    expect(captured.dust).toBe(original.dust);
    expect(() => serializeReferenceCandidate({...state, isSynced: false} as unknown as FacadeState)).toThrow(/synced/);
    expect(() => serializeReferenceCandidate({...state, pending: {all: [{}]}} as unknown as FacadeState)).toThrow(/synced/);
  });
});

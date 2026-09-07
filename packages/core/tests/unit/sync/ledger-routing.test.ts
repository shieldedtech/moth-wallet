// Bytes that reach moth without a protocol version — a dApp's transaction, a hex
// payload on the daemon socket — are read with the ledger the wallets are acting
// at. These pin that the routing follows the fork schedule, that the resulting
// handle carries what the facade and the activity feed need, and that a
// pre-seeded snapshot gets the key shape of the variant that will read it.

import {describe, expect, it} from 'vitest';
import * as ledgerV8 from '@midnightntwrk/wallet-sdk/ledger/v8';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import {ProtocolVersion, WalletTransaction} from '@midnightntwrk/wallet-sdk';
import * as Rx from 'rxjs';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import {
  forks,
  isLedgerV9,
  protocolStatus,
  transactionFromBytes,
  transactionHashOf,
  unshieldedPublicKeyAt,
  unwrapTransaction,
} from '../../../src/sync/ledger-routing.js';

const OWNER = 'be5eb2579464f606ed883d18831617302f484e6ce3602b0e2725801b653cd19d';
const V8 = ProtocolVersion.MinSupportedVersion;
const V9 = forks.v9;
const BELOW_FORK = ProtocolVersion.ProtocolVersion(forks.v9 - 1n);

// The fixtures carry no contract calls, so proving only advances the stage marker.
const noProofs = {
  async check(): Promise<never> {
    throw new Error('unexpected proof check');
  },
  async prove(): Promise<never> {
    throw new Error('unexpected proving');
  },
};

async function v8UnboundBytes(): Promise<Uint8Array> {
  const intent = ledgerV8.Intent.new(new Date(Date.now() + 60_000));
  intent.fallibleUnshieldedOffer = ledgerV8.UnshieldedOffer.new(
    [],
    [{owner: OWNER, type: ledgerV8.nativeToken().raw, value: 1n}],
    [],
  );
  const unproven = ledgerV8.Transaction.fromParts('preprod', undefined, undefined, intent);
  return (await unproven.prove(noProofs, ledgerV8.CostModel.initialCostModel())).serialize();
}

async function v9UnboundBytes(): Promise<Uint8Array> {
  const intent = ledgerV9.Intent.new(new Date(Date.now() + 60_000));
  intent.fallibleUnshieldedOffer = ledgerV9.UnshieldedOffer.new(
    [],
    [{owner: OWNER, type: ledgerV9.nativeToken().raw, value: 1n}],
    [],
  );
  const unproven = ledgerV9.Transaction.fromParts('preprod', undefined, undefined, intent);
  const provider = {...noProofs, lookupKey: async () => undefined};
  return (await unproven.prove(provider, ledgerV9.CostModel.initialCostModel())).serialize();
}

describe('isLedgerV9', () => {
  it('splits the version line at the fork the facade presets', () => {
    expect(isLedgerV9(V8)).toBe(false);
    expect(isLedgerV9(BELOW_FORK)).toBe(false);
    expect(isLedgerV9(V9)).toBe(true);
  });
});

describe('transactionFromBytes', () => {
  it('reads ledger-v8 bytes below the fork and seals them at that version', async () => {
    const handle = transactionFromBytes(await v8UnboundBytes(), 'Unbound', BELOW_FORK);
    expect(handle.stage).toBe('Unbound');
    expect(handle.protocolVersion).toBe(BELOW_FORK);
    expect(WalletTransaction.is(handle)).toBe(true);
    expect(unwrapTransaction<ledgerV8.Transaction<never, never, never>>(handle)).toBeInstanceOf(ledgerV8.Transaction);
  });

  it('reads ledger-v9 bytes from the fork on', async () => {
    const handle = transactionFromBytes(await v9UnboundBytes(), 'Unbound', V9);
    expect(unwrapTransaction<ledgerV9.Transaction<never, never, never>>(handle)).toBeInstanceOf(ledgerV9.Transaction);
  });

  it('refuses bytes from the other side of the fork instead of misreading them', async () => {
    const v8Bytes = await v8UnboundBytes();
    const v9Bytes = await v9UnboundBytes();
    expect(() => transactionFromBytes(v8Bytes, 'Unbound', V9)).toThrow();
    expect(() => transactionFromBytes(v9Bytes, 'Unbound', BELOW_FORK)).toThrow();
  });

  it('round-trips: the handle serializes to the bytes it was read from', async () => {
    const bytes = await v9UnboundBytes();
    expect(Array.from(transactionFromBytes(bytes, 'Unbound', V9).serialize())).toEqual(Array.from(bytes));
  });
});

describe('transactionHashOf', () => {
  // A hash exists only once a transaction is bound; binding the unbound fixtures
  // is what the facade's finalize step does before it hands a handle back.
  async function finalizedV8(): Promise<Uint8Array> {
    return ledgerV8.Transaction.deserialize('signature', 'proof', 'pre-binding', await v8UnboundBytes())
      .bind()
      .serialize();
  }
  async function finalizedV9(): Promise<Uint8Array> {
    return ledgerV9.Transaction.deserialize('signature', 'proof', 'pre-binding', await v9UnboundBytes())
      .bind()
      .serialize();
  }

  it('reports the carried transaction hash, whichever ledger authored it', async () => {
    const v8 = transactionFromBytes(await finalizedV8(), 'Finalized', V8);
    const v9 = transactionFromBytes(await finalizedV9(), 'Finalized', V9);
    expect(transactionHashOf(v8)).toMatch(/^[0-9a-f]{64}$/);
    expect(transactionHashOf(v9)).toMatch(/^[0-9a-f]{64}$/);
    expect(transactionHashOf(v8)).not.toBe(transactionHashOf(v9));
  });
});

describe('unshieldedPublicKeyAt', () => {
  const secret = new Uint8Array(32).fill(7);

  it('encodes the key the way the variant that reads the snapshot expects', () => {
    const below = unshieldedPublicKeyAt(BELOW_FORK, secret, 'devnet');
    const from = unshieldedPublicKeyAt(V9, secret, 'devnet');
    // Below the fork a bare hex string; from it, ledger-v9's tagged object.
    expect(typeof below.publicKey).toBe('string');
    expect(from.publicKey).toEqual({tag: 'schnorr', value: below.publicKey});
    // Same identity either side, which is what lets one wallet cross.
    expect(from.address).toBe(below.address);
    expect(from.addressHex).toBe(below.addressHex);
  });
});

describe('protocolStatus', () => {
  // Only the members protocolStatus reads; the facade's own state class needs three live wallets.
  const facadeAt = (state: {
    activeProtocolVersion: ProtocolVersion.ProtocolVersion;
    protocol: {_tag: 'Settled'; version: ProtocolVersion.ProtocolVersion} | {_tag: 'Crossing'; from: ProtocolVersion.ProtocolVersion; to: ProtocolVersion.ProtocolVersion; behind: readonly ('shielded' | 'unshielded' | 'dust')[]};
    protocolVersion: {shielded: ProtocolVersion.ProtocolVersion; unshielded: ProtocolVersion.ProtocolVersion; dust: ProtocolVersion.ProtocolVersion};
  }): WalletFacade => ({state: () => Rx.of(state)}) as unknown as WalletFacade;

  it('reports a settled wallet at the ledger its version implies', async () => {
    const status = await protocolStatus(
      facadeAt({
        activeProtocolVersion: V9,
        protocol: {_tag: 'Settled', version: V9},
        protocolVersion: {shielded: V9, unshielded: V9, dust: V9},
      }),
    );
    expect(status).toEqual({
      version: V9,
      ledger: 'v9',
      phase: {kind: 'settled'},
      wallets: {shielded: V9, unshielded: V9, dust: V9},
    });
  });

  it('reports a crossing by the version being left, the one ahead, and who is behind', async () => {
    const status = await protocolStatus(
      facadeAt({
        activeProtocolVersion: BELOW_FORK,
        protocol: {_tag: 'Crossing', from: BELOW_FORK, to: V9, behind: ['shielded', 'dust']},
        protocolVersion: {shielded: BELOW_FORK, unshielded: V9, dust: BELOW_FORK},
      }),
    );
    expect(status.ledger).toBe('v8');
    expect(status.phase).toEqual({kind: 'crossing', from: BELOW_FORK, to: V9, behind: ['shielded', 'dust']});
  });
});

// Reading version-less bytes into a handle is the facade's job (adoptTransaction).
// These pin that the routing follows the fork schedule, that a handle yields
// what the activity feed needs, and that a pre-seeded snapshot gets the key
// shape of the variant that will read it.

import {describe, expect, it} from 'vitest';
import {ProtocolVersion, WalletTransaction} from '@midnightntwrk/wallet-sdk';
import * as Rx from 'rxjs';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';
import {finalizedTransaction, unboundTransaction} from '../../helpers/ledger-transactions.js';
import {
  forks,
  isLedgerV9,
  ledgerReading,
  protocolStatus,
  transactionHashOf,
  unshieldedPublicKeyAt,
} from '../../../src/sync/ledger-routing.js';

const V8 = ProtocolVersion.MinSupportedVersion;
const V9 = forks.v9;
const BELOW_FORK = ProtocolVersion.ProtocolVersion(forks.v9 - 1n);

describe('isLedgerV9', () => {
  it('splits the version line at the fork the facade presets', () => {
    expect(isLedgerV9(V8)).toBe(false);
    expect(isLedgerV9(BELOW_FORK)).toBe(false);
    expect(isLedgerV9(V9)).toBe(true);
  });
});

describe('ledgerReading', () => {
  it('names the ledger that wrote the bytes', async () => {
    expect(ledgerReading((await finalizedTransaction('v8')).serialize(), 'Finalized')).toBe('v8');
    expect(ledgerReading((await finalizedTransaction('v9')).serialize(), 'Finalized')).toBe('v9');
  });

  it('answers undefined for bytes neither ledger reads at that stage', async () => {
    expect(ledgerReading(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]), 'Finalized')).toBeUndefined();
    expect(ledgerReading((await unboundTransaction('v9')).serialize(), 'Finalized')).toBeUndefined();
  });
});

describe('transactionHashOf', () => {
  it('reports the carried transaction hash, whichever ledger authored it', async () => {
    const v8 = WalletTransaction.adopt('Finalized', await finalizedTransaction('v8'), V8);
    const v9 = WalletTransaction.adopt('Finalized', await finalizedTransaction('v9'), V9);
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

/**
 * Cached unshielded state embeds the public key it was watching, and that key
 * depends on the signature kind. An ECDSA wallet must not restore state cached
 * under schnorr: it would keep watching the schnorr address, report "Synced",
 * and show a zero balance while its funds sit at the address it displayed.
 *
 * Schnorr keeps the original key so no existing wallet is forced to resync.
 */

import {describe, expect, it} from 'vitest';
import {syncStateKey} from '../../../src/sync/sync-store.js';

// Mirrors cacheIdentity in wallet-sync.ts; that function is module-private, so
// this pins the contract it implements rather than the function itself.
const identity = (name: string, part: string, kind: string) =>
  part === 'unshielded' && kind === 'ecdsa' ? `${name}#ecdsa` : name;

const keyFor = (name: string, part: 'shielded' | 'unshielded' | 'dust', kind: 'schnorr' | 'ecdsa') =>
  syncStateKey('devnet', identity(name, part, kind), part);

describe('sync cache identity', () => {
  it('keeps the original key for schnorr, so existing wallets do not resync', () => {
    expect(keyFor('w', 'unshielded', 'schnorr')).toBe(syncStateKey('devnet', 'w', 'unshielded'));
  });

  it('separates ECDSA unshielded state from schnorr', () => {
    expect(keyFor('w', 'unshielded', 'ecdsa')).not.toBe(keyFor('w', 'unshielded', 'schnorr'));
  });

  it('leaves shielded and DUST keys alone — neither depends on the kind', () => {
    for (const part of ['shielded', 'dust'] as const) {
      expect(keyFor('w', part, 'ecdsa')).toBe(keyFor('w', part, 'schnorr'));
    }
  });

  it('keeps different wallets apart regardless of kind', () => {
    expect(keyFor('a', 'unshielded', 'ecdsa')).not.toBe(keyFor('b', 'unshielded', 'ecdsa'));
  });
});

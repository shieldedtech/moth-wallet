/**
 * Signature kind is a creation-time property of a wallet. It must survive a
 * lock/unlock cycle, default to schnorr for records that predate it, and never
 * be rewritten — DustRegistration binds the tagged night key, so a change would
 * strand NIGHT and stop DUST generation until re-registered.
 */

import {describe, expect, it, beforeAll} from 'vitest';
import {WalletManager} from '../../../src/wallet/manager.js';
import {MemoryStorage} from '../../helpers/memory-storage.js';
import {initSdk} from '../../../src/sdk/index.js';

beforeAll(async () => {
  await initSdk('v9');
});

const PASS = 'correct horse battery staple';

describe('persisted signature kind', () => {
  it('defaults to schnorr and records nothing extra', async () => {
    const storage = new MemoryStorage();
    const wallets = new WalletManager(storage);
    const made = await wallets.generate('plain', PASS, 'stagenet');
    expect(made.signatureKind).toBeUndefined();

    const listed = (await wallets.list()).find((w) => w.name === 'plain');
    expect(listed?.signatureKind).toBeUndefined();
  });

  it('remembers an ECDSA wallet across a lock/unlock cycle', async () => {
    const storage = new MemoryStorage();
    const wallets = new WalletManager(storage);
    await wallets.generate('hardware', PASS, 'stagenet', undefined, undefined, 'ecdsa');

    const listed = (await wallets.list()).find((w) => w.name === 'hardware');
    expect(listed?.signatureKind).toBe('ecdsa');

    const unlocked = await wallets.unlock('hardware', PASS);
    expect(unlocked.addresses.nightExternal.bech32m.stagenet).toMatch(/^mn_addr/);
  });

  it('unlocks an ECDSA wallet to its ECDSA address, not the schnorr one', async () => {
    const storage = new MemoryStorage();
    const wallets = new WalletManager(storage);
    const phrase = (await wallets.generate('ec', PASS, 'stagenet', undefined, undefined, 'ecdsa')).mnemonic;

    // The same seed as a schnorr wallet, for comparison.
    const other = new WalletManager(new MemoryStorage());
    await other.import('sch', phrase, PASS, 'stagenet');

    const ec = await wallets.unlock('ec', PASS);
    const sch = await other.unlock('sch', PASS);
    expect(ec.addresses.nightExternal.bech32m.stagenet)
      .not.toBe(sch.addresses.nightExternal.bech32m.stagenet);
    // …but the shielded identity is shared, which is what makes a kind
    // switch strand only NIGHT.
    expect(ec.addresses.zswap.bech32m.stagenet).toBe(sch.addresses.zswap.bech32m.stagenet);
  });
});

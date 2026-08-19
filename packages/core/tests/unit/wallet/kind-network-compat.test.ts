/**
 * An ECDSA wallet has no unshielded identity on a ledger v8 network, so it
 * cannot be used there at all. Refusing at unlock names the cause at the moment
 * the network was chosen; without it the failure surfaces deep inside sync,
 * where it reads as a generic "sync failed" and the user is left guessing.
 */

import {describe, expect, it, beforeAll} from 'vitest';
import {WalletManager} from '../../../src/wallet/manager.js';
import {MemoryStorage} from '../../helpers/memory-storage.js';
import {initSdk} from '../../../src/sdk/index.js';

const PASS = 'correct horse battery staple';

beforeAll(async () => {
  await initSdk('v9');
});

async function walletOn(network: string, kind: 'schnorr' | 'ecdsa') {
  const wallets = new WalletManager(new MemoryStorage());
  await wallets.generate('w', PASS, network, undefined, undefined, kind);
  return wallets;
}

describe('signature kind and network compatibility', () => {
  it('opens an ECDSA wallet on a v9 network', async () => {
    const wallets = await walletOn('devnet', 'ecdsa');
    await expect(wallets.unlock('w', PASS)).resolves.toBeDefined();
  });

  it('refuses to open an ECDSA wallet on a v8 network, naming where it works', async () => {
    const wallets = await walletOn('devnet', 'ecdsa');
    // Creation on a v8 network is already refused, so reach the state the user
    // reached: an existing ECDSA wallet moved onto preprod.
    await wallets.setNetwork('w', 'preprod');
    await expect(wallets.unlock('w', PASS)).rejects.toThrow(/ECDSA/);
    await expect(wallets.unlock('w', PASS)).rejects.toThrow(/devnet|stagenet/);
  });

  it('opens a schnorr wallet on any network', async () => {
    for (const network of ['preprod', 'devnet']) {
      const wallets = await walletOn(network, 'schnorr');
      await expect(wallets.unlock('w', PASS)).resolves.toBeDefined();
    }
  });
});

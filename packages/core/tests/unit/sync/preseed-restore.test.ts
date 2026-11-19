// A pre-seeded snapshot is assembled field by field from the reference wallet's,
// so it carries none of the envelope the SDK writes itself (format `version`,
// `writtenBy`). These run the real wallets on both ends: the SDK writes the
// reference, moth swaps the keys, and the SDK must restore the result as the new
// wallet. A format change that orphans pre-seeded snapshots fails here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WalletFacade, type DefaultConfiguration } from '@midnightntwrk/wallet-sdk/facade';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded';
import { DustWallet } from '@midnightntwrk/wallet-sdk/dust';
import { UnshieldedWallet, PublicKey, createKeystore } from '@midnightntwrk/wallet-sdk/unshielded';
import { deriveWalletKeys, type WalletKeys } from '../../../src/sync/operations.js';
import { preSeedNewWallet } from '../../../src/sync/preseed.js';
import { testSeedHex } from '../../helpers/seed.js';

const NETWORK = 'preprod';
// Wallets only connect once started; nothing here starts one.
const config = WalletFacade.resolveConfiguration<DefaultConfiguration>({
  networkId: NETWORK,
  indexerClientConnection: { indexerHttpUrl: 'http://127.0.0.1:9/api', indexerWsUrl: 'ws://127.0.0.1:9/api/ws' },
  relayURL: new URL('ws://127.0.0.1:9'),
  costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 0 },
});

interface Snapshots {
  shielded: string;
  unshielded: string;
  dust: string;
}

const stoppers: Array<() => Promise<void>> = [];

/** A fresh wallet's three snapshots, as the SDK serializes them. */
async function freshSnapshots(keys: WalletKeys): Promise<Snapshots> {
  const shielded = await ShieldedWallet(config).startWithSeed(keys.shielded);
  const unshielded = await UnshieldedWallet(config).startWithPublicKey(
    PublicKey.fromKeyStore(createKeystore({ kind: 'schnorr', secret: keys.unshielded }, NETWORK)),
  );
  const dust = await DustWallet(config).startWithSeed(keys.dust);
  stoppers.push(() => shielded.stop(), () => unshielded.stop(), () => dust.stop());
  return {
    shielded: await shielded.serializeState(),
    unshielded: await unshielded.serializeState(),
    dust: await dust.serializeState(),
  };
}

/** The key fields of a snapshot: what pre-seeding swaps, and so what must come back. */
function keyFields(snapshot: string): unknown {
  const { publicKey, publicKeys } = JSON.parse(snapshot) as { publicKey?: unknown; publicKeys?: unknown };
  return publicKey ?? publicKeys;
}

let reference: Snapshots;
let target: Snapshots;
let preSeeded: { shielded: string; unshielded: string; dust?: string };

beforeAll(async () => {
  const targetKeys = deriveWalletKeys(await testSeedHex());
  reference = await freshSnapshots(deriveWalletKeys('01'.repeat(64)));
  target = await freshSnapshots(targetKeys);
  const seeded = preSeedNewWallet(targetKeys, NETWORK, reference);
  if (!seeded) throw new Error('pre-seeding refused the reference');
  preSeeded = seeded;
});

afterAll(async () => {
  await Promise.allSettled(stoppers.map((stop) => stop()));
});

describe('a pre-seeded snapshot restores in the SDK', () => {
  it.each(['shielded', 'unshielded', 'dust'] as const)('%s comes back as the new wallet', async (part) => {
    const snapshot = preSeeded[part];
    expect(snapshot).toBeDefined();
    const wallet =
      part === 'shielded'
        ? ShieldedWallet(config).restore(snapshot!)
        : part === 'unshielded'
          ? UnshieldedWallet(config).restore(snapshot!)
          : DustWallet(config).restore(snapshot!);
    stoppers.push(() => wallet.stop());

    const restored = await wallet.serializeState();
    expect(keyFields(restored)).toEqual(keyFields(target[part]));
    expect(keyFields(restored)).not.toEqual(keyFields(reference[part]));
  });
});

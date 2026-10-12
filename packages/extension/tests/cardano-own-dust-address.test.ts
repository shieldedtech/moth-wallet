import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

const cardanoResolveReceiver = vi.fn<(d: { input: string }) => Promise<{ dustAddressBytes: string }>>();
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    cardanoResolveReceiver: (...args: unknown[]) =>
      cardanoResolveReceiver(...(args as [{ input: string }])),
  },
}));
vi.mock('../lib/background/sync-service', () => ({
  stopSync: vi.fn(),
  clearSnapshot: vi.fn(),
  startSync: vi.fn(),
  getSnapshot: vi.fn(),
  beginOp: vi.fn(),
  endOp: vi.fn(),
  hasOpenPorts: vi.fn(() => true),
  hasWorkInFlight: vi.fn(() => false),
  broadcastSessionLocked: vi.fn(),
  getSetupTabIds: vi.fn(() => []),
  teardown: vi.fn(),
}));

import { ownDustAddressBytes } from '../lib/background/handlers';
import type { Session } from '../lib/background/session';

const DUST_BECH32 =
  'mn_dust_preprod1wwxhaf472uhxnltad72rmph52gdpef7a7ytq78vneqs2secjdyjzyh4t0ey';
/** The 32-byte payload, i.e. serialize() without its 0x73 type tag. */
const DUST_BYTES = '8d7ea6be572e69fd7d6f943d86f4521a1ca7ddf1160f1d93c820a86712692422';
/** Same length, different key — what this used to compare against. */
const COIN_PUBLIC_KEY = 'ae6b465d766ce0a13265ef00859bddd523c9d858523b687903a60bcebd95a7a7';

function sessionWith(dust: Record<string, string> | undefined): Session {
  return {
    walletName: 'alice',
    seedHex: 'ab'.repeat(32),
    address: 'addr',
    addresses: { dust: dust ? { bech32m: dust } : undefined } as unknown as Session['addresses'],
    shieldedCoinPublicKey: COIN_PUBLIC_KEY,
    shieldedEncryptionPublicKey: 'e0'.repeat(16),
    network: 'preprod',
    unlockedAt: 1,
  } as Session;
}

describe('ownDustAddressBytes', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    cardanoResolveReceiver.mockReset().mockResolvedValue({ dustAddressBytes: DUST_BYTES });
  });

  it("resolves this wallet's DUST address, not its shielded coin public key", async () => {
    // The regression this pins. Both values are 32 bytes and both look like a
    // plausible receiver, so comparing the wrong one fails silently: every
    // registration the wallet made for itself read as "registered to another
    // wallet". Asserting the resolved INPUT is what catches it — asserting the
    // output would pass either way.
    const session = sessionWith({ preprod: DUST_BECH32 });
    await expect(ownDustAddressBytes(session)).resolves.toBe(DUST_BYTES);
    expect(cardanoResolveReceiver).toHaveBeenCalledWith({ input: DUST_BECH32 });
    expect(cardanoResolveReceiver).not.toHaveBeenCalledWith({ input: COIN_PUBLIC_KEY });
  });

  it('picks the address for the session network, not some other network', async () => {
    const session = sessionWith({ preview: 'mn_dust_preview1whatever', preprod: DUST_BECH32 });
    await ownDustAddressBytes(session);
    expect(cardanoResolveReceiver).toHaveBeenCalledWith({ input: DUST_BECH32 });
  });

  it('is empty when the wallet has no DUST address on this network', async () => {
    // A wallet that cannot be paid cannot own the registration. Empty says so;
    // a guess here would claim someone else's registration as this wallet's.
    await expect(ownDustAddressBytes(sessionWith({ preview: 'mn_dust_preview1x' }))).resolves.toBe('');
    await expect(ownDustAddressBytes(sessionWith(undefined))).resolves.toBe('');
    expect(cardanoResolveReceiver).not.toHaveBeenCalled();
  });

  it('is empty when resolution fails rather than throwing', async () => {
    // cardanoStatus must still render; an unreadable address is "not ours".
    cardanoResolveReceiver.mockRejectedValue(new Error('offscreen gone'));
    await expect(ownDustAddressBytes(sessionWith({ preprod: DUST_BECH32 }))).resolves.toBe('');
  });
});

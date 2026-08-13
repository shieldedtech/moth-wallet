import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { saveSession, getSession, clearSession, type Session } from '../lib/background/session';

const SESSION: Session = {
  walletName: 'alice',
  seedHex: 'ab'.repeat(32),
  address: 'mn_addr_test1...',
  addresses: {} as Session['addresses'],
  shieldedCoinPublicKey: 'c0'.repeat(16),
  shieldedEncryptionPublicKey: 'e0'.repeat(16),
  network: 'devnet',
  unlockedAt: 1_751_800_000_000,
};

describe('session lifecycle', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('starts locked', async () => {
    expect(await getSession()).toBeNull();
  });

  it('stores the session', async () => {
    await saveSession(SESSION);

    const session = await getSession();
    expect(session?.walletName).toBe('alice');
    expect(session?.seedHex).toBe(SESSION.seedHex);
  });

  it('clearSession wipes the seed', async () => {
    await saveSession(SESSION);
    await clearSession();

    expect(await getSession()).toBeNull();
  });
});

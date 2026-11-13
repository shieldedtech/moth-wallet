import { describe, expect, it } from 'vitest';
import {
  BlockfrostKeyMissingError,
  CardanoKeysUnavailableError,
  deriveCardanoAddresses,
  withCardanoSession,
} from '../../../src/cardano/session.js';
import { resolveCardanoNetwork } from '../../../src/cardano/network.js';

// A published BIP-39 test vector, not a wallet anyone funds.
const MNEMONIC =
  'test test test test test test test test test test test test test test test test test test test test test test test sauce';

describe('deriveCardanoAddresses', () => {
  it('derives the CIP-1852 account-0 base address', async () => {
    // Pinned so a change of account index, address type or derivation path is
    // loud. Moving any of them silently re-points DUST generation at a stake
    // key that holds no cNIGHT.
    const addresses = await deriveCardanoAddresses(MNEMONIC, resolveCardanoNetwork('preview'));
    expect(addresses.address).toBe(
      'addr_test1qryvgass5dsrf2kxl3vgfz76uhp83kv5lagzcp29tcana68ca5aqa6swlq6llfamln09tal7n5kvt4275ckwedpt4v7q48uhex',
    );
    expect(addresses.rewardAddress).toBe(
      'stake_test1uruw6wswag80sd0l57alehj47llf6tx96402vt8vks46k0q0e2ne6',
    );
    expect(addresses.stakeKeyHash).toBe('f8ed3a0eea0ef835ffa7bbfcde55f7fe9d2cc5d55ea62cecb42bab3c');
    expect(addresses.paymentKeyHash).toBe('c8c47610a36034aac6fc58848bdae5c278d994ff502c05455e3b3ee8');
  });

  it('keeps the key hashes across networks and changes only the encoding', async () => {
    // The same account on mainnet is the same keys — only the bech32 prefix
    // and network id differ. A mismatch here would mean the network is leaking
    // into derivation.
    const preview = await deriveCardanoAddresses(MNEMONIC, resolveCardanoNetwork('preview'));
    const mainnet = await deriveCardanoAddresses(MNEMONIC, resolveCardanoNetwork('mainnet'));
    expect(mainnet.stakeKeyHash).toBe(preview.stakeKeyHash);
    expect(mainnet.paymentKeyHash).toBe(preview.paymentKeyHash);
    expect(mainnet.address).toMatch(/^addr1/);
    expect(mainnet.rewardAddress).toMatch(/^stake1/);
  });

  it('always produces a base address, so a registration always has a stake key', async () => {
    const addresses = await deriveCardanoAddresses(MNEMONIC, resolveCardanoNetwork('preprod'));
    expect(addresses.stakeKeyHash).toHaveLength(56);
    expect(addresses.paymentKeyHash).toHaveLength(56);
  });

  it('needs no Blockfrost project id — derivation is pure', async () => {
    const config = resolveCardanoNetwork('preview');
    expect(config.blockfrostProjectId).toBeUndefined();
    await expect(deriveCardanoAddresses(MNEMONIC, config)).resolves.toBeDefined();
  });
});

describe('withCardanoSession', () => {
  it('refuses before touching the network when there is no project id', async () => {
    // Checked ahead of any HTTP so the failure names the missing setting
    // instead of surfacing as a 403 from Blockfrost.
    await expect(
      withCardanoSession(MNEMONIC, resolveCardanoNetwork('preview'), async () => 'unreachable'),
    ).rejects.toBeInstanceOf(BlockfrostKeyMissingError);
  });
});

describe('CardanoKeysUnavailableError', () => {
  it('says which wallet and why, since the answer is never "try again"', () => {
    const err = new CardanoKeysUnavailableError('hexonly');
    expect(err.message).toContain('hexonly');
    expect(err.message).toContain('hex seed');
    expect(err.category).toBe('WALLET_ERROR');
  });
});

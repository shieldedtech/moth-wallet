import { describe, it, expect } from 'vitest';
import { replaceAuthority } from '../../../src/contract/maintenance.js';
import type { NetworkConfig } from '../../../src/types/network.js';

// The refusals below all happen before anything is signed, proved, or
// submitted. That is the point of testing them: a committee installed with the
// wrong shape is a superuser handed to the wrong party, and finding out on
// chain costs fees and leaves the contract in the state you were trying to
// leave. Reaching the network at all would mean a guard did not fire.
const NEVER_REACHED = {
  keys: {} as never,
  network: {id: 'preprod', indexerUrl: 'http://127.0.0.1:1'} as unknown as NetworkConfig,
  artifactPath: '/nonexistent/managed/Contract',
  syncedWallet: {facade: {}} as never,
  walletKeys: {} as never,
};

const VK = (n: number) => `vk-${n}`.padEnd(20, '0');

describe('replaceAuthority input guards', () => {
  it('refuses a threshold above the committee size, and names it as renounce', async () => {
    await expect(replaceAuthority({
      ...NEVER_REACHED, contractAddress: '0abc', committee: [VK(1), VK(2)], threshold: 3,
    })).rejects.toThrow(/renounce/i);
  });

  it('refuses a duplicate committee key, which inflates a threshold without a custodian', async () => {
    await expect(replaceAuthority({
      ...NEVER_REACHED, contractAddress: '0abc', committee: [VK(1), VK(1), VK(2)], threshold: 2,
    })).rejects.toThrow(/duplicate/i);
  });

  it('refuses an empty committee unless renounce was asked for explicitly', async () => {
    await expect(replaceAuthority({
      ...NEVER_REACHED, contractAddress: '0abc', committee: [], threshold: 1,
    })).rejects.toThrow(/no committee given/i);
  });

  it('refuses a renounce that also carries a committee', async () => {
    await expect(replaceAuthority({
      ...NEVER_REACHED, contractAddress: '0abc', committee: [VK(1)], threshold: 1, renounce: true,
    })).rejects.toThrow(/do not also pass a committee/i);
  });

  it('refuses a threshold below one', async () => {
    await expect(replaceAuthority({
      ...NEVER_REACHED, contractAddress: '0abc', committee: [VK(1)], threshold: 0,
    })).rejects.toThrow(/at least 1/i);
  });

  it('requires an address and an artifact before anything else', async () => {
    await expect(replaceAuthority({
      ...NEVER_REACHED, artifactPath: '', contractAddress: '0abc', committee: [VK(1)], threshold: 1,
    })).rejects.toThrow(/artifact/i);
    await expect(replaceAuthority({
      ...NEVER_REACHED, contractAddress: '', committee: [VK(1)], threshold: 1,
    })).rejects.toThrow(/address/i);
  });

  it('requires a synced wallet, since an update has to be balanced and submitted', async () => {
    await expect(replaceAuthority({
      ...NEVER_REACHED, syncedWallet: undefined, contractAddress: '0abc',
      committee: [VK(1)], threshold: 1,
    })).rejects.toThrow(/synced/i);
  });
});

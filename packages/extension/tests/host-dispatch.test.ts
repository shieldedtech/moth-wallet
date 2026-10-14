import { describe, expect, it, vi } from 'vitest';
import { hostDispatch } from '../lib/offscreen/host-dispatch';

type Host = Parameters<(typeof hostDispatch)['os/walletSetNetwork']>[0];

describe('hostDispatch', () => {
  // The background reads the destination's chain tip and sends it as `birthday`.
  // The host parameter is optional and positional, so dropping it here type-checked.
  it('forwards birthday on os/walletSetNetwork', async () => {
    const walletSetNetwork = vi.fn().mockResolvedValue({ address: 'a', addresses: {} });
    const host = { walletSetNetwork } as unknown as Host;

    await hostDispatch['os/walletSetNetwork'](host, {
      name: 'w',
      fromNetwork: 'preview',
      network: 'preprod',
      seedHex: 'ab',
      birthday: 123,
    });

    expect(walletSetNetwork).toHaveBeenCalledWith('w', 'preview', 'preprod', 'ab', 123);
  });
});

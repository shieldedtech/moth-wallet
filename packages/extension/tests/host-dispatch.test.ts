import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PROVER_KEY_NOT_HELD } from '../lib/connector/constants';
import { encodeBigintJson } from '../lib/messaging/bigint-json';
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

  // The page sends a contract's prover key once; later proofs name it by hash.
  it('proves with a prover key the page sent earlier, by its hash', async () => {
    const provingProviderProve = vi.fn().mockResolvedValue(new Uint8Array([9]));
    const host = { provingProviderProve } as unknown as Host;
    const network = { id: 'undeployed', nodeUrl: 'ws://n', indexerUrl: 'http://i', prover: { type: 'wasm' as const } };
    const proverKey = new Uint8Array([5, 5, 5]);
    const sha256 = createHash('sha256').update(proverKey).digest('hex');
    const origin = 'https://dapp.example';
    const prove = () =>
      hostDispatch['os/provingProviderProve'](host, {
        network,
        payloadJson: encodeBigintJson({
          origin,
          serializedPreimage: new Uint8Array([1]),
          keyLocation: 'counter.increment',
          keyMaterial: { zkir: new Uint8Array([4]), verifierKey: new Uint8Array([6]), proverKeySha256: sha256 },
        }),
      });

    await expect(prove()).rejects.toThrow(PROVER_KEY_NOT_HELD);
    await expect(
      hostDispatch['os/proverKeyPut'](host, {
        payloadJson: encodeBigintJson({ origin, sha256, uploadId: 'u', index: 0, count: 1, chunk: proverKey }),
      }),
    ).resolves.toBe(true);
    await prove();

    expect(provingProviderProve).toHaveBeenCalledTimes(1);
    expect(provingProviderProve.mock.calls[0]![3]).toEqual({
      zkir: new Uint8Array([4]),
      verifierKey: new Uint8Array([6]),
      proverKey,
    });
  });
});

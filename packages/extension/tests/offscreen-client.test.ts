import { describe, it, expect, beforeEach, vi } from 'vitest';

// The offscreen channel is mocked so we can drive the SW-side lifecycle logic
// (document creation + readiness ping + op forwarding) without a real document.
const offscreenSend = vi.fn();
vi.mock('../lib/offscreen/messaging', () => ({ offscreenSend: (...args: unknown[]) => offscreenSend(...args) }));

const hasDocument = vi.fn<() => Promise<boolean>>();
const createDocument = vi.fn<(opts: { url: string; reasons: string[]; justification: string }) => Promise<void>>();
const closeDocument = vi.fn<() => Promise<void>>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  offscreen: { hasDocument, createDocument, closeDocument, Reason: { WORKERS: 'WORKERS' } },
};

import { ensureOffscreen, offscreen } from '../lib/background/offscreen-client';

describe('offscreen client', () => {
  // Stateful document presence by default: create/close flip it, hasDocument
  // reflects it. The lifecycle queue serializes ensures rather than sharing one
  // creation promise, so concurrent ensures must see the doc appear after the
  // first create. Tests that need a fixed answer still override hasDocument.
  let docExists: boolean;
  beforeEach(() => {
    docExists = false;
    offscreenSend.mockReset().mockResolvedValue(true);
    hasDocument.mockReset().mockImplementation(async () => docExists);
    createDocument.mockReset().mockImplementation(async () => {
      docExists = true;
    });
    closeDocument.mockReset().mockImplementation(async () => {
      docExists = false;
    });
  });

  it('creates the document once when none exists, then waits for the ready ping', async () => {
    await ensureOffscreen();

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument.mock.calls[0]![0]).toMatchObject({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
    });
    expect(offscreenSend).toHaveBeenCalledWith('os/ping', undefined);
  });

  it('does not create a second document when one already exists', async () => {
    hasDocument.mockResolvedValue(true);
    await ensureOffscreen();
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('creates the document only once for concurrent callers', async () => {
    await Promise.all([ensureOffscreen(), ensureOffscreen(), ensureOffscreen()]);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('retries the readiness ping until the offscreen answers', async () => {
    offscreenSend
      .mockRejectedValueOnce(new Error('no receiver'))
      .mockRejectedValueOnce(new Error('no receiver'))
      .mockResolvedValue(true);

    await ensureOffscreen();

    const pings = offscreenSend.mock.calls.filter(([key]) => key === 'os/ping');
    expect(pings.length).toBeGreaterThanOrEqual(3);
  });

  it('forwards an op to the offscreen with its args and returns the result', async () => {
    hasDocument.mockResolvedValue(true);
    offscreenSend.mockImplementation(async (key: string) => (key === 'os/ping' ? true : ['wallet-a']));

    const result = await offscreen.walletList('devnet');

    expect(offscreenSend).toHaveBeenCalledWith('os/walletList', { network: 'devnet' });
    expect(result).toEqual(['wallet-a']);
  });

  it('forwards transfer fee estimation without changing its raw amount', async () => {
    hasDocument.mockResolvedValue(true);
    offscreenSend.mockImplementation(async (key: string) =>
      key === 'os/estimateTransferFee' ? { fee: '125000000000000' } : true,
    );
    const data = {
      seedHex: 'ab'.repeat(32),
      walletName: 'Account-1',
      network: {
        id: 'preprod',
        nodeUrl: 'wss://node.example',
        indexerUrl: 'https://indexer.example',
        proofServerUrl: 'http://localhost:6300',
      },
      requests: [
        {
          type: 'unshielded' as const,
          tokenId: '0'.repeat(64),
          amount: '1000000',
          to: `mn_addr_preprod1${'a'.repeat(30)}`,
        },
      ],
    };

    await expect(offscreen.estimateTransferFee(data)).resolves.toEqual({
      fee: '125000000000000',
    });
    expect(offscreenSend).toHaveBeenCalledWith('os/estimateTransferFee', data);
  });

  it('serializes binary and bigint proving data across the Chrome runtime hop', async () => {
    hasDocument.mockResolvedValue(true);
    const checkResult = [7n, undefined, 9n];
    const proofResult = new Uint8Array([10, 11]);
    offscreenSend.mockImplementation(async (key: string) => {
      if (key === 'os/provingProviderCheck') {
        return JSON.stringify(checkResult, (_k, value) =>
          value === undefined
            ? {__t: 'undefined'}
            : typeof value === 'bigint'
              ? {__t: 'bigint', v: value.toString()}
              : value,
        );
      }
      if (key === 'os/provingProviderProve') {
        return JSON.stringify({__t: 'bytes', v: btoa(String.fromCharCode(...proofResult))});
      }
      return true;
    });
    const data = {
      network: {
        id: 'devnet',
        nodeUrl: 'https://node.example',
        indexerUrl: 'https://indexer.example',
        prover: {type: 'wasm' as const},
      },
      serializedPreimage: new Uint8Array([1, 2, 3]),
      keyLocation: 'counter.increment',
      keyMaterial: {
        zkir: new Uint8Array([4]),
        proverKey: new Uint8Array([5]),
        verifierKey: new Uint8Array([6]),
      },
    };

    await expect(offscreen.provingProviderCheck(data)).resolves.toEqual(checkResult);
    await expect(offscreen.provingProviderProve({...data, overwriteBindingInput: 42n})).resolves.toEqual(proofResult);

    for (const [method, wire] of offscreenSend.mock.calls.filter(([key]) => String(key).startsWith('os/proving'))) {
      expect(method).toMatch(/^os\/provingProvider/);
      expect(wire).toEqual(expect.objectContaining({network: data.network, payloadJson: expect.any(String)}));
      expect(wire.payloadJson).toContain('"__t":"bytes"');
      expect(() => JSON.stringify(wire)).not.toThrow();
    }
    const proveWire = offscreenSend.mock.calls.find(([key]) => key === 'os/provingProviderProve')![1];
    expect(proveWire.payloadJson).toContain('"__t":"bigint"');
  });

  it('closes the document when one exists', async () => {
    hasDocument.mockResolvedValue(true);
    await offscreen.close();
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  it('does not call closeDocument when none exists', async () => {
    hasDocument.mockResolvedValue(false);
    await offscreen.close();
    expect(closeDocument).not.toHaveBeenCalled();
  });

  it('recreates the document on the next ensureOffscreen after a close', async () => {
    hasDocument
      .mockResolvedValueOnce(true) // close(): a document exists → closeDocument
      .mockResolvedValue(false); // ensureOffscreen(): gone → createDocument again

    await offscreen.close();
    await ensureOffscreen();

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(offscreenSend).toHaveBeenCalledWith('os/ping', undefined);
  });
});

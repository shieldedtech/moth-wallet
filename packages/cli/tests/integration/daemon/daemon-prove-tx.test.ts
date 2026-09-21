// Integration coverage for the `proveTransaction` daemon verb.
//
// The verb has no CLI command — it exists for programmatic clients that need
// to hold a proof and submit it later — so these tests drive it over the
// socket with the core daemon client, the same path such a client uses.
//
// Two tiers:
//   - wire-format rejections, which need a daemon but never touch the chain
//   - a prove -> submit round trip, which is the only way to show the hex the
//     verb hands back is actually submittable. That needs NIGHT and DUST, so
//     it waits for the airdrop and the fee to accrue.
//
// Requires a running devnet, gated on MOTH_DEVNET_URL like its siblings.

import {describe, it, expect, beforeAll, afterAll} from 'vitest';

import {
  connectDaemon,
  DaemonProtocolError,
  type DaemonClient,
} from '@shieldedtech/moth-wallet';
import {
  DEVNET_URL,
  NETWORK,
  startDaemon,
  setupTestWallet,
  cleanupTestWallet,
  waitForSynced,
  waitForDust,
  getReceiveAddress,
  type DaemonHandle,
} from './helpers.js';

const NIGHT_TOKEN_ID = '0'.repeat(64);
const ONE_NIGHT = 1_000_000n; // 10^6 STAR

describe.skipIf(!DEVNET_URL)('moth daemon proveTransaction', () => {
  let wallet: string;
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let destination: string;

  beforeAll(async () => {
    wallet = await setupTestWallet('daemon-prove', NETWORK);
    daemon = await startDaemon(wallet, NETWORK);
    await waitForSynced(wallet, NETWORK);
    const c = await connectDaemon(daemon.socketPath);
    if (!c) throw new Error(`could not connect to daemon at ${daemon.socketPath}`);
    client = c;
    destination = getReceiveAddress(wallet, NETWORK);
  }, 600_000);

  afterAll(async () => {
    client?.close();
    if (daemon) await daemon.stop();
    if (wallet) cleanupTestWallet(wallet);
  }, 60_000);

  const prove = (params: Record<string, unknown>): Promise<unknown> =>
    client.call('proveTransaction', params, {timeoutMs: 300_000});

  const base = (): Record<string, unknown> => ({
    type: 'unshielded',
    tokenId: NIGHT_TOKEN_ID,
    amount: ONE_NIGHT.toString(),
    to: destination,
  });

  // ---- wire format: rejected before anything is built ---------------------

  it('rejects a short token id', async () => {
    await expect(prove({...base(), tokenId: 'abc'})).rejects.toThrow(/64-char hex/);
  });

  it('rejects a zero amount', async () => {
    await expect(prove({...base(), amount: '0'})).rejects.toThrow(/greater than zero/);
  });

  it('rejects a non-decimal amount', async () => {
    await expect(prove({...base(), amount: '1.5'})).rejects.toThrow(/non-negative decimal/);
  });

  it('rejects an unknown transfer type', async () => {
    await expect(prove({...base(), type: 'sideways'})).rejects.toThrow(/shielded.*unshielded/);
  });

  it('rejects an empty destination', async () => {
    await expect(prove({...base(), to: ''})).rejects.toThrow(/non-empty bech32m/);
  });

  it('rejects a non-finite ttl', async () => {
    await expect(prove({...base(), ttlMinutes: 'thirty'})).rejects.toThrow(/finite number/);
  });

  it('reports rejections as INVALID_PARAMS', async () => {
    try {
      await prove({...base(), amount: '0'});
      expect.unreachable('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonProtocolError);
      expect((err as DaemonProtocolError).code).toBe('INVALID_PARAMS');
    }
  });

  // ---- proving: needs NIGHT for the transfer and DUST for the fee ---------

  describe('with a funded wallet', () => {
    beforeAll(async () => {
      await waitForDust(wallet, NETWORK);
    }, 600_000);

    it('returns submittable hex, a ttl and a size', async () => {
      const result = (await prove(base())) as {
        hex: string;
        ttlUnix: number;
        sizeBytes: number;
      };

      expect(result.hex).toMatch(/^[0-9a-f]+$/i);
      expect(result.hex.length % 2).toBe(0);
      expect(result.sizeBytes).toBe(result.hex.length / 2);
      // Default ttl is 30 minutes; allow generous slack for proving time.
      expect(result.ttlUnix).toBeGreaterThan(Date.now());
      expect(result.ttlUnix).toBeLessThan(Date.now() + 31 * 60_000);

      // The point of the verb: the hex it returns must be accepted by
      // submitTransaction. A proof that cannot be submitted is worthless,
      // and nothing below the RPC layer proves that for us.
      const submitted = (await client.call(
        'submitTransaction',
        {hex: result.hex, summary: 'integration-test prove -> submit'},
        {timeoutMs: 120_000},
      )) as {txId: string};
      expect(submitted.txId).toMatch(/^[0-9a-f]+$/i);
    }, 600_000);

    it('clamps a ttl above the ledger ceiling to 60 minutes', async () => {
      const result = (await prove({...base(), ttlMinutes: 6000})) as {ttlUnix: number};
      // Clamped to 60; the ledger rejects intents beyond 3600s past the
      // including block, so anything larger would be built only to fail.
      expect(result.ttlUnix).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
      expect(result.ttlUnix).toBeGreaterThan(Date.now() + 55 * 60_000);
    }, 600_000);

    it('honours a ttl inside the range', async () => {
      const result = (await prove({...base(), ttlMinutes: 5})) as {ttlUnix: number};
      expect(result.ttlUnix).toBeGreaterThan(Date.now() + 3 * 60_000);
      expect(result.ttlUnix).toBeLessThan(Date.now() + 7 * 60_000);
    }, 600_000);

    it('refuses a NIGHT amount above the --max-spend cap', async () => {
      // startDaemon sets --max-spend 1000000000 STAR (1000 NIGHT). A proof is
      // a spendable artifact, so the cap has to apply here as it does to
      // transferTokens.
      await expect(
        prove({...base(), amount: (2000n * ONE_NIGHT).toString()}),
      ).rejects.toThrow(/max-spend|exceeds/i);
    }, 600_000);
  });
});

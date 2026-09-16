// Regression test for unshielded input signing (node error 192).
//
// Signing in place via `tx.intents.set(...)` loses the signature, because
// `Transaction.intents` is a WASM getter returning a fresh Map per read. The
// node then rejects the transaction as InputsSignaturesLengthMismatch.
//
// The fixture matters: only a circuit calling `receiveUnshielded` carries
// unshielded inputs, so only it needs signatures. A simpler contract passes
// either way, and so does deploy, which spends only DUST on fees. Do not swap
// the fixture for a simpler one, and do not skip this on a ledger or SDK port.

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {
  DEVNET_URL,
  NETWORK,
  startDaemon,
  setupTestWallet,
  cleanupTestWallet,
  waitForSynced,
  waitForDust,
  runMothJson,
  type DaemonHandle,
} from './helpers.js';

const ARTIFACT = resolve(
  __dirname,
  '../../../../core/contracts/receive-unshielded/managed',
);
const ARTIFACT_PRESENT = existsSync(ARTIFACT);

describe.skipIf(!DEVNET_URL || !ARTIFACT_PRESENT)(
  'contract call with unshielded inputs — signatures must reach the node (#119)',
  () => {
    let wallet: string;
    let daemon: DaemonHandle;
    let contractAddress: string;

    beforeAll(async () => {
      // Bigger than the harness default: this suite makes two contract calls
      // plus a deploy, and DUST generation is proportional to the NIGHT held.
      // With the default airdrop the second call fails to balance its fee.
      wallet = await setupTestWallet('daemon-call-unshielded', NETWORK, '10000');
      daemon = await startDaemon(wallet, NETWORK);
      await waitForSynced(wallet, NETWORK);

      // DUST registration pays its own fee out of the DUST the airdropped NIGHT
      // has generated so far, so straight after an airdrop it legitimately fails
      // with "about N seconds to go". Retry rather than treat that as an error.
      let registered = false;
      let lastFailure = '';
      for (let attempt = 0; attempt < 12 && !registered; attempt++) {
        const reg = runMothJson([
          'daemon', 'dust', 'register',
          '--wallet', wallet,
          '--network', NETWORK,
        ]);
        if (reg.exitCode === 0) {
          registered = true;
          break;
        }
        lastFailure = reg.raw.stderr || reg.raw.stdout;
        if (!/needs .* DUST and has/.test(lastFailure)) {
          throw new Error(`dust register failed: ${lastFailure}`);
        }
        await new Promise((r) => setTimeout(r, 15_000));
      }
      if (!registered) {
        throw new Error(`dust register never accrued enough DUST: ${lastFailure}`);
      }
      await waitForDust(wallet, NETWORK);

      const deploy = runMothJson<{contractAddress?: string}>([
        'daemon', 'deploy', ARTIFACT,
        '--wallet', wallet,
        '--network', NETWORK,
      ]);
      expect(deploy.exitCode, deploy.raw.stderr || deploy.raw.stdout).toBe(0);
      contractAddress = deploy.data?.contractAddress ?? '';
      expect(contractAddress).toBeTruthy();
    }, 900_000);

    afterAll(async () => {
      if (daemon) await daemon.stop();
      if (wallet) cleanupTestWallet(wallet);
    }, 60_000);

    it('accepts a circuit that receives unshielded NIGHT', async () => {
      const call = runMothJson<{txHash?: string; status?: string}>([
        'daemon', 'call', 'takeNight',
        '--wallet', wallet,
        '--network', NETWORK,
        '--address', contractAddress,
        '--artifact', ARTIFACT,
      ]);

      // Before the fix this failed with Custom error: 192.
      const output = call.raw.stderr || call.raw.stdout;
      expect(output).not.toMatch(/Custom error: 192/);
      expect(call.exitCode, output).toBe(0);
      expect(call.data?.status).toBe('SUCCESS');
      expect(call.data?.txHash).toMatch(/^[0-9a-fA-F]+$/);
    }, 600_000);

    // Guards the DUST wait: a resident daemon has just spent DUST, and the old
    // guard made every call after the first wait a full emission cycle.
    it('stays fast on a second call through the same daemon', async () => {
      // The first call spent DUST; wait for the fee to be affordable again so
      // this measures the guard, not DUST accrual.
      await waitForDust(wallet, NETWORK);
      const started = Date.now();
      const call = runMothJson<{status?: string}>([
        'daemon', 'call', 'takeNight',
        '--wallet', wallet,
        '--network', NETWORK,
        '--address', contractAddress,
        '--artifact', ARTIFACT,
      ]);
      expect(call.exitCode, call.raw.stderr || call.raw.stdout).toBe(0);
      expect(call.data?.status).toBe('SUCCESS');
      // Generous on purpose: this catches a returning stall, not a regression
      // in a number that block time already dominates.
      expect(Date.now() - started).toBeLessThan(90_000);
    }, 600_000);
  },
);

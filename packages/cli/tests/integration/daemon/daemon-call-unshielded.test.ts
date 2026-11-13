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
import {bundledContractForDeploy, DEFAULT_NETWORKS} from '@shieldedtech/moth-wallet';
import {
  DEVNET_URL,
  NETWORK,
  startDaemon,
  setupTestWallet,
  cleanupTestWallet,
  waitForSynced,
  prepareFeePayer,
  runMothJson,
  FEE_PAYER_NIGHT,
  type DaemonHandle,
} from './helpers.js';

describe.skipIf(!DEVNET_URL)(
  'contract call with unshielded inputs — signatures must reach the node (#119)',
  () => {
    let wallet: string;
    let daemon: DaemonHandle;
    let contractAddress: string;
    let artifact: string;

    beforeAll(async () => {
      // The fixture ships one build per ledger era, and only the one for the
      // stack's current era deploys. It is committed, so a missing one is a repo
      // error, not a reason to skip: this regression test must fail loudly.
      const indexerUrl = process.env.MOTH_INDEXER_URL ?? DEFAULT_NETWORKS[NETWORK].indexerUrl;
      artifact = (await bundledContractForDeploy('receive-unshielded', {indexerUrl})).artifactPath;
      expect(existsSync(artifact), `missing fixture: ${artifact}`).toBe(true);

      wallet = await setupTestWallet('daemon-call-unshielded', NETWORK, FEE_PAYER_NIGHT);
      daemon = await startDaemon(wallet, NETWORK);
      await waitForSynced(wallet, NETWORK);

      // One coin each for the deploy and the two calls, which follow one another
      // faster than a transaction's change comes back.
      await prepareFeePayer(wallet, NETWORK, 3);

      const deploy = runMothJson<{contractAddress?: string}>([
        'daemon', 'deploy', artifact,
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
        '--artifact', artifact,
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
      // The wallet holds a coin the first call did not spend, so this measures
      // the guard, not DUST accrual.
      const started = Date.now();
      const call = runMothJson<{status?: string}>([
        'daemon', 'call', 'takeNight',
        '--wallet', wallet,
        '--network', NETWORK,
        '--address', contractAddress,
        '--artifact', artifact,
      ]);
      expect(call.exitCode, call.raw.stderr || call.raw.stdout).toBe(0);
      expect(call.data?.status).toBe('SUCCESS');
      // Generous on purpose: this catches a returning stall, not a regression
      // in a number that block time already dominates.
      expect(Date.now() - started).toBeLessThan(90_000);
    }, 600_000);
  },
);

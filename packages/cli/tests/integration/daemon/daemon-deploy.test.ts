// End-to-end test for the `deployContract` daemon verb. Deploys a
// counter contract through the daemon and asserts the new contract
// address is well-formed.
//
// Gated on TWO env vars: MOTH_DEVNET_URL AND COUNTER_ARTIFACT_PATH —
// same pattern as daemon-call.test.ts.

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
  waitForDaemonStderr,
  runMoth,
  runMothJson,
  type DaemonHandle,
} from './helpers.js';
const COUNTER_ARTIFACT = process.env.COUNTER_ARTIFACT_PATH;
const COUNTER_AVAILABLE = !!COUNTER_ARTIFACT && existsSync(COUNTER_ARTIFACT);
const FPC_WITNESSES = resolve(__dirname, '../../fixtures/fpc-registry-witnesses.mjs');

describe.skipIf(!DEVNET_URL || !COUNTER_AVAILABLE)('moth daemon deploy — round-trip', () => {
  let wallet: string;
  let daemon: DaemonHandle;

  beforeAll(async () => {
    wallet = await setupTestWallet('daemon-deploy', NETWORK);
    daemon = await startDaemon(wallet, NETWORK);
    await waitForSynced(wallet, NETWORK);

    // Deploy needs DUST to pay its tx fee. Register the wallet's
    // freshly-airdropped NIGHT for dust generation, then wait for
    // accrual before the test runs.
    const reg = runMothJson([
      'daemon', 'dust', 'register',
      '--wallet', wallet,
      '--network', NETWORK,
    ]);
    if (reg.exitCode !== 0) {
      throw new Error(`dust register failed: ${reg.raw.stderr || reg.raw.stdout}`);
    }
    await waitForDust(wallet, NETWORK);
  }, 900_000);

  afterAll(async () => {
    if (daemon) await daemon.stop();
    if (wallet) cleanupTestWallet(wallet);
  }, 60_000);

  it('deploys a contract through the daemon and returns a contract address', async () => {
    // fpc-registry's Contract constructor requires four
    // function-valued witnesses (see contract/index.d.ts:3) —
    // the stub fixture below provides them with passthrough
    // implementations that satisfy the constructor's typecheck
    // but never get invoked at deploy time.
    const deploy = runMothJson<{txHash?: string; contractAddress?: string; status?: string}>([
      'daemon', 'deploy', COUNTER_ARTIFACT!,
      '--wallet', wallet,
      '--network', NETWORK,
      '--witnesses', FPC_WITNESSES,
    ]);
    expect(deploy.exitCode, deploy.raw.stderr || deploy.raw.stdout).toBe(0);
    expect(deploy.data?.txHash).toBeTruthy();
    expect(deploy.data?.txHash).toMatch(/^[0-9a-fA-F]+$/);
    expect(deploy.data?.contractAddress).toBeTruthy();
    // Daemon returns the contract address as raw hex (32-byte hash).
    // A bech32m string (`mn_addr_…`) is the wallet-side encoding; the
    // network-level identity is the hex form. Accept either so the
    // test doesn't lock in one representation prematurely.
    expect(deploy.data?.contractAddress).toMatch(/^(mn_addr_|[0-9a-fA-F]{40,})/);
    expect(deploy.data?.status).toBe('SUCCESS');

    await waitForDaemonStderr(daemon, /auto-approve.*Deploy contract from/);
    await waitForDaemonStderr(daemon, /Circuits:/);
  });

  it('rejects with INVALID_PARAMS when artifact path is wrong', () => {
    const result = runMoth([
      'daemon', 'deploy', '/tmp/this-artifact-does-not-exist-12345',
      '--wallet', wallet,
      '--network', NETWORK,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/failed to load artifact/);
  });

  it('rejects when neither positional nor --artifact is given', () => {
    const result = runMoth([
      'daemon', 'deploy',
      '--wallet', wallet,
      '--network', NETWORK,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/artifact path required/);
  });
});

// End-to-end test for the `callCircuit` daemon verb.
//
// Strategy: deploy a tiny test contract using the standalone `moth
// deploy` (the daemon doesn't host a deploy verb yet — that's a
// follow-up commit), then route a circuit invocation through `moth
// daemon call` and assert the tx lands on-chain.
//
// Gated on TWO env vars: MOTH_DEVNET_URL (the standard devnet gate)
// AND COUNTER_ARTIFACT_PATH (path to a compiled counter contract
// artifact directory). When either is missing the suite is skipped —
// same pattern as ci-pipeline.test.ts step 5.

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
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

/** Reads the first circuit name from `<artifact>/compiler/contract-info.json`.
 *  Lets the test pick a real circuit out of whatever artifact
 *  COUNTER_ARTIFACT_PATH points at without hardcoding. */
async function firstCircuitName(artifactPath: string): Promise<string> {
  const info = JSON.parse(readFileSync(join(artifactPath, 'compiler', 'contract-info.json'), 'utf-8'));
  const name = info.circuits?.[0]?.name;
  if (!name) throw new Error(`No circuits in ${artifactPath}/compiler/contract-info.json`);
  return name;
}
const COUNTER_ARTIFACT = process.env.COUNTER_ARTIFACT_PATH;
const COUNTER_AVAILABLE = !!COUNTER_ARTIFACT && existsSync(COUNTER_ARTIFACT);
const FPC_WITNESSES = resolve(__dirname, '../../fixtures/fpc-registry-witnesses.mjs');

describe.skipIf(!DEVNET_URL || !COUNTER_AVAILABLE)('moth daemon call — circuit round-trip', () => {
  let wallet: string;
  let daemon: DaemonHandle;
  let contractAddress: string;

  beforeAll(async () => {
    wallet = await setupTestWallet('daemon-call', NETWORK);
    daemon = await startDaemon(wallet, NETWORK);
    await waitForSynced(wallet, NETWORK);

    // Deploy needs DUST to pay its tx fee, and the contract needs
    // witnesses to satisfy CompactContext. Register, wait, then
    // deploy via inline CLI — the inline pipeline shares the same
    // sync cache the daemon populated.
    const reg = runMothJson([
      'daemon', 'dust', 'register',
      '--wallet', wallet,
      '--network', NETWORK,
    ]);
    if (reg.exitCode !== 0) {
      throw new Error(`dust register failed: ${reg.raw.stderr || reg.raw.stdout}`);
    }
    await waitForDust(wallet, NETWORK);

    // Deploy via `daemon deploy` (not inline `moth deploy`): the
    // daemon already has a warm sync + the dust accrual we just
    // waited for, so we don't pay the fee out of an inline-deploy's
    // separate DUST view (which races against accrual).
    const deploy = runMothJson<{contractAddress?: string}>([
      'daemon', 'deploy', COUNTER_ARTIFACT!,
      '--wallet', wallet,
      '--network', NETWORK,
      '--witnesses', FPC_WITNESSES,
    ]);
    expect(deploy.exitCode, deploy.raw.stderr || deploy.raw.stdout).toBe(0);
    contractAddress = deploy.data?.contractAddress ?? '';
    expect(contractAddress).toBeTruthy();
  }, 900_000);

  afterAll(async () => {
    if (daemon) await daemon.stop();
    if (wallet) cleanupTestWallet(wallet);
  }, 60_000);

  // TODO: the args-array bug is fixed (call.ts:233 no longer wraps
  // empty `{}` into `[{}]`), but the test contract `issue_credential`
  // expects witness data with real semantic content — our stub
  // witnesses fixture returns zero-bytes for issuer_secret etc., and
  // the circuit body errors at runtime with `ContractRuntimeError:
  // Error executing circuit 'issue_credential'`. To turn this on we
  // need either a contract whose first circuit has no meaningful
  // witness-data dependencies, or real witnesses for fpc-registry.
  // Tracked in 01-architecture.md Open Q §6.
  it.skip('routes a circuit call through the daemon and returns a tx hash', async () => {
    // `issue_credential` is the first circuit of fpc-registry — the
    // current canonical COUNTER_ARTIFACT. The test stays artifact-
    // agnostic by reading the circuit name out of the artifact's
    // compiler/contract-info.json rather than hardcoding.
    const circuitName = await firstCircuitName(COUNTER_ARTIFACT!);
    const call = runMothJson<{txHash?: string; status?: string}>([
      'daemon', 'call', circuitName,
      '--wallet', wallet,
      '--network', NETWORK,
      '--address', contractAddress,
      '--artifact', COUNTER_ARTIFACT!,
      '--witnesses', FPC_WITNESSES,
    ]);
    expect(call.exitCode, call.raw.stderr || call.raw.stdout).toBe(0);
    expect(call.data?.txHash).toBeTruthy();
    expect(call.data?.txHash).toMatch(/^[0-9a-fA-F]+$/);
    expect(call.data?.status).toBe('SUCCESS');

    await waitForDaemonStderr(daemon, new RegExp(`auto-approve.*Call ${circuitName} on`));
    await waitForDaemonStderr(daemon, new RegExp(`Contract: ${escapeRegex(contractAddress)}`));
  });

  it('rejects when the circuit name isn\'t in the artifact', () => {
    const call = runMoth([
      'daemon', 'call', 'frobnicate-not-real',
      '--wallet', wallet,
      '--network', NETWORK,
      '--address', contractAddress,
      '--artifact', COUNTER_ARTIFACT!,
    ]);
    expect(call.exitCode).not.toBe(0);
    expect(call.stderr).toMatch(/artifact has no circuit named "frobnicate-not-real"/);
  });

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
});

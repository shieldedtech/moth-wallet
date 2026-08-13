// End-to-end test for the maintenance insert-vk verbs. Deploys a
// stub contract (one circuit exported), then asks the daemon to
// insert a verifier key for it via the maintenance update path.
//
// Gated on MOTH_DEVNET_URL + COUNTER_ARTIFACT_PATH (the artifact
// must contain at least one .verifier in keys/). Skips otherwise.

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {existsSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  DEVNET_URL,
  NETWORK,
  startDaemon,
  setupTestWallet,
  cleanupTestWallet,
  waitForSynced,
  waitForDust,
  runMothJson,
  runMoth,
  type DaemonHandle,
} from './helpers.js';
const COUNTER_ARTIFACT = process.env.COUNTER_ARTIFACT_PATH;
const COUNTER_AVAILABLE = !!COUNTER_ARTIFACT && existsSync(COUNTER_ARTIFACT);
const FPC_WITNESSES = resolve(__dirname, '../../fixtures/fpc-registry-witnesses.mjs');

function pickFirstCircuit(artifact: string): {circuitId: string; vkPath: string} | null {
  const keysDir = join(artifact, 'keys');
  if (!existsSync(keysDir)) return null;
  const verifiers = readdirSync(keysDir).filter((f) => f.endsWith('.verifier'));
  if (verifiers.length === 0) return null;
  return {
    circuitId: verifiers[0]!.replace(/\.verifier$/, ''),
    vkPath: join(keysDir, verifiers[0]!),
  };
}

describe.skipIf(!DEVNET_URL || !COUNTER_AVAILABLE)('moth daemon maintenance insert-vk', () => {
  let wallet: string;
  let daemon: DaemonHandle;
  let contractAddress: string;
  let firstCircuit: {circuitId: string; vkPath: string};

  beforeAll(async () => {
    const picked = pickFirstCircuit(COUNTER_ARTIFACT!);
    if (!picked) throw new Error(`No .verifier files in ${COUNTER_ARTIFACT}/keys`);
    firstCircuit = picked;

    wallet = await setupTestWallet('daemon-maint', NETWORK);
    daemon = await startDaemon(wallet, NETWORK);
    await waitForSynced(wallet, NETWORK);

    // Inline `moth deploy` needs DUST for the tx fee and a real
    // witness file for the contract's Witnesses<PS> constructor.
    const reg = runMothJson([
      'daemon', 'dust', 'register',
      '--wallet', wallet,
      '--network', NETWORK,
    ]);
    if (reg.exitCode !== 0) {
      throw new Error(`dust register failed: ${reg.raw.stderr || reg.raw.stdout}`);
    }
    await waitForDust(wallet, NETWORK);

    // Deploy via `daemon deploy` so the contract creation shares
    // the daemon's warm sync + dust state. Inline `moth deploy`
    // races against dust accrual in its own separate sync.
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

  // TODO: maintenance insert-vk only works for circuits absent at
  // deploy time. The existing "stub" artifacts in the user's
  // projects (compliant-token/compiled-*-stub, blogs/staged-deploy/
  // compiled-stub) all have ZERO circuits — they're empty shells,
  // not partial deployments. To exercise insert-vk we need a
  // custom Compact source with two circuits where ONE's `export`
  // is stripped, compiled to a managed/ dir and committed under
  // tests/fixtures/. That requires the compact compiler in CI and
  // a small chunk of Compact authorship — half-day of work,
  // out of scope for the stage-1 close-out. 01-architecture.md
  // Open Q §7.
  it.skip('insert-vk: routes the maintenance update through the daemon', () => {
    const result = runMothJson<{txHash?: string; status?: string}>([
      'daemon', 'maintenance', 'insert-vk',
      '--wallet', wallet,
      '--network', NETWORK,
      '--address', contractAddress,
      '--circuit-id', firstCircuit.circuitId,
      '--vk-file', firstCircuit.vkPath,
      '--artifact', COUNTER_ARTIFACT!,
    ]);
    expect(result.exitCode, result.raw.stderr || result.raw.stdout).toBe(0);
    expect(result.data?.txHash).toBeTruthy();

    const stderr = daemon.stderr();
    expect(stderr).toMatch(/auto-approve.*Insert verifier key/);
    expect(stderr).toMatch(new RegExp(`Circuit: ${escapeRegex(firstCircuit.circuitId)}`));
  });

  it('insert-vk: rejects when circuit name is not in the artifact', () => {
    const result = runMoth([
      'daemon', 'maintenance', 'insert-vk',
      '--wallet', wallet,
      '--network', NETWORK,
      '--address', contractAddress,
      '--circuit-id', 'never-defined-circuit-name',
      '--vk-file', firstCircuit.vkPath,
      '--artifact', COUNTER_ARTIFACT!,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/artifact has no circuit named "never-defined-circuit-name"/);
  });

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
});

// T066: CI pipeline integration test
// Full generate → airdrop → deploy → call → state → remove cycle
// Validates JSON output and exit codes at each step.
// Requires a running devnet — skipped when MOTH_DEVNET_URL is not set.

import { describe, it, expect } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { resolve } from 'node:path';

const DEVNET_URL = process.env.MOTH_DEVNET_URL;
const MOTH_BIN = resolve(__dirname, '../../bin/moth');
const PASSPHRASE = process.env.MOTH_PASSPHRASE ?? 'ci-pipeline-test-12345';
const WALLET_NAME = `ci-test-${Date.now()}`;

function moth(args: string[], env: Record<string, string> = {}): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(MOTH_BIN, args, {
      encoding: 'utf-8',
      timeout: 180_000,
      env: {
        ...process.env,
        MOTH_PASSPHRASE: PASSPHRASE,
        ...env,
      },
    }).trim();
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.toString().trim() ?? '', exitCode: err.status ?? 1 };
  }
}

function mothJson(args: string[], env?: Record<string, string>): { data: unknown; exitCode: number } {
  const result = moth([...args, '-o', 'json'], env);
  try {
    return { data: JSON.parse(result.stdout), exitCode: result.exitCode };
  } catch {
    return { data: null, exitCode: result.exitCode };
  }
}

describe.skipIf(!DEVNET_URL)('CI Pipeline Integration', () => {
  let contractAddress: string;

  it('step 1: generate wallet', () => {
    const { data, exitCode } = mothJson([
      'wallet', 'generate',
      '--name', WALLET_NAME,
      '-n', 'devnet',
    ]);
    expect(exitCode).toBe(0);
    expect(data).toHaveProperty('name', WALLET_NAME);
  });

  it('step 2: use wallet', () => {
    const { exitCode } = moth(['wallet', 'use', WALLET_NAME]);
    expect(exitCode).toBe(0);
  });

  it('step 3: airdrop test tokens', () => {
    const { data, exitCode } = mothJson([
      'airdrop', '-n', 'devnet', '-y',
    ]);
    expect(exitCode).toBe(0);
    expect(data).toHaveProperty('status');
  });

  it('step 4: check balance', () => {
    const { data, exitCode } = mothJson([
      'balance', '-n', 'devnet',
    ]);
    expect(exitCode).toBe(0);
    expect(data).toBeTruthy();
  });

  it('step 5: deploy counter contract', () => {
    const counterArtifact = process.env.COUNTER_ARTIFACT_PATH;
    if (!counterArtifact) {
      console.warn('COUNTER_ARTIFACT_PATH not set — skipping deploy step');
      return;
    }

    const { data, exitCode } = mothJson([
      'deploy', counterArtifact,
      '-n', 'devnet',
      '-y',
    ]);
    expect(exitCode).toBe(0);
    contractAddress = (data as any)?.contractAddress;
    expect(contractAddress).toBeTruthy();
  });

  it('step 6: call increment', () => {
    if (!contractAddress) return;

    const { data, exitCode } = mothJson([
      'call', 'increment',
      '--address', contractAddress,
      '-n', 'devnet',
      '-y',
    ]);
    expect(exitCode).toBe(0);
    expect(data).toHaveProperty('txHash');
  });

  it('step 7: query state', () => {
    if (!contractAddress) return;

    const { data, exitCode } = mothJson([
      'state', contractAddress,
      '-n', 'devnet',
    ]);
    expect(exitCode).toBe(0);
    expect(data).toHaveProperty('state');
  });

  it('step 8: remove wallet', () => {
    const { exitCode } = moth([
      'wallet', 'remove', WALLET_NAME, '-y',
    ]);
    expect(exitCode).toBe(0);
  });

  it('step 9: verify wallet removed', () => {
    const { data, exitCode } = mothJson(['wallet', 'list']);
    const wallets = data as any[];
    const found = wallets?.find?.((w: any) => w.name === WALLET_NAME);
    expect(found).toBeUndefined();
  });
});

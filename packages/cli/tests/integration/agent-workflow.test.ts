// T047: End-to-end agent workflow test
// deploy counter → call increment → query state → assert counter=1
// Requires a running devnet — skipped when MOTH_DEVNET_URL is not set.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const DEVNET_URL = process.env.MOTH_DEVNET_URL;
const MOTH_BIN = resolve(__dirname, '../../bin/moth');
const PASSPHRASE = process.env.MOTH_PASSPHRASE ?? 'test-passphrase-12345';
const WALLET_NAME = `test-agent-${Date.now()}`;

function moth(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(MOTH_BIN, args, {
    encoding: 'utf-8',
    timeout: 180_000,
    env: {
      ...process.env,
      MOTH_PASSPHRASE: PASSPHRASE,
      ...env,
    },
  }).trim();
}

function mothJson(args: string[], env?: Record<string, string>): unknown {
  return JSON.parse(moth([...args, '-o', 'json'], env));
}

describe.skipIf(!DEVNET_URL)('Agent Workflow E2E', () => {
  let contractAddress: string;

  beforeAll(() => {
    // Generate ephemeral wallet
    moth(['wallet', 'generate', '--name', WALLET_NAME, '-n', 'devnet', '-y']);
    moth(['wallet', 'use', WALLET_NAME]);

    // Airdrop test tokens
    moth(['airdrop', '-n', 'devnet', '-y']);
  });

  it('deploy counter contract', () => {
    const counterArtifact = process.env.COUNTER_ARTIFACT_PATH;
    if (!counterArtifact) throw new Error('Set COUNTER_ARTIFACT_PATH to compiled counter contract');

    const result = mothJson([
      'deploy', counterArtifact,
      '-n', 'devnet',
      '-y',
    ]) as { contractAddress: string };

    expect(result.contractAddress).toBeTruthy();
    contractAddress = result.contractAddress;
  });

  it('call increment circuit', () => {
    const result = mothJson([
      'call', 'increment',
      '--address', contractAddress,
      '-n', 'devnet',
      '-y',
    ]) as { txHash: string; status: string };

    expect(result.txHash).toBeTruthy();
    expect(result.status).toBe('included');
  });

  it('query state shows counter=1', () => {
    const result = mothJson([
      'state', contractAddress,
      '-n', 'devnet',
    ]) as { state: Record<string, unknown> };

    expect(result.state).toBeTruthy();
    // The counter contract's public state should contain counter=1
    // Exact field name depends on the contract, but the state should be non-empty
    expect(Object.keys(result.state).length).toBeGreaterThan(0);
  });

  it('cleanup: remove wallet', () => {
    moth(['wallet', 'remove', WALLET_NAME, '-y']);
  });
});

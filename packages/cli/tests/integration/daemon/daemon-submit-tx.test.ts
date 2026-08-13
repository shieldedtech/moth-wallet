// Smoke test for the `submitTransaction` daemon verb. We send synthetic
// hex that can't possibly deserialize as a FinalizedTransaction and
// assert the daemon rejects with INVALID_PARAMS. This exercises:
//   - the daemon-serve startup + socket bind
//   - the connectDaemonOrExit helper in BaseCommand
//   - the wire-format param validation
//   - the SDK's tx-deserialization error pathway
//   - the renderDaemonError mapping of INVALID_PARAMS → INVALID_INPUT
//
// Doesn't need an actual on-chain submission because we expect the
// daemon to fail before reaching `facade.submitTransaction`.

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {
  DEVNET_URL,
  NETWORK,
  startDaemon,
  setupTestWallet,
  cleanupTestWallet,
  waitForSynced,
  runMoth,
  type DaemonHandle,
} from './helpers.js';

describe.skipIf(!DEVNET_URL)('moth daemon submit-tx — invalid-hex handling', () => {
  let wallet: string;
  let daemon: DaemonHandle;

  beforeAll(async () => {
    wallet = await setupTestWallet('daemon-submit', NETWORK);
    daemon = await startDaemon(wallet, NETWORK);
    await waitForSynced(wallet, NETWORK);
  }, 600_000);

  afterAll(async () => {
    if (daemon) await daemon.stop();
    if (wallet) cleanupTestWallet(wallet);
  }, 60_000);

  it('rejects synthetic hex with INVALID_INPUT (SDK-side deserialize fail)', () => {
    const result = runMoth(
      [
        'daemon', 'submit-tx',
        '--wallet', wallet,
        '--network', NETWORK,
        '--hex', 'deadbeef',
        '--summary', 'integration-test synthetic hex',
      ],
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/INVALID_INPUT/);
    expect(result.stderr).toMatch(/failed to deserialize hex as FinalizedTransaction/);
  });

  it('rejects malformed hex (odd length) before the modal fires', () => {
    const result = runMoth(
      [
        'daemon', 'submit-tx',
        '--wallet', wallet,
        '--network', NETWORK,
        '--hex', 'abc',  // odd length, not valid hex
      ],
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/even-length hex|must be a non-empty hex/i);
  });

  it('exits with the no-TUI error when daemon isn\'t running for a different wallet', () => {
    const result = runMoth(
      [
        'daemon', 'submit-tx',
        '--wallet', `nonexistent-${Date.now()}`,
        '--network', NETWORK,
        '--hex', 'deadbeef',
      ],
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/No TUI is hosting wallet/);
  });
});

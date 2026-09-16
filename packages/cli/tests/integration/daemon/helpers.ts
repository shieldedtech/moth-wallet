// Shared harness for the daemon integration test suite.
//
// Each test file in this directory spawns its own `moth daemon serve`
// subprocess against a freshly-generated wallet, runs CLI commands as
// subprocesses, and asserts on real on-chain results. Daemon stays
// alive for the file's tests, then SIGTERM'd in afterAll().
//
// Requires a running devnet — every test file gates on MOTH_DEVNET_URL
// via vitest's describe.skipIf(!DEVNET_URL), matching the existing
// integration tests.

import {execFile, execFileSync, spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';

export const DEVNET_URL = process.env.MOTH_DEVNET_URL;
export const MOTH_BIN = resolve(__dirname, '../../../bin/moth');

// All daemon integration tests target the local docker stack
// (`undeployed`). The phantom `devnet` in `packages/core/src/types/
// network.ts` points at unreachable public hosts; genesis-seeded
// airdrop only works against `undeployed`. Public-network smoke
// testing needs a different harness with HTTP-faucet funding.
export const NETWORK = 'undeployed';

const DEFAULT_PASSPHRASE = process.env.MOTH_PASSPHRASE ?? 'daemon-test-passphrase-12345';
const AIRDROP_NIGHT = process.env.MOTH_TEST_AIRDROP_NIGHT ?? '1000';

// Bech32m addresses captured from `moth wallet generate -o json` —
// `wallet list` does not populate `addresses.*` for wallets that
// have never been unlocked, so we cache them ourselves at creation
// time and serve `getReceiveAddress` from this map.
const addressCache = new Map<string, string>();

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run moth synchronously, capturing stdout/stderr. Inherits env unless
 *  overridden. */
export function runMoth(args: string[], env: Record<string, string> = {}): CliResult {
  try {
    const stdout = execFileSync(MOTH_BIN, args, {
      encoding: 'utf-8',
      timeout: 300_000,
      env: {
        ...process.env,
        MOTH_PASSPHRASE: DEFAULT_PASSPHRASE,
        ...env,
      },
    }).trim();
    return {stdout, stderr: '', exitCode: 0};
  } catch (err) {
    const e = err as {stdout?: Buffer | string; stderr?: Buffer | string; status?: number};
    return {
      stdout: e.stdout?.toString().trim() ?? '',
      stderr: e.stderr?.toString().trim() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

/** Run moth with `-o json` and parse the result. Returns `{data: null}`
 *  if the output isn't valid JSON. */
export function runMothJson<T = unknown>(args: string[], env?: Record<string, string>): {data: T | null; exitCode: number; raw: CliResult} {
  const raw = runMoth([...args, '-o', 'json'], env);
  try {
    return {data: JSON.parse(raw.stdout) as T, exitCode: raw.exitCode, raw};
  } catch {
    return {data: null, exitCode: raw.exitCode, raw};
  }
}

export interface DaemonHandle {
  process: ChildProcess;
  socketPath: string;
  readonly walletName: string;
  readonly network: string;
  /** Kills the daemon and awaits exit. Best-effort; resolves even on
   *  SIGTERM-then-SIGKILL escalation. */
  stop(): Promise<void>;
  /** Captured stderr (the daemon writes its audit log + sync status
   *  there). Useful for assertions like "auto-approve fired for verb X". */
  stderr(): string;
}

/**
 * Spawn `moth daemon serve --auto-approve` for the given wallet. Waits
 * for the socket file to appear (timeout: 60s) and the daemon to
 * report "wallet synced" on stderr.
 */
export async function startDaemon(walletName: string, network: string): Promise<DaemonHandle> {
  const socketPath = join(homedir(), '.moth', 'sync', network, `${walletName}.sock`);
  // If a previous test left a stale socket, the new daemon's reap path
  // will handle it — we don't need to pre-unlink.
  const child = spawn(
    MOTH_BIN,
    // `--no-wait-for-sync` makes the daemon bind the socket as soon
    // as sync initialization finishes, instead of blocking until
    // `balances.synced=true`. Subsequent waitForReady polls observe
    // the wallet directly — sync-completion gating is brittle
    // (`balances.synced` flips back to false as new blocks arrive),
    // and tests only really need an observable airdrop balance.
    // --max-spend is required under --auto-approve (bounds the per-tx NIGHT
    // a headless daemon can move); use a large cap so test transfers pass.
    ['daemon', 'serve', '--wallet', walletName, '--network', network, '--auto-approve', '--max-spend', '1000000000', '--no-wait-for-sync', '--verbose'],
    {
      env: {
        ...process.env,
        MOTH_PASSPHRASE: DEFAULT_PASSPHRASE,
        MOTH_DAEMON_AUTO_APPROVE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf-8');
  });

  // Wait for the socket file. The daemon binds only after initial
  // sync completes ("waiting for wallet to report synced=true" in
  // its stderr), so on a freshly-funded wallet this can take a
  // minute or more on `undeployed` — give it 4 minutes of headroom.
  const deadline = Date.now() + 240_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited early (code ${child.exitCode}): ${stderrBuf}`);
    }
    if (existsSync(socketPath)) break;
    await new Promise((r) => setTimeout(r, 250));
    lastError = undefined;
  }
  if (!existsSync(socketPath)) {
    child.kill('SIGTERM');
    throw new Error(`daemon socket never appeared at ${socketPath}; stderr=${stderrBuf}; lastError=${String(lastError)}`);
  }

  // Echo the daemon's stderr in real time when MOTH_TEST_VERBOSE_DAEMON=1.
  // Useful for diagnosing sync stalls — by default the buffer is only
  // surfaced on a startup failure.
  if (process.env.MOTH_TEST_VERBOSE_DAEMON === '1') {
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[daemon ${walletName}] ${chunk.toString('utf-8')}`);
    });
    process.stderr.write(`[daemon ${walletName}] (existing buffer)\n${stderrBuf}`);
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    return new Promise<void>((resolveOuter) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        resolveOuter();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveOuter();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolveOuter();
      }
    });
  };

  return {
    process: child,
    socketPath,
    walletName,
    network,
    stop,
    stderr: () => stderrBuf,
  };
}

/**
 * Generate a fresh wallet for the test, fund it from genesis via
 * `midnight airdrop`, and return its name. The wallet's keystore
 * stays on disk so the daemon subprocess can unlock it; the cleanup
 * helper below removes it after the test file is done.
 *
 * The `moth airdrop` command is a stub that does not actually move
 * NIGHT (see `packages/cli/src/commands/airdrop.ts:37`), so we shell
 * out to the `midnight-wallet-cli` npm package — its airdrop verb
 * uses the genesis-seeded wallet baked into the local chain spec.
 * That funding path only exists on `undeployed`.
 *
 * **Order matters.** The moth daemon's wallet sync does NOT pass
 * `isNewWallet`/`birthday` to `startWalletSync` (only the TUI does),
 * so on a fresh wallet with no cache the SDK starts syncing at
 * **current chain tip** instead of genesis. An airdrop that lands
 * before the daemon subscribes is therefore invisible — the wallet
 * never scans the block it arrived in. We work around this by
 * spawning a pre-seed daemon, waiting for its subscription to be
 * live, then airdropping so the funded UTXO arrives via the live
 * subscription. We persist the resulting sync cache to disk and
 * stop the pre-seed daemon; the per-test daemon spawned later
 * restores from that cache and observes NIGHT immediately.
 */
export async function setupTestWallet(
  prefix: string,
  network: string,
  /** NIGHT to airdrop; defaults to AIRDROP_NIGHT (env-overridable). Callers
   *  investigating the DUST-registration wedge (docs/bugs-found #15) pin this
   *  explicitly so wallet size is a controlled variable, not an env default
   *  that could silently change between runs. */
  nightAmount: string = AIRDROP_NIGHT,
): Promise<string> {
  if (network !== 'undeployed') {
    throw new Error(`setupTestWallet only supports 'undeployed' (genesis airdrop scope); got ${network}`);
  }

  const walletName = `${prefix}-${Date.now()}`;

  type AddressBundle = {bech32m?: Record<string, string>};
  type GenerateResult = {
    name: string;
    network: string;
    addresses: {nightExternal?: AddressBundle};
  };

  const gen = runMothJson<GenerateResult>([
    'wallet', 'generate',
    '--name', walletName,
    '--network', network,
  ]);
  if (gen.exitCode !== 0 || !gen.data) {
    throw new Error(`wallet generate failed: ${gen.raw.stderr || gen.raw.stdout}`);
  }

  const bech32m = gen.data.addresses?.nightExternal?.bech32m?.[network];
  if (!bech32m) {
    throw new Error(`wallet generate did not return a nightExternal bech32m address for ${network}`);
  }
  addressCache.set(walletName, bech32m);

  // Switch to the new wallet so subsequent in-process moth commands
  // (deploy, call, etc. when run inline from a test) target it.
  const use = runMoth(['wallet', 'use', walletName]);
  if (use.exitCode !== 0) {
    throw new Error(`wallet use failed: ${use.stderr || use.stdout}`);
  }

  // Phase 1 — pre-seed daemon: subscribe at chain tip BEFORE the
  // airdrop fires.
  const preseed = await startDaemon(walletName, network);
  try {
    // Wait for ready=true. We don't care about synced here — only
    // that the facade has subscribed, so subsequent blocks (incl.
    // the airdrop's) flow into the wallet via the live stream.
    await waitForReady(walletName, network, 60_000);

    // Phase 2 — fund via the midnight CLI (waits for finalization).
    const air = await runMidnight([
      'airdrop', nightAmount,
      '--wallet', bech32m,
    ]);
    if (air.exitCode !== 0) {
      throw new Error(`midnight airdrop failed: ${air.stderr || air.stdout}`);
    }

    // Phase 3 — wait for the wallet to observe the airdrop's
    // unshielded NIGHT UTXO. The pre-seed daemon's subscription
    // surfaces this within a few blocks of finalization.
    await waitForSynced(walletName, network, 120_000);
  } finally {
    // The cache on disk now has the post-airdrop applied index.
    // Tear down the pre-seed daemon; the per-test daemon spawned
    // by the test file will restore from this cache and see NIGHT.
    await preseed.stop();
  }

  return walletName;
}

/**
 * Poll `handle.stderr()` until it matches `pattern`, or throw on
 * timeout. Use this instead of a one-shot `daemon.stderr()` read when
 * asserting on daemon side-effects (audit log, sync events) — the
 * subprocess's stderr pipe is async-buffered, so the write may not
 * have surfaced into the parent's listener buffer by the time the
 * RPC response returns to the test.
 */
export async function waitForDaemonStderr(
  handle: DaemonHandle,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(handle.stderr())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `daemon stderr never matched ${pattern} within ${timeoutMs}ms. ` +
      `Last 500 chars: ${handle.stderr().slice(-500)}`,
  );
}

/** Minimum dust accrual we wait for in `waitForDust` before declaring
 *  the wallet ready for a fee-paying op. Any non-zero value works for
 *  the SDK's "available > 0" precondition, but txs need enough dust to
 *  cover their fee — 1e10 SPECK (≈ 0.00001 DUST in major units) is
 *  empirically generous on a fresh chain without being so high that
 *  we starve the test of time. Bump this if a future op's fee
 *  outgrows it. */
const MIN_DUST_FOR_FEE = 10_000_000_000n;

/**
 * Poll the daemon's `getState` until the wallet has enough accrued
 * DUST to pay a typical transaction fee. Tests that perform any
 * tx-fee-paying op after a fresh airdrop need this; the wallet has
 * NIGHT but generation hasn't built up enough DUST yet, and the SDK
 * fails with `Insufficient Funds: could not balance dust` until the
 * accrual catches up to the fee.
 */
export async function waitForDust(
  walletName: string,
  network: string,
  timeoutMs = 300_000,
  minDust: bigint = MIN_DUST_FOR_FEE,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastDust = '0';
  while (Date.now() < deadline) {
    const res = runMothJson<{ready?: boolean; balances?: {dust?: string}}>([
      'wallet', 'status', '--wallet', walletName, '--network', network,
    ]);
    if (res.exitCode === 0 && res.data?.ready) {
      lastDust = res.data.balances?.dust ?? '0';
      if (BigInt(lastDust) >= minDust) return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `wallet ${walletName} on ${network} never accrued enough DUST within ${timeoutMs}ms ` +
      `(last=${lastDust}, needed >= ${minDust}). ` +
      `Register NIGHT for dust generation first, or extend the timeout.`,
  );
}

/** Variant of `waitForSynced` that only waits for the daemon to be
 *  ready (facade initialized) — used internally by `setupTestWallet`
 *  to know the pre-seed daemon's subscription is live before
 *  triggering the airdrop. */
async function waitForReady(
  walletName: string,
  network: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = runMothJson<{ready?: boolean}>([
      'wallet', 'status', '--wallet', walletName, '--network', network,
    ]);
    if (res.exitCode === 0 && res.data?.ready === true) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`wallet ${walletName} on ${network} daemon never became ready within ${timeoutMs}ms`);
}

/** Best-effort cleanup. Removes the wallet + its sync state. */
export function cleanupTestWallet(walletName: string): void {
  addressCache.delete(walletName);
  runMoth(['wallet', 'remove', walletName, '--yes']);
}

/** Returns the wallet's bech32m unshielded receive address for the
 *  given network. Reads from the in-process cache populated by
 *  `setupTestWallet`. */
export function getReceiveAddress(walletName: string, network: string): string {
  const cached = addressCache.get(walletName);
  if (!cached) {
    throw new Error(`no cached nightExternal address for ${walletName}; was setupTestWallet called for it?`);
  }
  if (network !== NETWORK) {
    throw new Error(`getReceiveAddress called with network=${network} but harness is pinned to ${NETWORK}`);
  }
  return cached;
}

/** Spawn `npx midnight-wallet-cli@latest midnight <args>` and collect
 *  stdout/stderr. Used for funding via the genesis wallet — and, in the
 *  dust-wedge repro, as the only available way to make the genesis wallet
 *  spend on demand (a second `airdrop` to a throwaway address is a genesis
 *  wallet transaction like any other). */
export async function runMidnight(args: string[]): Promise<CliResult> {
  return new Promise((resolveOuter) => {
    const child = spawn('npx', ['-y', '-p', 'midnight-wallet-cli@latest', 'midnight', ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    child.on('close', (code) => {
      resolveOuter({stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1});
    });
    child.on('error', (err) => {
      resolveOuter({stdout: stdout.trim(), stderr: `${stderr}\n${err.message}`.trim(), exitCode: 1});
    });
  });
}

/**
 * NIGHT token id (raw 64-char hex, all zeroes) — the standard
 * identifier the SDK uses for native NIGHT balances inside the
 * unshielded balance map.
 */
const NIGHT_TOKEN_ID = '0'.repeat(64);

interface DaemonStateResponse {
  ready?: boolean;
  synced?: boolean;
  balances?: {
    unshielded?: Record<string, string>;
    shielded?: Record<string, string>;
    dust?: string;
  };
}

/**
 * Poll the daemon via `moth wallet status` until the wallet is
 * ready and either fully synced or has an observable NIGHT balance
 * (the airdrop has been picked up). Strict synced=true is brittle —
 * the SDK's `balances.synced` can flip back to false as new blocks
 * arrive — so we accept the observable-balance signal too. Resolves
 * with the final state, or rejects on timeout.
 */
export async function waitForSynced(
  walletName: string,
  network: string,
  timeoutMs = 300_000,
): Promise<DaemonStateResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: DaemonStateResponse | undefined;
  while (Date.now() < deadline) {
    const res = runMothJson<DaemonStateResponse>([
      'wallet', 'status', '--wallet', walletName, '--network', network,
    ]);
    if (res.exitCode === 0 && res.data) {
      lastSeen = res.data;
      const ready = res.data.ready === true;
      if (ready) {
        const synced = res.data.synced === true;
        const night = BigInt(res.data.balances?.unshielded?.[NIGHT_TOKEN_ID] ?? '0');
        if (synced || night > 0n) return res.data;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `wallet ${walletName} on ${network} never became test-ready within ${timeoutMs}ms; last=${JSON.stringify(lastSeen)}. ` +
      `Re-run with MOTH_TEST_VERBOSE_DAEMON=1 to see the daemon's stderr.`,
  );
}

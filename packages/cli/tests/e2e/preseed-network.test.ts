// End to end: a brand-new CLI wallet seeded from a pre-seed bundle, on a live
// network.
//
// Walks the path a user takes: import a bundle (witnesses and all), refresh it
// against the live indexer, create a wallet, sync it to tip seeded from the
// reference, then launch again and check its dust state restores in seconds.
// With the reference's dust trees uncollapsed that restore took about a minute on
// preprod, on every launch; nothing else here would catch it coming back, because
// a slow wallet is still a working one.
//
// Self-skips unless MOTH_E2E_NETWORK names the network (preview or preprod). The
// bundle defaults to the extension's committed one for that network, and
// MOTH_E2E_PRESEED_DIR points it at another, such as a freshly prepared artifact.
// It runs the built CLI in a throwaway HOME, so it never touches ~/.moth, and it
// needs no secrets: the wallet is generated here and never funded.
//
//   yarn build
//   MOTH_E2E_NETWORK=preprod yarn workspace @shieldedtech/moth-cli test:e2e

import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {inspectDustSnapshot} from '@shieldedtech/moth-wallet';

const NETWORK = process.env.MOTH_E2E_NETWORK ?? '';
const BUNDLE =
  process.env.MOTH_E2E_PRESEED_DIR ?? resolve(__dirname, `../../../extension/public/preseed/${NETWORK}`);
const MOTH_BIN = resolve(__dirname, '../../bin/moth');

const WALLET = 'e2e-preseed';
// Protects a throwaway, never-funded wallet in a temporary HOME.
const PASSPHRASE = 'e2e-preseed-passphrase-for-a-throwaway-wallet';

/** A collapsed reference's dust state is a few KB; an uncollapsed preprod one is megabytes. */
const MAX_REFERENCE_DUST_BYTES = 64 * 1024;
/**
 * The wallet's own dust state after syncing from the reference to tip. Replay
 * regrows the trees a little past the reference (the ledger defect the collapse
 * works around), in proportion to how stale the bundle is — tens of KB for weeks
 * of preprod — and never back to megabytes.
 */
const MAX_WALLET_DUST_BYTES = 1024 * 1024;
/** Deserializing that state on the next launch. Uncollapsed, it took ~57s on preprod. */
const MAX_DUST_RESTORE_MS = 10_000;

const SYNC_TIMEOUT_MS = 40 * 60_000;

let home = '';

/**
 * Run the built CLI.
 *
 * Asynchronous on purpose: a sync takes minutes, and a synchronous spawn would
 * block the vitest worker long enough to time out its own RPC.
 */
function moth(args: string[], timeoutMs = SYNC_TIMEOUT_MS): Promise<{stdout: string; stderr: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home, MOTH_PASSPHRASE: PASSPHRASE};
  // Endpoint overrides from the calling shell would point the test at some other
  // indexer than the network under test.
  for (const name of ['MOTH_INDEXER_URL', 'MOTH_NODE_URL', 'MOTH_PROVER', 'MOTH_PROOF_SERVER_URL']) delete env[name];

  return new Promise((resolveRun, reject) => {
    const child = spawn(MOTH_BIN, args, {cwd: home, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({stdout, stderr});
      else reject(new Error(`moth ${args.join(' ')} exited ${code ?? signal}\n--- stderr\n${stderr}\n--- stdout\n${stdout}`));
    });
  });
}

/** The JSON document a `-o json` command prints on stdout. */
function lastJson<T>(stdout: string): T {
  const starts = [...stdout.matchAll(/^\{$/gm)];
  const at = starts.length > 0 ? starts[starts.length - 1]!.index! : stdout.indexOf('{');
  return JSON.parse(stdout.slice(at)) as T;
}

interface SyncPhase {
  at: number;
  message: string;
}

/**
 * The sync phases a `--verbose` command logs to stderr, as `[<ISO time>] [sync] <message>`.
 *
 * Read from the log rather than `moth diagnostics timings`: that timeline is
 * written by fire-and-forget read-modify-write appends, and phases that follow
 * each other within milliseconds — exactly the fast restore this checks for —
 * overwrite each other there.
 */
function syncPhases(stderr: string): SyncPhase[] {
  return [...stderr.matchAll(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] \[sync\] (.*)$/gm)].map((match) => ({
    at: Date.parse(match[1]!),
    message: match[2]!,
  }));
}

const state = (...segments: string[]) => join(home, '.moth', ...segments);

describe.skipIf(!NETWORK)(`pre-seed bundle end to end on ${NETWORK || 'a live network'}`, () => {
  let manifest: {height: number; witnesses: Record<string, unknown>};

  beforeAll(() => {
    if (!existsSync(MOTH_BIN)) throw new Error(`No built CLI at ${MOTH_BIN}. Run \`yarn build\` first.`);
    if (!existsSync(join(BUNDLE, 'manifest.json'))) throw new Error(`No pre-seed bundle at ${BUNDLE}.`);
    manifest = JSON.parse(readFileSync(join(BUNDLE, 'manifest.json'), 'utf8'));
    home = mkdtempSync(join(tmpdir(), `moth-e2e-${NETWORK}-`));
  });

  afterAll(() => {
    if (home && !process.env.MOTH_E2E_KEEP_HOME) rmSync(home, {recursive: true, force: true});
  });

  it('imports the bundle with its witnesses, and stores its dust state collapsed', async () => {
    const imported = lastJson<{network: string; height: number; dust: string}>(
      (await moth(['preseed', 'import', BUNDLE, '--network', NETWORK, '-o', 'json'])).stdout,
    );

    expect(imported).toMatchObject({network: NETWORK, height: manifest.height});
    expect(['collapsed', 'already-collapsed']).toContain(imported.dust);

    const dust = inspectDustSnapshot(readFileSync(state('sync', NETWORK, '__empty_ref__', 'dust.dat'), 'utf8'));
    expect(dust.utxos).toBe(0);
    expect(dust.stateBytes).toBeLessThan(MAX_REFERENCE_DUST_BYTES);

    // Without these the refresh below could not tell a renumbered indexer from a
    // good one, which is how a stale bundle once imported and then looped.
    for (const part of ['shielded', 'dust']) {
      const witness = JSON.parse(readFileSync(state('witness', NETWORK, '__empty_ref__', `${part}.json`), 'utf8'));
      expect(witness).toEqual(manifest.witnesses[part]);
    }
  });

  it('refreshes the reference against the live indexer, and keeps it collapsed', async () => {
    const {stdout, stderr} = await moth(['preseed', 'refresh', '--network', NETWORK, '--verbose', '-o', 'json']);
    const log = `${stdout}\n${stderr}`;

    // The witnesses are checked against the live indexer here: a bundle whose
    // cursors no longer name the same events is refused, and that must fail the test.
    expect(log).not.toMatch(/has no (shielded|dust) witness|renumber|cannot verify|refusing/i);
    expect(log).toMatch(/reference wallet ready at chain tip/);
    expect(lastJson<{heightAfter: number}>(stdout).heightAfter).toBeGreaterThanOrEqual(manifest.height);

    const stored = readFileSync(state('sync', NETWORK, '__empty_ref__', 'dust.dat'), 'utf8');
    const dust = inspectDustSnapshot(stored);
    expect(dust.utxos).toBe(0);
    expect(dust.stateBytes).toBeLessThan(MAX_REFERENCE_DUST_BYTES);
    expect(readFileSync(state('empty-ref', NETWORK, 'dust-collapsed.txt'), 'utf8').trim()).toBe(
      String(JSON.parse(stored).offset),
    );
  }, SYNC_TIMEOUT_MS);

  it('seeds a brand-new wallet from the reference and syncs it to tip', async () => {
    await moth(['wallet', 'generate', '--name', WALLET, '--network', NETWORK, '-o', 'json']);

    const {stdout, stderr} = await moth([
      'balance', '--wallet', WALLET, '--network', NETWORK,
      '--wait-timeout-ms', String(SYNC_TIMEOUT_MS - 60_000), '--verbose', '-o', 'json',
    ]);
    expect(lastJson<{synced: boolean}>(stdout).synced).toBe(true);

    const messages = syncPhases(stderr).map((phase) => phase.message);
    expect(messages.some((message) => /^Pre-seed complete — .*dust/.test(message)), messages.join('\n')).toBe(true);

    const dust = inspectDustSnapshot(readFileSync(state('sync', NETWORK, WALLET, 'dust.dat'), 'utf8'));
    expect(dust.utxos).toBe(0);
    expect(dust.stateBytes).toBeLessThan(MAX_WALLET_DUST_BYTES);
  }, SYNC_TIMEOUT_MS);

  it('restores the wallet’s dust state in seconds on the next launch', async () => {
    const {stdout, stderr} = await moth([
      'balance', '--wallet', WALLET, '--network', NETWORK,
      '--wait-timeout-ms', String(10 * 60_000), '--verbose', '-o', 'json',
    ]);
    expect(lastJson<{synced: boolean}>(stdout).synced).toBe(true);

    // The gap between this phase and the next is the restore: one
    // DustLocalState.deserialize of the state the first launch saved.
    const phases = syncPhases(stderr);
    const restoring = phases.findIndex((phase) => phase.message === 'Restoring dust state from cache...');
    expect(restoring, phases.map((phase) => phase.message).join('\n')).toBeGreaterThanOrEqual(0);
    expect(restoring + 1).toBeLessThan(phases.length);
    expect(phases[restoring + 1]!.at - phases[restoring]!.at).toBeLessThan(MAX_DUST_RESTORE_MS);

    // And the same cost measured directly, on the exact bytes the CLI restores.
    const saved = readFileSync(state('sync', NETWORK, WALLET, 'dust.dat'), 'utf8');
    const started = performance.now();
    inspectDustSnapshot(saved);
    expect(performance.now() - started).toBeLessThan(MAX_DUST_RESTORE_MS);
  }, SYNC_TIMEOUT_MS);
});

// Repro harness for the devnet dust-ledger wedge documented upstream (a
// midnight-node 2.0.0-rc.4 / midnight-ledger 9.1.0.0-rc.3 defect, not a Moth
// bug — see docs/upstream-issues/dust-ledger-wedge-invalid-dust-spend-proof.md
// for the full writeup and evidence table this test is built from).
//
// The observed shape: a DUST registration lands, and within ~90 seconds every
// subsequent dust spend from every wallet on the chain — including the
// genesis wallet, which never touched the registered coin — starts failing
// with `1010: Invalid Transaction: Custom error: 170`
// (`Malformed(InvalidDustSpendProof)`). Blocks keep being produced. Nothing
// but a chain reset clears it.
//
// Four field occurrences narrowed the trigger to a DUST registration, and
// ruled out coin size as the sole variable (a 10,000,000-NIGHT registration
// wedged a chain on its 39-minutes-after-funding occurrence, after 10+
// identical-size registrations had succeeded when done within seconds of
// funding). This test isolates the ONE surviving variable those occurrences
// didn't control for: the delay between funding and registering. Coin size is
// held fixed at 10,000,000 NIGHT throughout — the size every known SUCCESS
// used — so a wedge observed here cannot be blamed on size.
//
// Sequence: fund a fresh wallet, wait `MOTH_TEST_WEDGE_WAIT_MS` (default 90s;
// set to e.g. 39 * 60_000 to reproduce the fourth occurrence exactly), then
// register, then attempt ONE spend from the freshly registered wallet and ONE
// from the genesis wallet (the second `airdrop` in this harness — the only
// spend this CLI stack can make the genesis wallet perform on demand). If both
// fail with the ambiguous InvalidDustSpendProof signature (checked with the
// same classifier Moth uses to detect this in production —
// `isDustSpendProofRejection`, core/sync/dust-ledger-health.ts) AND the
// indexer confirms blocks kept being produced meanwhile, the chain matches the
// wedge shape and the test fails loudly, printing the evidence a bug report
// needs rather than a bare assertion error.
//
// A pass does NOT prove the defect is fixed — the trigger is not fully
// understood, and most registrations (particularly at this size, done
// promptly) succeed. Run this repeatedly, and with a long wait, to chase it.
//
// Requires a fresh devnet the test is allowed to leave wedged: unlike every
// other file in this directory, a positive result here is destructive to the
// chain. Point MOTH_DEVNET_URL at a disposable stack, never a shared one.

import {describe, it, expect, afterAll} from 'vitest';
import {isDustSpendProofRejection} from '@shieldedtech/moth-wallet';
import {DEFAULT_NETWORKS} from '@shieldedtech/moth-wallet/types/network';
import {
  DEVNET_URL,
  NETWORK,
  setupTestWallet,
  cleanupTestWallet,
  waitForSynced,
  waitForDust,
  runMoth,
  runMothJson,
  runMidnight,
  getReceiveAddress,
} from './helpers.js';

// The size every known-good registration in docs/bugs-found #15 used. Fixed
// here so this run's only variable is the wait below.
const REGISTRATION_NIGHT = process.env.MOTH_TEST_WEDGE_NIGHT ?? '10000000';

// 90s by default — enough to clear the documented ~90-second onset window
// without making a routine CI run pay minutes for a repro that usually won't
// fire. Override to chase a specific occurrence, e.g.:
//   MOTH_TEST_WEDGE_WAIT_MS=2340000 npx vitest run dust-wedge-repro   # 39 min, occurrence 4
//   MOTH_TEST_WEDGE_WAIT_MS=22000   npx vitest run dust-wedge-repro   # 22s, occurrence 3
const WAIT_MS = Number(process.env.MOTH_TEST_WEDGE_WAIT_MS ?? 90_000);

const INDEXER_URL = DEFAULT_NETWORKS[NETWORK]?.indexerUrl;

interface IndexerBlock {
  height: number;
  transactions: {hash: string}[];
}

async function graphql<T>(query: string): Promise<T> {
  const res = await fetch(INDEXER_URL!, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({query}),
  });
  const body = (await res.json()) as {data?: T; errors?: unknown};
  if (!body.data) throw new Error(`indexer query failed: ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}

async function currentTip(): Promise<number> {
  const data = await graphql<{block: {height: number} | null}>('{ block { height } }');
  return data.block?.height ?? 0;
}

async function fetchBlock(height: number): Promise<IndexerBlock | null> {
  const data = await graphql<{block: IndexerBlock | null}>(
    `{ block(offset: { height: ${height} }) { height transactions { hash } } }`,
  );
  return data.block;
}

/** The detection query docs/bugs-found #15 itself proposes: a run of blocks
 *  with zero transactions, on a chain that is being written to, means the
 *  chain is wedged — not that any one transaction was malformed. */
async function emptyBlockRun(fromHeight: number, toHeight: number): Promise<{checked: number; empty: number}> {
  let empty = 0;
  let checked = 0;
  for (let h = fromHeight; h <= toHeight; h++) {
    const block = await fetchBlock(h);
    if (!block) continue;
    checked += 1;
    if (block.transactions.length === 0) empty += 1;
  }
  return {checked, empty};
}

describe.skipIf(!DEVNET_URL)('dust-ledger wedge repro (docs/bugs-found #15) — delay axis', () => {
  let subjectWallet: string | undefined;
  let throwawayWallet: string | undefined;

  afterAll(() => {
    if (subjectWallet) cleanupTestWallet(subjectWallet);
    if (throwawayWallet) cleanupTestWallet(throwawayWallet);
  });

  it(
    `wedges neither the subject wallet's own spend nor genesis's, after a ${(WAIT_MS / 1000).toFixed(0)}s ` +
      `fund-to-register delay at ${REGISTRATION_NIGHT} NIGHT`,
    async () => {
      // --- Fund -----------------------------------------------------------
      subjectWallet = await setupTestWallet('wedge-subject', NETWORK, REGISTRATION_NIGHT);
      const fundedAt = Date.now();
      const subjectAddress = getReceiveAddress(subjectWallet, NETWORK);

      // A second, throwaway address the harness can airdrop to on demand —
      // the only lever this CLI stack has to make the genesis wallet spend
      // whenever we ask, which is what "attempt one spend from genesis" means
      // here: docs/bugs-found #15's second occurrence used exactly this (a
      // plain genesis-funded transfer) to prove the wedge was chain-wide, not
      // wallet-specific.
      throwawayWallet = await setupTestWallet('wedge-genesis-probe', NETWORK, '0');
      const throwawayAddress = getReceiveAddress(throwawayWallet, NETWORK);

      // --- Wait -------------------------------------------------------------
      const elapsed = Date.now() - fundedAt;
      const remaining = WAIT_MS - elapsed;
      if (remaining > 0) {
        process.stderr.write(
          `[wedge-repro] waiting ${(remaining / 1000).toFixed(0)}s more before registering ` +
            `(target delay ${(WAIT_MS / 1000).toFixed(0)}s since funding)...\n`,
        );
        await new Promise((r) => setTimeout(r, remaining));
      }

      const heightBeforeRegister = await currentTip();

      // --- Register ---------------------------------------------------------
      const register = runMothJson<{txHash: string | null; status: string}>([
        'dust', 'register',
        '--wallet', subjectWallet,
        '--network', NETWORK,
        '--yes',
      ]);
      expect(register.exitCode, register.raw.stderr || register.raw.stdout).toBe(0);
      const registeredAt = Date.now();
      process.stderr.write(
        `[wedge-repro] registered at ${new Date(registeredAt).toISOString()}, ` +
          `${((registeredAt - fundedAt) / 1000).toFixed(1)}s after funding: ${JSON.stringify(register.data)}\n`,
      );

      // A registration needs a moment for its dust event to reach the sub-
      // wallet's own view before a spend against it can prove correctly.
      await waitForSynced(subjectWallet, NETWORK, 120_000);
      await waitForDust(subjectWallet, NETWORK, 300_000, 1n);

      // --- Spend #1: the freshly registered wallet, on itself ---------------
      const selfSpend = runMothJson<{txHash: string}>([
        'transfer', '1',
        '--to', subjectAddress,
        '--wallet', subjectWallet,
        '--network', NETWORK,
        '--yes',
      ]);
      const selfSpendFailed = selfSpend.exitCode !== 0;
      const selfSpendIsWedgeSignature =
        selfSpendFailed && isDustSpendProofRejection(new Error(selfSpend.raw.stderr || selfSpend.raw.stdout));

      // --- Spend #2: genesis, via a second airdrop to the throwaway address -
      const genesisSpend = await runMidnight(['airdrop', '1', '--wallet', throwawayAddress]);
      const genesisSpendFailed = genesisSpend.exitCode !== 0;
      const genesisSpendIsWedgeSignature =
        genesisSpendFailed && isDustSpendProofRejection(new Error(genesisSpend.stderr || genesisSpend.stdout));

      // --- Corroborate against the indexer directly --------------------------
      const heightAfter = await currentTip();
      const {checked, empty} = await emptyBlockRun(heightBeforeRegister, heightAfter);
      const blocksAdvanced = heightAfter > heightBeforeRegister;

      const report = {
        network: NETWORK,
        registrationNight: REGISTRATION_NIGHT,
        fundToRegisterDelayMs: registeredAt - fundedAt,
        registerResult: register.data,
        selfSpend: {failed: selfSpendFailed, wedgeSignature: selfSpendIsWedgeSignature, output: selfSpend.raw},
        genesisSpend: {failed: genesisSpendFailed, wedgeSignature: genesisSpendIsWedgeSignature, output: genesisSpend},
        heightBeforeRegister,
        heightAfter,
        blocksAdvanced,
        blocksChecked: checked,
        emptyBlocks: empty,
      };
      process.stderr.write(`[wedge-repro] report: ${JSON.stringify(report, null, 2)}\n`);

      // A wedge is BOTH spends failing with the same ambiguous signature WHILE
      // the chain kept producing blocks — the same two gates Moth's own
      // detector applies (core/sync/dust-ledger-health.ts), so this harness and
      // production disagree about nothing.
      const wedged = selfSpendIsWedgeSignature && genesisSpendIsWedgeSignature && blocksAdvanced;

      expect(
        wedged,
        'DUST LEDGER WEDGED: both the subject wallet and genesis failed InvalidDustSpendProof ' +
          `after this registration, with the chain still producing blocks (${empty}/${checked} empty in the ` +
          `probed range). This chain is now unusable for further tests. See the printed report above for the ' +
          'upstream issue, and docs/upstream-issues/dust-ledger-wedge-invalid-dust-spend-proof.md.`,
      ).toBe(false);
    },
    // Generous: registration + two spends + sync waits, plus whatever
    // MOTH_TEST_WEDGE_WAIT_MS asks for.
    WAIT_MS + 600_000,
  );
});

#!/usr/bin/env node
//
// Does a reference-seeded wallet actually work, or only display correctly?
// ========================================================================
// The pre-seed reference copies an empty wallet's DUST state — the global
// generation tree plus a cursor — into a new wallet with the keys swapped. That
// is proven to sync (dust starts at tip instead of walking 1.4M events, 78.6 min
// becomes ~49s) but has never been shown to SPEND: every benchmark wallet held
// 0 NIGHT and 0 DUST, so no dust proof was ever exercised against a copied tree.
//
// If a copied tree cannot satisfy proving, the reference is a display
// optimisation, not a fix, and nothing further should be built on it. This script
// settles that.
//
// Why it cannot be fully automated: the account must be funded with NIGHT AFTER
// the reference height. Seeding an already-funded wallet is refused by design —
// its NIGHT predates the reference, so seeding would skip its own history. So a
// human has to send NIGHT to the address printed in step 1, and the ledger's 3h
// dust grace period has to elapse before there is any DUST to spend.
//
// Usage — re-run the same command; it detects where it is and does the next step:
//
//   node scripts/dust-proving-check.mjs                 # preprod
//   node scripts/dust-proving-check.mjs --network preview
//   node scripts/dust-proving-check.mjs --send-to <mn_addr…>   # step 4 target
//
// State (the throwaway mnemonic) lives in ~/.moth/dust-proving-check-<network>.json
// so progress survives between runs. NEVER fund this beyond test amounts.
//
// Steps, in order:
//   1. create a reference-seeded account   → prints the address to fund
//   2. wait for NIGHT to arrive
//   3. register that NIGHT for DUST generation
//   4. once DUST > 0, send a fee-paying transaction — the actual test
//
// Exit codes: 0 step completed (or the whole test passed), 1 failure, 2 bad usage.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, inspect } from 'node:util';

const { values } = parseArgs({
  options: {
    network: { type: 'string', default: 'preprod' },
    'send-to': { type: 'string' },
    timeout: { type: 'string', default: '900' },
  },
});

const core = await import('@shieldedtech/moth-wallet');
const {
  DEFAULT_NETWORKS,
  generateMnemonic24,
  mnemonicToSeed,
  deriveWalletKeys,
  deriveAllAddressesFromSeed,
  startWalletSync,
  preseedReferenceStatus,
  designateForDustWithKeys,
  sendTokensWithKeys,
  listNightUtxos,
  formatNight,
  NIGHT_TOKEN_ID,
  IndexerClient,
} = core;

const network = DEFAULT_NETWORKS[values.network];
if (!network) {
  console.error(`Unknown network "${values.network}"`);
  process.exit(2);
}

const STATE_DIR = join(homedir(), '.moth');
const STATE_FILE = join(STATE_DIR, `dust-proving-check-${network.id}.json`);

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------

const ref = await preseedReferenceStatus(network);
if (!ref.ready) {
  console.error(
    `No pre-seed reference at chain tip for ${network.id}. Build one first:\n` +
      `  node scripts/sync-benchmark.mjs --warm-reference --timeout 9000\n` +
      `Without it there is nothing to test — the wallet would just walk the chain.`,
  );
  process.exit(2);
}
console.log(`reference ready at height ${ref.height}`);

let state = loadState();
if (!state) {
  // The birthday MUST be at or after the reference height, or the guard refuses
  // to seed (correctly — an earlier wallet would skip its own history). Reading
  // the tip now gives exactly that, and it is also the honest birthday for an
  // account created right now.
  const tip = await new IndexerClient(network.indexerUrl).getBlock();
  if (!tip?.height) {
    console.error('Could not read chain tip.');
    process.exit(1);
  }
  if (ref.height > tip.height) {
    console.error(`Reference height ${ref.height} is ahead of tip ${tip.height}; cannot seed.`);
    process.exit(1);
  }
  state = { mnemonic: generateMnemonic24(), birthday: tip.height, network: network.id, step: 'created' };
  saveState(state);
  console.log('created a throwaway account (mnemonic saved 0600 — do not fund beyond test amounts)');
}

const seed = await mnemonicToSeed(state.mnemonic);
const seedHex = Array.from(seed).map((b) => b.toString(16).padStart(2, '0')).join('');
seed.fill(0);
const keys = deriveWalletKeys(seedHex);
const addresses = deriveAllAddressesFromSeed(seedHex);
const unshieldedAddress = addresses.nightExternal.bech32m[network.id];

console.log(`account address: ${unshieldedAddress}`);
console.log(`birthday: ${state.birthday} (reference ${ref.height} — seeding allowed)\n`);

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
const wallet = await startWalletSync(
  keys,
  network,
  (msg) => console.log(`  [sync +${elapsed()}s] ${msg}`),
  `dust-proving-check`,
  true,
  state.birthday,
);

// The whole point: dust must start at the reference cursor, not zero.
const first = wallet.balances;
console.log(
  `\ndust at start: ${first.subProgress.dust.applied}/${first.subProgress.dust.total}` +
    ` — ${first.subProgress.dust.applied > 1000 ? 'SEEDED (good)' : 'NOT SEEDED — walking from genesis'}`,
);

const waitFor = async (label, predicate) => {
  const limitMs = Number(values.timeout) * 1000;
  const deadline = Date.now() + limitMs;
  if (predicate(wallet.balances)) return wallet.balances;
  console.log(`waiting for ${label} (up to ${values.timeout}s)…`);
  return new Promise((resolve) => {
    const stop = wallet.subscribe((b) => {
      if (predicate(b)) {
        stop?.();
        resolve(b);
      }
    });
    setTimeout(() => {
      stop?.();
      resolve(null);
    }, Math.max(0, deadline - Date.now()));
  });
};

const night = (b) => b.unshielded[NIGHT_TOKEN_ID] ?? 0n;

const synced = await waitFor('sync to complete', (b) => b.synced);
if (!synced) {
  console.error(`\nFAIL: did not reach synced within ${values.timeout}s.`);
  process.exit(1);
}
console.log(`synced in ${elapsed()}s — NIGHT ${formatNight(night(synced))}, DUST ${formatNight(synced.dust)}`);

// --- Step 2: needs NIGHT -----------------------------------------------------
if (night(synced) === 0n) {
  console.log(
    `\nNEXT: send test NIGHT to\n  ${unshieldedAddress}\n` +
      `then re-run this script. Nothing else can proceed without it.`,
  );
  await wallet.stop().catch(() => {});
  process.exit(0);
}

// --- Step 3: register it for DUST generation ---------------------------------
const registered = synced.dustGeneration?.registered === true;
if (!registered) {
  console.log('\nregistering NIGHT for DUST generation…');
  const utxos = await listNightUtxos(wallet.facade);
  const txHash = await designateForDustWithKeys(
    wallet.facade,
    keys,
    network.id,
    undefined,
    (stage) => console.log(`  [tx] ${stage}`),
    utxos,
  );
  console.log(txHash ? `submitted: ${txHash}` : 'nothing left to register');
  console.log(
    `\nNEXT: the ledger's DUST grace period is 3h (dustGracePeriodSeconds = 10800).` +
      `\nRe-run after it elapses, once DUST > 0.`,
  );
  state.step = 'registered';
  saveState(state);
  await wallet.stop().catch(() => {});
  process.exit(0);
}

// --- Step 4: the actual test — spend, paying fees from copied-tree DUST ------
if (synced.dust === 0n) {
  console.log(
    `\nNIGHT is registered but DUST is still 0. Generation records take up to 3h` +
      `\n(grace period), then DUST accrues toward the cap over ~7 days. Re-run later.`,
  );
  await wallet.stop().catch(() => {});
  process.exit(0);
}

// Last transaction stage reached, so a failure can name where it happened.
// Building and proving exercise the copied tree; submission does not.
let lastTxStage = null;

const target = values['send-to'] ?? unshieldedAddress;
console.log(`\nDUST ${formatNight(synced.dust)} available — sending a fee-paying transaction`);
console.log(`target: ${target}${values['send-to'] ? '' : ' (self)'}`);
console.log('This is the test: fees are paid from DUST whose generation tree was COPIED.\n');

try {
  const txHash = await sendTokensWithKeys(
    wallet.facade,
    keys,
    network.id,
    [{ type: 'unshielded', tokenId: NIGHT_TOKEN_ID, amount: 1_000_000n, to: target }],
    (stage) => {
      lastTxStage = stage;
      console.log(`  [tx] ${stage}`);
    },
  );
  console.log(`\nPASS: submitted ${txHash}`);
  console.log('A copied generation tree satisfies proving and fee payment.');
  state.step = 'passed';
  saveState(state);
  await wallet.stop().catch(() => {});
  process.exit(0);
} catch (error) {
  // WHICH stage failed is the whole result, so report that rather than a blanket
  // verdict. Building and proving are what exercise the copied generation tree;
  // submission is the node's opinion of an already-proven transaction and says
  // nothing about the tree. The stage tracker above records the last `[tx]`
  // stage reached, so the two cases are distinguishable instead of guessed at.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL at stage: ${lastTxStage ?? 'before building'}`);
  console.error(`  ${message}`);

  // The SDK wraps the real reason in `cause`, often several deep, and the outer
  // message ("Transaction submission error") carries none of it. Effect's own
  // Cause.pretty (the MOTH_CAUSE_PRETTY line the SDK prints) stops at the outer
  // error too, so a full structural dump is the only thing that reaches the
  // node's actual complaint.
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause && depth < 8; depth++) {
    const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    console.error(`  caused by: ${text}`);
    if (cause && typeof cause === 'object') {
      for (const key of ['code', 'data', 'reason', '_tag']) {
        if (key in cause && cause[key] !== undefined) console.error(`    ${key}: ${JSON.stringify(cause[key])}`);
      }
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  console.error('\nfull error structure:');
  console.error(inspect(error, { depth: 6, showHidden: false, colors: false }));

  if (lastTxStage === 'building' || lastTxStage === 'proving') {
    console.error(
      '\nVERDICT: a copied generation tree does NOT satisfy spending. The reference\n' +
        'then speeds up display only, and the pre-seed cannot be relied on for\n' +
        'wallets that transact.',
    );
  } else {
    console.error(
      '\nVERDICT: inconclusive. Building and proving SUCCEEDED against the copied\n' +
        'generation tree — the question this script exists to answer — and the\n' +
        'failure came afterwards, from the node rejecting or failing to accept an\n' +
        'already-proven transaction. Investigate the cause above before drawing any\n' +
        'conclusion about the pre-seed reference.',
    );
  }
  state.step = 'failed';
  saveState(state);
  await wallet.stop().catch(() => {});
  process.exit(1);
}

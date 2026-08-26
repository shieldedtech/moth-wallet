#!/usr/bin/env node
//
// New-wallet Sync Benchmark
// =========================
// Measures how long a brand-new wallet takes to sync against a network,
// broken down per sub-wallet (shielded / unshielded / dust) so the slow
// one is visible rather than averaged away.
//
// Requires the workspace to be built (it loads core's WASM):
//   yarn turbo run build
//
// Usage:
//   node scripts/sync-benchmark.mjs                       # preprod, birthday at tip
//   node scripts/sync-benchmark.mjs --from-genesis         # no birthday: full scan
//   node scripts/sync-benchmark.mjs --network preview
//   node scripts/sync-benchmark.mjs --timeout 3600         # seconds, default 1800
//   node scripts/sync-benchmark.mjs --json                 # machine-readable summary
//   node scripts/sync-benchmark.mjs --mnemonic "word1 ..." # re-measure a known wallet
//
// Notes on what is and is not measured:
//   * A fresh random mnemonic is generated per run unless --mnemonic is given,
//     so the wallet has no history and the number reflects chain traversal
//     rather than transaction volume.
//   * Sync state is held in an in-memory store, so every run is a genuine cold
//     start and nothing is written to ~/.moth. Your real wallets are untouched.
//   * DEFAULT birthday is the current chain tip, which is what the wallet
//     itself does when you create an account (see chainTip() in the extension's
//     handlers and `birthday` in WalletManager.create). --from-genesis measures
//     the other extreme: no birthday, so every index is walked.
//   * Milestones come from the same SyncProgress the UIs consume, so
//     "dust synced" here means exactly what the DUST bar means.
//
// Exit codes:
//   0  fully synced within the timeout
//   1  timed out, or sync errored (partial milestones still printed)
//   2  bad usage

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    network: { type: 'string', default: 'preprod' },
    timeout: { type: 'string', default: '1800' },
    mnemonic: { type: 'string' },
    'from-genesis': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    // A/B levers. The indexer feeds every sub-wallet, and dust streams the whole
    // chain from it, so endpoint latency and batch shape are the two knobs that
    // can move the dust figure without an SDK change.
    indexer: { type: 'string' },
    node: { type: 'string' },
    // Build the pre-seed reference to chain tip first, on the SHARED on-disk
    // store, then measure a new wallet against it. The build itself is the slow
    // part (it is the same chain walk being measured); it happens once per
    // network per machine, and every later run reuses it from ~/.moth.
    'warm-reference': { type: 'boolean', default: false },
    'batch-size': { type: 'string' },
    'batch-timeout': { type: 'string' },
    'batch-spacing': { type: 'string' },
  },
});

const TIMEOUT_MS = Number(values.timeout) * 1000;
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  console.error('--timeout must be a positive number of seconds');
  process.exit(2);
}

const core = await import('@shieldedtech/moth-wallet');
const {
  DEFAULT_NETWORKS,
  initSdk,
  resolveLedgerVersion,
  generateMnemonic24,
  validateMnemonic,
  mnemonicToSeed,
  deriveWalletKeys,
  startWalletSync,
  InMemorySyncStateStore,
  IndexerClient,
  warmEmptyRefCache,
  resolveSyncStore,
  emptyRefHeightKey,
  emptyRefMnemonicKey,
  emptyRefStateKey,
} = core;

const preset = DEFAULT_NETWORKS[values.network];
if (!preset) {
  console.error(`Unknown network "${values.network}". Known: ${Object.keys(DEFAULT_NETWORKS).join(', ')}`);
  process.exit(2);
}
const network = {
  ...preset,
  ...(values.indexer ? { indexerUrl: values.indexer } : {}),
  ...(values.node ? { nodeUrl: values.node } : {}),
};

// The sync path derives typed keys through the selected ledger and constructs
// facades through the matching SDK. Both seams are explicit after Ledger 9, so
// initialize them before the first derivation rather than relying on an eager
// v8 import as older builds did.
await initSdk(resolveLedgerVersion(network));

// Omitted keys fall through to core's defaults (size 500, timeout 500, spacing 50).
const batchUpdates = {};
if (values['batch-size'] !== undefined) batchUpdates.size = Number(values['batch-size']);
if (values['batch-timeout'] !== undefined) batchUpdates.timeout = Number(values['batch-timeout']);
if (values['batch-spacing'] !== undefined) batchUpdates.spacing = Number(values['batch-spacing']);
for (const [k, v] of Object.entries(batchUpdates)) {
  if (!Number.isFinite(v) || v < 0) {
    console.error(`--batch-${k} must be a non-negative number`);
    process.exit(2);
  }
}

const mnemonic = values.mnemonic ?? generateMnemonic24();
if (values.mnemonic && !validateMnemonic(mnemonic)) {
  console.error('Invalid BIP-39 mnemonic');
  process.exit(2);
}

const seed = await mnemonicToSeed(mnemonic);
const seedHex = Array.from(seed).map((b) => b.toString(16).padStart(2, '0')).join('');
const keys = deriveWalletKeys(seedHex);

const log = (msg) => {
  if (!values.quiet && !values.json) console.log(msg);
};

// Birthday: chain tip unless --from-genesis. Read AFTER any reference warm (see
// below), because warming takes minutes to an hour and the chain moves under it.
// Taken before, the birthday is older than the reference the run just built, the
// `reference.height <= birthday` guard refuses it, and the run silently measures
// the unseeded path while reporting itself as warmed.
async function readBirthday() {
  if (values['from-genesis']) return undefined;
  const block = await new IndexerClient(network.indexerUrl).getBlock().catch(() => null);
  if (block?.height === undefined) {
    console.error('Could not read chain tip for the birthday; falling back to a genesis scan.');
  }
  return block?.height;
}

log(`network:   ${network.id}  (${network.indexerUrl})`);
log(`wallet:    fresh${values.mnemonic ? ' (supplied mnemonic)' : ' random mnemonic'}`);
log(`batching:  ${Object.keys(batchUpdates).length > 0 ? JSON.stringify(batchUpdates) : 'core defaults (size 500, timeout 500, spacing 50)'}`);
log('');

// Warming uses the default (on-disk) store so the reference persists in ~/.moth
// and later runs — and the real wallet — can reuse it.
if (values['warm-reference']) {
  const warmStart = Date.now();
  log('warming the pre-seed reference to chain tip (slow: this IS the chain walk)…');
  const warmed = await warmEmptyRefCache(network, (m) => log(`  [ref] ${m}`));
  const warmSecs = ((Date.now() - warmStart) / 1000).toFixed(1);
  if (!warmed) {
    console.error(`reference build did not reach tip after ${warmSecs}s — measuring unseeded instead`);
  } else {
    log(`reference ready in ${warmSecs}s — the measured wallet below should start at tip`);
  }
  log('');
}

// Only now: the chain has moved during any warm above, and the guard compares
// the reference's height against this value.
const birthday = await readBirthday();
log(`birthday:  ${birthday === undefined ? 'none — scanning from genesis' : `${birthday} (chain tip)`}`);

// The measured wallet keeps its own in-memory store so a run never leaves wallet
// state in ~/.moth. But the reference lives on disk, and ensureEmptyRefCache
// looks for it in whatever store the wallet was given — so a plain in-memory
// store means the reference is never found and every run measures the unseeded
// path. This overlay reads the reference keys through to disk and keeps
// everything else in memory.
const referenceKeys = new Set([
  emptyRefHeightKey(network.id),
  emptyRefMnemonicKey(network.id),
  ...['shielded', 'unshielded', 'dust', 'history'].map((part) => emptyRefStateKey(network.id, part)),
]);

const diskStore = await resolveSyncStore();
const memoryStore = new InMemorySyncStateStore();
const measuredStore = {
  get: (key) => (referenceKeys.has(key) ? diskStore.get(key) : memoryStore.get(key)),
  // Writes always stay in memory, including reference keys: a measurement run
  // must never mutate the reference it is measuring against.
  put: (key, value) => memoryStore.put(key, value),
  delete: (key) => memoryStore.delete(key),
};

const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;
const fmt = (s) => (s === null ? '—' : `${s.toFixed(1)}s`);

// Milestones, each recorded once, on the first emission that reports it.
const at = {
  firstEmission: null,
  unshieldedSynced: null,
  shieldedSynced: null,
  dustSynced: null,
  allSynced: null,
};
let lastProgress = null;
let finished = false;

function recordMilestones(b) {
  if (at.firstEmission === null) at.firstEmission = elapsed();
  const p = b.syncProgress;
  if (at.unshieldedSynced === null && p.unshieldedSynced) at.unshieldedSynced = elapsed();
  if (at.shieldedSynced === null && p.shieldedSynced) at.shieldedSynced = elapsed();
  if (at.dustSynced === null && p.dustSynced) at.dustSynced = elapsed();
  if (at.allSynced === null && b.synced) at.allSynced = elapsed();

  lastProgress = {
    percentage: p.percentage,
    etaSeconds: p.etaSeconds,
    shielded: { ...b.subProgress.shielded },
    unshielded: { ...b.subProgress.unshielded },
    dust: { ...b.subProgress.dust },
  };
}

function progressLine() {
  if (!lastProgress) return;
  const { shielded: sh, unshielded: un, dust: du } = lastProgress;
  const pct = (a, t) => (t > 0 ? `${Math.min(100, Math.round((a / t) * 100))}%`.padStart(4) : '  —');
  log(
    `  ${elapsed().toFixed(0).padStart(5)}s  ` +
      `shielded ${pct(sh.applied, sh.total)} (${sh.applied}/${sh.total})  ` +
      `unshielded ${pct(un.applied, un.total)}  ` +
      `dust ${pct(du.applied, du.total)} (${du.applied}/${du.total})`,
  );
}

// Stage-stamped progress. startWalletSync does all its setup work (pre-seed,
// per-sub-wallet restore, facade init) before returning, and each stage announces
// itself here — so the gaps between these stamps localise that setup cost without
// instrumenting core.
let lastStamp = started;
const wallet = await startWalletSync(
  keys,
  network,
  (msg) => {
    const now = Date.now();
    const sinceStart = ((now - started) / 1000).toFixed(1);
    const sincePrev = ((now - lastStamp) / 1000).toFixed(1);
    lastStamp = now;
    log(`  [sync] +${sinceStart.padStart(7)}s (${sincePrev.padStart(6)}s) ${msg}`);
  },
  `bench-${Date.now()}`,
  true, // isNewWallet
  birthday,
  {
    syncStore: measuredStore,
    ...(Object.keys(batchUpdates).length > 0 ? { batchUpdates } : {}),
  },
);

log(`  [sync] +${((Date.now() - started) / 1000).toFixed(1)}s startWalletSync returned (all setup above is pre-sync)`);

recordMilestones(wallet.balances);

const ticker = values.json || values.quiet ? null : setInterval(progressLine, 10_000);

const outcome = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS);
  const stop = wallet.subscribe((b) => {
    recordMilestones(b);
    if (b.synced && !finished) {
      finished = true;
      clearTimeout(timer);
      resolve('synced');
    }
  });
  // Already synced before the first subscriber callback.
  if (wallet.balances.synced) {
    finished = true;
    clearTimeout(timer);
    stop?.();
    resolve('synced');
  }
});

if (ticker) clearInterval(ticker);
const total = elapsed();
await wallet.stop().catch(() => {});

const summary = {
  network: network.id,
  birthday: birthday ?? null,
  fromGenesis: birthday === undefined,
  outcome,
  totalSeconds: Number(total.toFixed(1)),
  milestones: {
    firstEmission: at.firstEmission,
    unshieldedSynced: at.unshieldedSynced,
    shieldedSynced: at.shieldedSynced,
    dustSynced: at.dustSynced,
    allSynced: at.allSynced,
  },
  finalProgress: lastProgress,
};

if (values.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('');
  console.log(`outcome:              ${outcome === 'synced' ? 'fully synced' : 'TIMED OUT'}`);
  console.log(`first emission:       ${fmt(at.firstEmission)}`);
  console.log(`unshielded synced:    ${fmt(at.unshieldedSynced)}`);
  console.log(`shielded synced:      ${fmt(at.shieldedSynced)}`);
  console.log(`dust synced:          ${fmt(at.dustSynced)}`);
  console.log(`ALL synced:           ${fmt(at.allSynced)}`);
  console.log(`wall clock:           ${total.toFixed(1)}s`);
  if (lastProgress) {
    const { shielded: sh, unshielded: un, dust: du } = lastProgress;
    console.log('');
    console.log(`final indices:        shielded ${sh.applied}/${sh.total}` +
      `  unshielded ${un.applied}/${un.total}  dust ${du.applied}/${du.total}`);
  }
}

process.exit(outcome === 'synced' ? 0 : 1);

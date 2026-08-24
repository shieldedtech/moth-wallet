// SPIKE STEP 2 — write a warp-jumped dust cache for a wallet.
//
// Fetches the collapsed commitment and generation trees for a target height,
// applies them to a fresh DustLocalState, and writes the result as the wallet's
// dust cache. The wallet then resumes from there instead of replaying the stream.
//
// This is the step the read-only spike could not do, and the one that makes the
// question answerable: a tree that reads correctly can still fail to PROVE, so
// the test is to spend afterwards, not merely to read a balance.
//
// DESTRUCTIVE to the named wallet's dust cache. Use a throwaway wallet. It
// refuses to overwrite an existing cache without --overwrite, and it never
// touches shielded or unshielded state.
//
// Usage:
//   MOTH_PASSPHRASE=… node scripts/spike/warp-restore.mjs \
//     --wallet <throwaway> --height 1697238 [--network preprod] [--dry-run] [--overwrite]

import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  DEFAULT_NETWORKS,
  WalletManager,
  FilesystemStorageAdapter,
  NodeSyncStateStore,
  dustCursorAtHeight,
  syncStateKey,
} from '@shieldedtech/moth-wallet';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const walletName = flag('wallet');
const height = Number(flag('height', '0'));
const networkId = flag('network', 'preprod');
const dryRun = has('dry-run');
const overwrite = has('overwrite');

if (!walletName || !height) {
  console.error('usage: warp-restore.mjs --wallet <name> --height <block> [--network preprod] [--dry-run] [--overwrite]');
  console.error('\nRefuses to run without --wallet: this REPLACES that wallet\'s dust cache.');
  process.exit(2);
}
const net = DEFAULT_NETWORKS[networkId];
if (!net) { console.error(`unknown network "${networkId}"`); process.exit(2); }
if (!process.env.MOTH_PASSPHRASE) {
  console.error('MOTH_PASSPHRASE must be set — the wallet is unlocked to read its dust public key.');
  process.exit(2);
}

const gql = async (query) => {
  const res = await fetch(net.indexerUrl, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({query}),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
};
const hexToBytes = (h) => {
  const c = h.replace(/^0x/, '');
  const o = new Uint8Array(c.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = Number.parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return o;
};
const bytesToHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

console.log(`\nwarp-restore — wallet "${walletName}" on ${networkId} at block ${height}${dryRun ? '  (dry run)' : ''}`);

// ── the wallet's dust key ───────────────────────────────────────────────────
const manager = new WalletManager(new FilesystemStorageAdapter());
let unlocked;
try {
  unlocked = await manager.unlock(walletName, process.env.MOTH_PASSPHRASE);
} catch (err) {
  // A missing wallet and a wrong passphrase are different problems and the
  // message should say which, rather than printing a stack.
  console.error(`\n  ✗ could not unlock "${walletName}": ${err instanceof Error ? err.message : err}`);
  console.error('    Check the name with `moth wallet list` and MOTH_PASSPHRASE.');
  process.exit(1);
}
const dustPublicKey = unlocked.walletKeys.dustSecretKey.publicKey;
console.log(`  dust public key ${String(dustPublicKey).slice(0, 24)}…`);

// ── refuse to clobber ───────────────────────────────────────────────────────
const store = new NodeSyncStateStore();
const key = syncStateKey(networkId, walletName, 'dust');
const existing = await store.get(key);
if (existing && !overwrite) {
  console.log(`\n  ✗ "${walletName}" already has a dust cache (${existing.length} chars).`);
  console.log('    Pass --overwrite to replace it, or use a wallet with no dust history.');
  unlocked.lock();
  process.exit(1);
}

// ── the trees ───────────────────────────────────────────────────────────────
const {block} = await gql(`{ block(offset:{height:${height}}) { dustCommitmentEndIndex dustGenerationEndIndex } }`);
if (!block) { console.log('  ✗ that block is not readable'); unlocked.lock(); process.exit(1); }
console.log(`  commitEnd=${block.dustCommitmentEndIndex} genEnd=${block.dustGenerationEndIndex}`);

const updates = {};
for (const [label, query, end] of [
  ['generation', 'dustGenerationMerkleTreeUpdate', block.dustGenerationEndIndex],
  ['commitment', 'dustCommitmentMerkleTreeUpdate', block.dustCommitmentEndIndex],
]) {
  const data = await gql(`{ ${query}(startIndex:0, endIndex:${end}) { update } }`);
  const u = data[query]?.update;
  if (!u) { console.log(`  ✗ no ${label} update returned`); unlocked.lock(); process.exit(1); }
  updates[label] = u;
  console.log(`  ${label} update ${u.length / 2} bytes`);
}

let state = new ledger.DustLocalState(new ledger.DustParameters(5n, 1n, 604800n));
state = state.applyGenerationCollapsedUpdate(ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(hexToBytes(updates.generation)));
state = state.applyCommitmentCollapsedUpdate(ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(hexToBytes(updates.commitment)));
console.log(`  applied both; commitmentTreeRoot=${String(state.commitmentTreeRoot()).slice(0, 20)}…`);

// ── the resume point ────────────────────────────────────────────────────────
// The wallet's cursor is an EVENT STREAM index; the trees are indexed by
// commitment and generation. Those are different counters, so the resume point
// is estimated and biased LOW — the wallet then replays a few thousand events it
// already has, which is harmless. Biasing high would skip events, which is not.
const estimate = await dustCursorAtHeight(net.indexerUrl, height);
if (!estimate) { console.log('  ✗ cannot estimate a resume cursor for that height'); unlocked.lock(); process.exit(1); }
console.log(`  resume cursor ${estimate.stopAt} (approx ${estimate.approxCursor} less ${estimate.margin} slack)`);

const snapshot = JSON.stringify({
  publicKey: {publicKey: String(dustPublicKey)},
  state: bytesToHex(state.serialize()),
  protocolVersion: 4,
  networkId,
  offset: String(estimate.stopAt),
});
console.log(`  snapshot ${snapshot.length} chars (a replayed one is ~10.9M)`);

if (dryRun) {
  console.log('\n  dry run — nothing written.');
} else {
  await store.put(key, snapshot);
  console.log(`\n  ✓ written to ${key}`);
}
unlocked.lock();

console.log(`
next:
  1. moth balance --wallet ${walletName} --network ${networkId} --verbose
     Watch for "Restoring dust state from cache" and where dust resumes.
  2. Compare the NIGHT and DUST figures against the same wallet synced the slow way.
  3. moth transfer 1 --to <an address you control> --wallet ${walletName} --network ${networkId} --yes
     This is the real test: the fee proof uses the dust tree, so a tree that
     reads correctly but proves wrongly fails HERE and nowhere earlier.`);

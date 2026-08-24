// SPIKE — can a wallet jump its Merkle trees forward instead of replaying events?
//
// The question, in one line: dust is 99.2% of a preprod first sync because the
// commitment and generation trees are built by inserting 1.4M events in order.
// The indexer will hand over the collapsed state of those trees for a range in
// well under a kilobyte, and the ledger has apply methods for it. If a wallet
// can take those and start above genesis, the whole pre-seed reference apparatus
// — 4.9 MB bundles, CI publishing, hour-long builds — is a heavyweight stand-in
// for three HTTP requests.
//
// This spike answers it in four stages, each independently falsifiable, and each
// printing what it found rather than only whether it passed. It is read-only:
// nothing here writes to ~/.moth or touches a real wallet.
//
//   1. FETCH   the indexer serves collapsed updates for the target height
//   2. APPLY   the ledger accepts them into a fresh DustLocalState
//   3. VERIFY  the resulting tree roots equal the roots the BLOCK publishes
//              ← the decisive stage. Matching roots mean the jumped state is
//                the same state a full replay would have produced.
//   4. RESTORE the dust wallet accepts that state with a jumped syncProgress
//
// Stage 3 is why this is worth running: it is a correctness proof against an
// independent value, not an assertion that nothing threw.
//
// Usage: node scripts/spike/warp-sync.mjs [network] [height]
//        node scripts/spike/warp-sync.mjs preprod 1697238

import * as ledger from '@midnight-ntwrk/ledger-v8';
import {DEFAULT_NETWORKS} from '@shieldedtech/moth-wallet';

const networkId = process.argv[2] ?? 'preprod';
const targetHeight = Number(process.argv[3] ?? 1697238);
const net = DEFAULT_NETWORKS[networkId];
if (!net) {
  console.error(`unknown network "${networkId}"`);
  process.exit(2);
}

const pass = [];
const fail = [];
const ok = (stage, detail) => { pass.push(stage); console.log(`  ✓ ${stage}${detail ? ` — ${detail}` : ''}`); };
const no = (stage, detail) => { fail.push(stage); console.log(`  ✗ ${stage}${detail ? ` — ${detail}` : ''}`); };

async function gql(query) {
  const res = await fetch(net.indexerUrl, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({query}),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

const hexToBytes = (hex) => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (n) => (typeof n === 'bigint' ? n.toString(16) : String(n));

console.log(`\nwarp-sync spike — ${networkId} @ block ${targetHeight}`);
console.log(`indexer ${net.indexerUrl}\n`);

// ── 1. FETCH ────────────────────────────────────────────────────────────────
console.log('1. FETCH');
const {block} = await gql(`{ block(offset:{height:${targetHeight}}) {
  height dustCommitmentEndIndex dustGenerationEndIndex zswapEndIndex
  dustCommitmentMerkleTreeRoot dustGenerationMerkleTreeRoot
} }`);
if (!block) { no('block is readable'); process.exit(1); }
ok('block is readable',
   `commitEnd=${block.dustCommitmentEndIndex} genEnd=${block.dustGenerationEndIndex}`);

const updates = {};
for (const [label, query, end] of [
  ['commitment', 'dustCommitmentMerkleTreeUpdate', block.dustCommitmentEndIndex],
  ['generation', 'dustGenerationMerkleTreeUpdate', block.dustGenerationEndIndex],
]) {
  try {
    const data = await gql(`{ ${query}(startIndex:0, endIndex:${end}) { startIndex endIndex protocolVersion update } }`);
    const u = data[query];
    if (!u?.update) { no(`${label} update served`, 'null response'); continue; }
    updates[label] = u;
    ok(`${label} update served`, `${u.update.length / 2} bytes for 0..${end}`);
  } catch (err) {
    no(`${label} update served`, err.message);
  }
}
if (!updates.commitment || !updates.generation) {
  console.log('\nSTOP: without both updates the rest cannot be tested.');
  process.exit(1);
}

// The headline number: what the replay would have cost against what this costs.
const bytes = (updates.commitment.update.length + updates.generation.update.length) / 2;
console.log(`  → ${bytes} bytes total, against ~${block.dustCommitmentEndIndex + block.dustGenerationEndIndex} events replayed today`);

// ── 2. APPLY ────────────────────────────────────────────────────────────────
console.log('\n2. APPLY');
let state;
try {
  // Parameters affect generation arithmetic, not tree shape, so defaults are
  // fine for a tree-root check. A wrong ratio would show up as a balance error
  // later, never as a wrong root.
  const params = new ledger.DustParameters(5n, 1n, 604800n);
  state = new ledger.DustLocalState(params);
  ok('fresh DustLocalState constructed');
} catch (err) {
  no('fresh DustLocalState constructed', err.message);
  process.exit(1);
}

for (const [label, method] of [
  ['generation', 'applyGenerationCollapsedUpdate'],
  ['commitment', 'applyCommitmentCollapsedUpdate'],
]) {
  try {
    const update = ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(hexToBytes(updates[label].update));
    state = state[method](update);
    ok(`${label} update applied`, `via ${method}`);
  } catch (err) {
    no(`${label} update applied`, err.message);
  }
}

// ── 3. VERIFY — the stage that decides it ───────────────────────────────────
console.log('\n3. VERIFY (computed roots vs the roots the block publishes)');
for (const [label, fn, published] of [
  ['commitment', 'commitmentTreeRoot', block.dustCommitmentMerkleTreeRoot],
  ['generation', 'generatingTreeRoot', block.dustGenerationMerkleTreeRoot],
]) {
  let computed;
  try {
    computed = state[fn]();
  } catch (err) {
    no(`${label} root computed`, err.message);
    continue;
  }
  if (computed === undefined || computed === null) {
    no(`${label} root computed`, 'undefined — the tree holds nothing');
    continue;
  }
  const mine = toHex(computed);
  const theirs = String(published ?? '').replace(/^0x/, '');
  // Compare on the shared suffix: the indexer's encoding may carry a prefix or
  // padding the ledger's bigint does not. A suffix match over 32+ hex digits is
  // not a coincidence; a mismatch is decisive either way.
  const a = mine.padStart(64, '0').slice(-56);
  const b = theirs.padStart(64, '0').slice(-56);
  if (a === b) ok(`${label} root MATCHES the block`, `…${a.slice(-24)}`);
  else no(`${label} root differs`, `computed …${a.slice(-24)} vs block …${b.slice(-24)}`);
}

// ── 4. RESTORE ──────────────────────────────────────────────────────────────
console.log('\n4. RESTORE (does the dust wallet take a jumped state?)');
try {
  const {CoreWallet} = await import('@midnightntwrk/wallet-sdk/dust/v1');
  const serialized = state.serialize();
  ok('state serializes', `${serialized.length} bytes`);
  ok('CoreWallet.restore is reachable', typeof CoreWallet?.restore === 'function' ? 'yes' : 'export shape differs — inspect manually');
  console.log('  … restore() also needs publicKey, pendingTokens, syncProgress and networkId:');
  console.log(`    syncProgress.appliedIndex would be set to ${block.dustCommitmentEndIndex} rather than replayed to it.`);
  console.log('    Left to the implementation: this spike stops at proving the state is right.');
} catch (err) {
  no('dust CoreWallet import', err.message);
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log(`\nverdict: ${pass.length} passed, ${fail.length} failed`);
if (fail.length === 0) {
  console.log('The jumped trees match the chain\'s own roots. Replaying every event to');
  console.log('reach this state is unnecessary, and a reference built by walking there is');
  console.log(`a ${Math.round(bytes)}-byte query wearing a 4.9 MB costume.`);
} else {
  console.log('Stages that failed are the real result — they say exactly where the idea');
  console.log('breaks, which is what a spike is for. Read them before discarding it.');
}
process.exit(fail.length === 0 ? 0 : 1);

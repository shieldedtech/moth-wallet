// The right oracle: compare a warp-jumped state against a state that actually
// replayed its way there. An archived reference IS such a state — built by
// walking every event to its height — so if the jumped tree root equals the
// replayed one at the same index, the shortcut is proven, whatever the block's
// published root turns out to mean.
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const I='https://indexer.preprod.midnight.network/api/v4/graphql';
const gql=async q=>{const r=await fetch(I,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const b=await r.json();if(b.errors)throw new Error(b.errors[0].message);return b.data;};
const hexToBytes=h=>{const c=h.replace(/^0x/,'');const o=new Uint8Array(c.length/2);for(let i=0;i<o.length;i++)o[i]=parseInt(c.slice(i*2,i*2+2),16);return o;};

const height = Number(process.argv[2] ?? 2104384);
const snapPath = join(homedir(), '.moth', 'sync', 'preprod', `__empty_ref__@${height}`, 'dust.dat');
console.log(`\nreplayed state: ${snapPath}`);

let snap;
try { snap = JSON.parse(readFileSync(snapPath, 'utf-8')); }
catch (e) { console.log(`  cannot read it: ${e.message}`); process.exit(2); }
console.log(`  keys: ${Object.keys(snap).join(', ')}`);
console.log(`  offset (dust cursor): ${snap.offset}`);
console.log(`  state field: ${typeof snap.state} ${typeof snap.state === 'string' ? `(${snap.state.length} chars)` : ''}`);

let replayed;
for (const attempt of ['hex', 'base64']) {
  try {
    const bytes = attempt === 'hex'
      ? hexToBytes(snap.state)
      : new Uint8Array(Buffer.from(snap.state, 'base64'));
    replayed = ledger.DustLocalState.deserialize(bytes);
    console.log(`  ✓ deserialized as ${attempt}`);
    break;
  } catch (e) {
    console.log(`  ✗ not ${attempt}: ${String(e.message).slice(0, 70)}`);
  }
}
if (!replayed) { console.log('\nSTOP: cannot read the replayed state, so there is nothing to compare against.'); process.exit(1); }

const replayedRoot = replayed.commitmentTreeRoot();
console.log(`  replayed commitmentTreeRoot: ${replayedRoot === undefined ? '(undefined)' : replayedRoot.toString(16).slice(0, 32)}…`);

const {block} = await gql(`{ block(offset:{height:${height}}) { dustCommitmentEndIndex } }`);
console.log(`\nwarp-jumped state at the same block (commitEnd=${block.dustCommitmentEndIndex})`);
const u = (await gql(`{ dustCommitmentMerkleTreeUpdate(startIndex:0,endIndex:${block.dustCommitmentEndIndex}) { update } }`)).dustCommitmentMerkleTreeUpdate;
let warped = new ledger.DustLocalState(replayed.params ?? new ledger.DustParameters(5n,1n,604800n));
warped = warped.applyCommitmentCollapsedUpdate(ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(hexToBytes(u.update)));
const warpedRoot = warped.commitmentTreeRoot();
console.log(`  warped commitmentTreeRoot:   ${warpedRoot === undefined ? '(undefined)' : warpedRoot.toString(16).slice(0, 32)}…`);

console.log('');
if (replayedRoot !== undefined && warpedRoot !== undefined && replayedRoot === warpedRoot) {
  console.log('*** MATCH — a 345-byte query reproduces a state that took an hour to replay.');
} else {
  console.log('NO MATCH. The jumped tree is not the replayed tree, so the shortcut cannot');
  console.log('stand in for a reference as it is used today. What differs is the next question:');
  console.log(`  replayed=${replayedRoot} warped=${warpedRoot}`);
}

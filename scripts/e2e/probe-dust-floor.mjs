// Measure the premise behind "sync DUST from the designation forward".
//
// DUST is non-transferable and only comes into existence through generation,
// which requires registration. So the earliest generation entry for a dust
// address is a hard lower bound on when this wallet could hold any dust — and
// unlike a shielded birthday it is address-indexed, so it is provable rather
// than asserted.
//
// Usage: node scripts/e2e/probe-dust-floor.mjs <networkId> <dustAddress>
import {DEFAULT_NETWORKS, dustGenerationsFor, heightForDate, chainTip} from '@shieldedtech/moth-wallet';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

const [networkId, dustAddress] = process.argv.slice(2);
const net = DEFAULT_NETWORKS[networkId];
if (!net || !dustAddress) {
  console.error('usage: probe-dust-floor.mjs <networkId> <dustAddress>');
  process.exit(2);
}

const tip = await chainTip(net.indexerUrl);
console.log(`network        ${networkId}`);
console.log(`chain tip      ${tip?.height ?? '(unreadable)'}`);

// What references this machine holds, for the comparison that matters.
const refDir = join(homedir(), '.moth', 'empty-ref', networkId);
let live = null, archived = [];
try { live = Number(readFileSync(join(refDir, 'height.txt'), 'utf-8').trim()); } catch {}
try { archived = JSON.parse(readFileSync(join(refDir, 'archive.json'), 'utf-8')); } catch {}
console.log(`live reference ${live ?? '(none)'}`);
console.log(`archived       ${archived.length ? archived.join(', ') : '(none)'}`);

console.log('\nquerying dust generation entries (this is the whole idea)…');
const started = Date.now();
const result = await dustGenerationsFor(net.indexerUrl, dustAddress, {timeoutMs: 45_000, endIndex: 2_000_000_000});
console.log(`  entries=${result.entries.length} decayUpdates=${result.dtimeUpdates} truncated=${result.truncated} in ${Date.now() - started}ms`);

if (result.entries.length === 0) {
  console.log('\nNo generation entries — this wallet has never registered NIGHT for DUST');
  console.log('generation, so it can hold no dust and any reference is safe for the dust part.');
  process.exit(0);
}

const earliest = result.entries.reduce((a, b) => (a.ctime <= b.ctime ? a : b));
const when = new Date(earliest.ctime * 1000);
console.log(`\nearliest generation entry`);
console.log(`  ctime        ${earliest.ctime}  (${when.toISOString()})`);
console.log(`  backingNight ${earliest.backingNight ?? '?'}`);
console.log(`  tx           ${earliest.transactionHash ?? '?'}`);

const floor = await heightForDate(net.indexerUrl, when);
console.log(`  → height     ${floor.height} (block at or before that time)`);

console.log('\nverdict');
const usable = [live, ...archived].filter((h) => typeof h === 'number' && h <= floor.height);
if (usable.length > 0) {
  console.log(`  a reference at ${Math.max(...usable)} is at or below the dust floor ${floor.height}.`);
  console.log('  → the dust sub-wallet could seed from it TODAY, with no new reference built.');
} else {
  console.log(`  no reference at or below the dust floor ${floor.height}.`);
  console.log('  → dust would still walk from genesis; this wallet needs an older reference.');
}

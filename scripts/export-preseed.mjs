#!/usr/bin/env node
//
// Export a built pre-seed reference into the extension package
// ============================================================
// Copies the reference for a network out of the local sync store (~/.moth) and
// into packages/extension/public/preseed/<network>/, where the extension build
// picks it up as a package resource. The extension loads it into IndexedDB on
// first sync, so a fresh install starts near tip instead of walking the chain.
//
// Measured on preprod with a reference 59,236 blocks stale: 103.1s to fully
// synced, against 78.6 min with no reference at all. Staleness costs catch-up
// time, not correctness — the wallet syncs forward from the reference height —
// so a reference cut at release time stays useful for as long as the release does.
//
// The manifest also records a WITNESS per cursor-bearing part: the hash of the
// event the cursor points at, read from the indexer at export time. Cursors are
// indexer-assigned event sequence numbers, so a bundle records a number whose
// meaning lives entirely in the indexer that issued it — when preprod's dust id
// space stopped having a 22-event hole, every cursor written under the old
// numbering silently began naming a different event, this bundle's included.
// Checksums cannot catch that; they prove the bytes arrived, which was never the
// failure. A consumer compares the witness against its own indexer and refuses
// the reference if the event has moved. See ADR 0004 and issue #40.
//
// Files are gzipped individually rather than bundled into one JSON: the state
// blobs are already JSON, and nesting them as JSON string values would escape
// every quote in a 10 MB document before compression ever saw it.
//
// Usage:
//   node scripts/export-preseed.mjs                  # preprod
//   node scripts/export-preseed.mjs --network preview
//   node scripts/export-preseed.mjs --check          # report, write nothing
//
// Build one first if the network has none:
//   node scripts/sync-benchmark.mjs --warm-reference --network <net> --timeout 9000
//
// Exit codes: 0 exported (or --check passed), 1 no usable reference, 2 bad usage.

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    network: { type: 'string', default: 'preprod' },
    check: { type: 'boolean', default: false },
  },
});

const core = await import('@shieldedtech/moth-wallet');
const { DEFAULT_NETWORKS, resolveSyncStore, emptyRefStateKey, emptyRefHeightKey, IndexerClient, readEventWitness } = core;

const network = DEFAULT_NETWORKS[values.network];
if (!network) {
  console.error(`Unknown network "${values.network}". Known: ${Object.keys(DEFAULT_NETWORKS).join(', ')}`);
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'packages/extension/public/preseed', network.id);

const store = await resolveSyncStore();
const height = (await store.get(emptyRefHeightKey(network.id)))?.trim();

if (!height || !Number.isFinite(Number(height)) || Number(height) <= 0) {
  console.error(
    `No recorded height for ${network.id} — the reference is unusable without one.\n` +
      `Build it first:\n  node scripts/sync-benchmark.mjs --warm-reference --network ${network.id} --timeout 9000`,
  );
  process.exit(1);
}

const PARTS = ['shielded', 'unshielded', 'dust'];
const states = {};
for (const part of PARTS) {
  const value = await store.get(emptyRefStateKey(network.id, part));
  if (!value) {
    console.error(`Reference for ${network.id} is missing its ${part} state — refusing to export a partial one.`);
    process.exit(1);
  }
  states[part] = value;
}

// How stale the export is, so the number is recorded rather than guessed at
// later. Purely informational — a stale reference is valid, just slower.
let staleBy = null;
try {
  const tip = await new IndexerClient(network.indexerUrl).getBlock();
  if (tip?.height) staleBy = tip.height - Number(height);
} catch {
  /* indexer unreachable — the export is still valid */
}

console.log(`network:  ${network.id}`);
console.log(`height:   ${height}${staleBy === null ? '' : `  (${staleBy} blocks behind tip at export)`}`);

// Which stream each cursor indexes into. Only shielded and dust ride the
// indexer's global ledger-event numbering; unshielded is keyed by address, so
// there is no id to witness.
const WITNESS_STREAMS = { shielded: 'zswapLedgerEvents', dust: 'dustLedgerEvents' };

/** The cursor a serialized snapshot resumes from. */
const cursorOf = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return parsed.offset === undefined ? 0 : Number(parsed.offset);
  } catch {
    return 0;
  }
};

const witnesses = {};
for (const [part, stream] of Object.entries(WITNESS_STREAMS)) {
  const id = cursorOf(states[part]);
  if (!Number.isFinite(id) || id <= 0) {
    console.error(`  ${part.padEnd(11)} cursor is ${id} — refusing to export a reference whose cursor is unusable`);
    process.exit(1);
  }
  let witness;
  try {
    witness = await readEventWitness(network.indexerUrl, stream, id);
  } catch (err) {
    console.error(`  ${part.padEnd(11)} could not read the event at id ${id}: ${err}`);
    console.error('Refusing to export without witnesses — a bundle nobody can verify is how #40 shipped.');
    process.exit(1);
  }
  if (!witness) {
    console.error(`  ${part.padEnd(11)} no event at or after id ${id} on ${network.indexerUrl}.`);
    console.error('That means this reference is AHEAD of the indexer it is being exported against, which');
    console.error('is the renumbering signal itself. Rebuild from genesis rather than exporting this.');
    process.exit(1);
  }
  witnesses[part] = witness;
  console.log(`  ${part.padEnd(11)} cursor ${String(witness.id).padStart(9)}  witness ${witness.digest}`);
}

let total = 0;
const manifest = { network: network.id, height: Number(height), parts: {}, witnesses };
for (const part of PARTS) {
  const raw = Buffer.from(states[part], 'utf8');
  const gz = gzipSync(raw, { level: 9 });
  manifest.parts[part] = { bytes: raw.byteLength, gzipBytes: gz.byteLength };
  total += gz.byteLength;
  console.log(
    `  ${part.padEnd(11)} ${(raw.byteLength / 1024 / 1024).toFixed(2).padStart(6)} MB  ->` +
      ` ${(gz.byteLength / 1024 / 1024).toFixed(2).padStart(6)} MB gzipped`,
  );
  if (!values.check) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${part}.dat.gz`), gz);
  }
}

console.log(`  ${'TOTAL'.padEnd(11)} ${''.padStart(6)}     ${(total / 1024 / 1024).toFixed(2).padStart(6)} MB added to the package`);

if (values.check) {
  console.log('\n--check: nothing written.');
  process.exit(0);
}

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// A stale export is fine; a stale one nobody noticed is not. Leave the number
// where the next person looking at the directory will see it.
console.log(`\nwrote ${outDir}`);
console.log('re-run after rebuilding the reference to refresh it before a release.');

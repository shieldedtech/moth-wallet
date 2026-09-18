#!/usr/bin/env node
//
// Collapse the DUST trees in pre-seed bundles
// ===========================================
// Rewrites a bundle's dust.dat.gz with its generation and commitment Merkle trees
// collapsed, and updates the manifest's record of that file. On preprod the dust
// state goes from 5,474,535 bytes to ~3.7 KB, and the DustLocalState.deserialize
// every wallet seeded from it runs on each launch goes from ~57s to milliseconds.
// Nothing else changes: height, witnesses, cursor and the other two parts are the
// same bytes as before.
//
// Why the trees need collapsing, and the proof that a collapsed reference syncs
// forward exactly as the original: packages/core/src/sync/dust-reference-collapse.ts.
// The checks run before anything is written: scripts/lib/collapse-preseed.mjs.
//
// scripts/export-preseed.mjs collapses on the way out, so a freshly exported
// bundle is already collapsed and this is a no-op on it. Use this for a bundle cut
// some other way, and `--check` to prove a bundle is collapsed and valid — which
// is how CI guards the committed bundles and the prepared artifacts.
//
// Usage:
//   node scripts/collapse-preseed.mjs                       # every bundle the extension ships
//   node scripts/collapse-preseed.mjs --network preprod     # one of them
//   node scripts/collapse-preseed.mjs --dir <bundle-dir>    # any bundle directory
//   node scripts/collapse-preseed.mjs --check               # verify only; write nothing
//   node scripts/collapse-preseed.mjs --json                # machine-readable report
//
// Needs the core package built (`yarn workspace @shieldedtech/moth-wallet build`).
// No indexer, no sync store, no chain walk.
//
// Exit codes: 0 every bundle collapsed and valid, 1 a bundle was refused (or, with
// --check, is not collapsed), 2 bad usage.

import {existsSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {BundleCheckError, collapseBundle} from './lib/collapse-preseed.mjs';

let values;
try {
  ({values} = parseArgs({
    options: {
      network: {type: 'string'},
      dir: {type: 'string'},
      check: {type: 'boolean', default: false},
      json: {type: 'boolean', default: false},
    },
  }));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (values.network && values.dir) {
  console.error('Pass --network or --dir, not both.');
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const preseedRoot = join(repoRoot, 'packages/extension/public/preseed');

const targets = values.dir
  ? [{dir: resolve(values.dir), network: undefined}]
  : (values.network
      ? [values.network]
      : existsSync(preseedRoot)
        ? readdirSync(preseedRoot, {withFileTypes: true})
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
        : []
    ).map((network) => ({dir: join(preseedRoot, network), network}));

if (targets.length === 0) {
  console.error(`No bundles found under ${preseedRoot}.`);
  process.exit(1);
}

const core = await import('@shieldedtech/moth-wallet');

const reports = [];
let refused = 0;
for (const {dir, network} of targets) {
  if (!values.json) console.log(`\n${network ?? dir}`);
  try {
    const report = collapseBundle(dir, {
      collapseDustReference: core.collapseDustReference,
      inspectDustSnapshot: core.inspectDustSnapshot,
      network,
      check: values.check,
    });
    reports.push({dir, ok: true, ...report});
    if (!values.json) {
      console.log(`  height            ${report.height}   dust cursor ${report.cursor}`);
      console.log(`  dust state        ${report.stateBytesBefore} B -> ${report.stateBytesAfter} B`);
      console.log(`  dust.dat.gz       ${report.gzipBytesBefore} B -> ${report.gzipBytesAfter} B`);
      console.log(`  frontiers         generation ${report.generationFirstFree}, commitment ${report.commitmentFirstFree}`);
      console.log(`  roots unchanged   generation ${report.generationRoot}`);
      console.log(`                    commitment ${report.commitmentRoot}`);
      console.log(
        values.check
          ? '  checked: collapsed and valid'
          : report.wrote
            ? '  written'
            : '  already collapsed; nothing to write',
      );
    }
  } catch (err) {
    refused += 1;
    reports.push({dir, ok: false, error: err.message});
    if (!values.json) console.error(`  ${err instanceof BundleCheckError ? 'REFUSED' : 'FAILED'}: ${err.message}`);
  }
}

if (values.json) console.log(JSON.stringify(reports, null, 2));
if (refused > 0) {
  if (!values.json) console.error(`\n${refused} bundle(s) refused. Nothing was written for them.`);
  process.exit(1);
}

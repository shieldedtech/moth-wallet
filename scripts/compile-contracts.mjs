#!/usr/bin/env node
// Compiles the Compact contracts with the compiler version pinned in
// midnight-versions.json, via the `compact +<version>` toolchain selector.
//
// The compiler is not an npm dependency, so nothing else in the repo can pin
// it. Compiling with whatever `compact` happens to have installed is how you
// get artifacts that call checkRuntimeVersion('0.19.0') against an SDK that
// pins compact-runtime 0.16.0 — the contract deploys and then fails on call.
//
// Usage:
//   node scripts/compile-contracts.mjs [--skip-zk] [--out <dir>]
//
// --out redirects output (for scratch builds); default is the committed
// managed/ directory beside each contract source.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const train = JSON.parse(readFileSync(join(ROOT, 'midnight-versions.json'), 'utf8'));

const CONTRACTS = [
  {
    source: 'packages/core/contracts/moth-ft/moth-ft.compact',
    out: 'packages/core/contracts/moth-ft/managed',
  },
];

const argv = process.argv.slice(2);
const skipZk = argv.includes('--skip-zk');
const outIndex = argv.indexOf('--out');
const outOverride = outIndex === -1 ? null : argv[outIndex + 1];

if (outIndex !== -1 && !outOverride) {
  console.error('--out requires a directory argument');
  process.exit(2);
}

let failed = false;
for (const contract of CONTRACTS) {
  const out = outOverride ?? contract.out;
  const args = [
    'compile',
    `+${train.compiler}`,
    ...(skipZk ? ['--skip-zk'] : []),
    contract.source,
    out,
  ];
  console.log(`compact ${args.join(' ')}`);
  const result = spawnSync('compact', args, {cwd: ROOT, stdio: 'inherit'});
  if (result.error) {
    console.error(
      `\nCould not run \`compact\`: ${result.error.message}\n` +
      `Install the Compact CLI, then \`compact update ${train.compiler}\`.`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    failed = true;
    console.error(`\n${contract.source} failed to compile (exit ${result.status}).`);
    console.error(
      `If this is a language-version error, note that compiler ` +
      `${train.compiler} caps the language version at ` +
      `${train.languageVersion} — the contract's \`pragma language_version\` ` +
      `must not exceed it.`,
    );
  }
}
process.exit(failed ? 1 : 0);

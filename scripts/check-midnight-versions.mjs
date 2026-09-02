#!/usr/bin/env node
// Verifies everything about the Midnight version train that `yarn constraints`
// structurally cannot see.
//
// Constraints operate on workspace *manifests*. Three things live outside them:
//
//   1. The resolved dependency tree. An upstream package's own caret range can
//      still pull a second copy of a WASM-backed module, which breaks
//      `instanceof` at call time (`expected instance of StateValue`) with a
//      perfectly clean install and type-check.
//   2. The Compact compiler, which is not an npm dependency at all — it is a
//      separate binary selected with `compact +<version>`. Its committed
//      artifacts embed the runtime version they demand via checkRuntimeVersion.
//   3. Scaffolding templates, which are not workspaces, so nothing installs or
//      type-checks them until a user runs the generated project.
//
// Usage: node scripts/check-midnight-versions.mjs
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative} from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

const train = readJson('midnight-versions.json');
const problems = [];
const note = (section, msg) => problems.push(`${section}: ${msg}`);

// ── 1. One resolved version per WASM-backed package ────────────────────────
console.log('Resolved dependency tree (single-instance packages)');
const lock = read('yarn.lock');
const resolved = new Map();
for (const [, ident, version] of lock.matchAll(
  /^ {2}resolution: "((?:@[^/]+\/)?[^@"]+)@npm:([^"]+)"/gm,
)) {
  if (!train.singleInstance.includes(ident)) continue;
  if (!resolved.has(ident)) resolved.set(ident, new Set());
  resolved.get(ident).add(version);
}

for (const pkg of train.singleInstance) {
  const versions = resolved.get(pkg);
  if (!versions) {
    console.log(`  – ${pkg} (not installed)`);
    continue;
  }
  const list = [...versions].sort();
  if (list.length > 1) {
    console.log(`  ✗ ${pkg}: ${list.length} versions — ${list.join(', ')}`);
    note(
      'tree',
      `${pkg} resolves to ${list.length} versions (${list.join(', ')}). ` +
      `Duplicate WASM instances fail \`instanceof\` at call time. Add an ` +
      `exact "resolutions" entry for it in the root package.json.`,
    );
  } else {
    const want = train.npm[pkg];
    if (want !== undefined && list[0] !== want) {
      console.log(`  ✗ ${pkg}: ${list[0]} (train declares ${want})`);
      note('tree', `${pkg} resolved to ${list[0]} but the train declares ${want}.`);
    } else {
      console.log(`  ✓ ${pkg}: ${list[0]}`);
    }
  }
}

// ── 2. Committed contract artifacts match the pinned toolchain ─────────────
console.log('\nCompiled contract artifacts');
for (const artifact of train.artifacts) {
  if (!existsSync(join(ROOT, artifact))) {
    console.log(`  ✗ ${artifact} (missing)`);
    note('artifact', `${artifact} does not exist. Run \`yarn compile:contracts\`.`);
    continue;
  }
  const info = readJson(artifact);
  const expected = {
    'compiler-version': train.compiler,
    'language-version': train.languageVersion,
    'runtime-version': train.npm['@midnight-ntwrk/compact-runtime'],
  };
  const bad = Object.entries(expected).filter(([k, v]) => info[k] !== v);
  if (bad.length === 0) {
    console.log(
      `  ✓ ${artifact} (compiler ${info['compiler-version']}, ` +
      `language ${info['language-version']}, runtime ${info['runtime-version']})`,
    );
  } else {
    console.log(`  ✗ ${artifact}`);
    for (const [k, v] of bad) {
      console.log(`      ${k}: found ${info[k] ?? '(absent)'}, expected ${v}`);
      note(
        'artifact',
        `${artifact} ${k} is ${info[k] ?? '(absent)'} but the train declares ${v}. ` +
        `Recompile with \`yarn compile:contracts\` (which pins compact +${train.compiler}).`,
      );
    }
  }
}

// ── 3. Scaffolding templates carry real, in-train versions ─────────────────
// Templates are not workspaces, so `yarn constraints` never sees them and
// nothing installs them until a user runs the generated project. Note that a
// placeholder in a *non-dependency* field (e.g. "name") is legitimate — those
// are per-project. Only dependency versions must be concrete.
console.log('\nScaffolding templates');
for (const template of train.templates) {
  if (!existsSync(join(ROOT, template))) {
    console.log(`  \u2717 ${template} (missing)`);
    note('template', `${template} listed in midnight-versions.json does not exist.`);
    continue;
  }
  const manifest = readJson(template);
  const deps = {...manifest.dependencies, ...manifest.devDependencies};

  const placeholders = Object.entries(deps).filter(([, v]) => /\{\{.+\}\}/.test(v));
  const drift = Object.entries(deps).filter(
    ([k, v]) => train.npm[k] !== undefined && v !== train.npm[k] && !/\{\{.+\}\}/.test(v),
  );
  const unknown = Object.keys(deps).filter(
    (k) => k.startsWith('@midnight') && train.npm[k] === undefined,
  );

  if (placeholders.length === 0 && drift.length === 0 && unknown.length === 0) {
    console.log(`  \u2713 ${template}`);
    continue;
  }
  console.log(`  \u2717 ${template}`);
  for (const [k, v] of placeholders) {
    console.log(`      ${k}: unsubstituted ${v}`);
    note(
      'template',
      `${template} leaves ${k} as ${v}. Nothing in this repo substitutes ` +
      `dependency placeholders, so a scaffolded project would fail to ` +
      `install. Replace it with the pinned version from the train.`,
    );
  }
  for (const [k, v] of drift) {
    console.log(`      ${k}: ${v}, expected ${train.npm[k]}`);
    note('template', `${template} pins ${k} at ${v}; train declares ${train.npm[k]}.`);
  }
  for (const k of unknown) {
    console.log(`      ${k}: not in the train`);
    note('template', `${template} depends on ${k}, absent from midnight-versions.json.`);
  }
}

// ── 4. Root resolutions cover every single-instance package ───────────────
// Yarn resolutions have to be literal in package.json, so they cannot be
// derived from the train at install time. Verify them instead, or they become
// a second source of truth that silently drifts.
console.log('\nRoot resolutions');
const rootResolutions = readJson('package.json').resolutions ?? {};
for (const pkg of train.singleInstance) {
  const want = train.npm[pkg];
  const found = rootResolutions[pkg];
  if (found === want) {
    console.log(`  \u2713 ${pkg}: ${found}`);
  } else if (found === undefined) {
    console.log(`  \u2717 ${pkg}: no resolution`);
    note(
      'resolutions',
      `${pkg} is single-instance but has no "resolutions" entry in the root ` +
      `package.json. Add "${pkg}": "${want}".`,
    );
  } else {
    console.log(`  \u2717 ${pkg}: ${found}, expected ${want}`);
    note(
      'resolutions',
      `root package.json resolves ${pkg} to ${found} but the train declares ${want}.`,
    );
  }
}

// ── Verdict ────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    '\nThe Midnight compiler, runtime and SDK move as one set. Change ' +
    'midnight-versions.json, then run:\n' +
    '  yarn constraints --fix && yarn install && yarn compile:contracts\n',
  );
  process.exit(1);
}
console.log('\nMidnight version train is consistent.');

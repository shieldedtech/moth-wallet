// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const publishingRunbook = readFileSync(new URL('../NPM_PUBLISHING.md', import.meta.url), 'utf8');
const credentialPattern = /(?:SHIELDED_NPMJS_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)/;
const changesetsActionMajors = [
  ...workflow.matchAll(/uses:\s+changesets\/action@[0-9a-f]{40}\s+#\s+v(\d+)\.\d+\.\d+/g),
].map((match) => Number(match[1]));
const changesetsCliMajor = Number(rootPackage.devDependencies['@changesets/cli'].match(/\d+/)?.[0]);

const changelogFixtureRoot = mkdtempSync(resolve(tmpdir(), 'moth-release-changelogs-'));
try {
  const packageDirectory = resolve(changelogFixtureRoot, 'packages/example');
  const changelogPath = resolve(packageDirectory, 'CHANGELOG.md');
  mkdirSync(packageDirectory, {recursive: true});
  writeFileSync(changelogPath, '# Changelog\n\n- First paragraph.\n  \n  Continued paragraph.\n\t\n');

  const normalization = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'release-changelogs.mjs'), changelogFixtureRoot],
    {encoding: 'utf8'},
  );
  assert.equal(normalization.status, 0, normalization.stderr || normalization.stdout);
  assert.equal(
    readFileSync(changelogPath, 'utf8'),
    '# Changelog\n\n- First paragraph.\n\n  Continued paragraph.\n\n',
    'release changelog normalization must remove whitespace-only lines without flattening content',
  );
} finally {
  rmSync(changelogFixtureRoot, {recursive: true, force: true});
}

function requirePolicy(condition, message) {
  if (!condition) {
    throw new Error(`release policy violation: ${message}`);
  }
}

for (const packagePath of ['packages/core/package.json', 'packages/tui/package.json', 'packages/cli/package.json']) {
  const packageJson = JSON.parse(readFileSync(new URL(`../${packagePath}`, import.meta.url), 'utf8'));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };
  requirePolicy(
    !Object.values(dependencies).some((range) => range.startsWith('workspace:')),
    `${packageJson.name} must not publish workspace: dependency ranges`,
  );
  requirePolicy(
    packageJson.publishConfig?.access === 'public',
    `${packageJson.name} must explicitly publish with public npm access`,
  );
}

function job(name) {
  const marker = `  ${name}:`;
  const start = workflow.indexOf(marker);
  requirePolicy(start !== -1, `missing ${name} job`);

  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:/m);
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextJob);
}

for (const name of ['release', 'canary']) {
  const block = job(name);
  requirePolicy(block.includes('id-token: write'), `${name} must use npm Trusted Publishing`);
  requirePolicy(!credentialPattern.test(block), `${name} must not receive an npm credential`);
  requirePolicy(block.includes('npm@12.0.2'), `${name} must install the reviewed npm version`);
}

requirePolicy(
  workflow.includes('node scripts/release-packages.mjs --github-output --validate'),
  'release eligibility must use durable npm and Git tag state',
);
requirePolicy(
  workflow.includes('concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}') &&
    /^  queue: max$/mu.test(workflow),
  'release runs must queue every main push so version commits cannot be replaced while pending',
);
requirePolicy(
  workflow.includes(
    "- name: Detect incomplete package releases\n        if: ${{ steps.releases.outputs.hasReleases == 'false' }}",
  ),
  'registry reconciliation must run whenever no package release is pending',
);
requirePolicy(
  workflow.includes(
    "- name: Create or update version PR\n        if: ${{ steps.releases.outputs.hasReleases == 'true' }}",
  ) && workflow.includes('github-token: ${{ github.token }}'),
  'the version PR action must use the repository GITHUB_TOKEN and run only for releasable changesets',
);
requirePolicy(changesetsActionMajors.length === 2, 'both release paths must use the Changesets action');
requirePolicy(
  changesetsCliMajor === 3 && changesetsActionMajors.every((major) => major === 2),
  'Changesets action v2 must be paired with Changesets CLI v3',
);
requirePolicy(
  workflow.includes('version-script: yarn run version-release') &&
    workflow.includes('publish-script: yarn run release') &&
    workflow.includes('commit-message: "chore: version packages"') &&
    workflow.includes('pr-title: "chore: version packages"') &&
    !/^          (?:version|publish|commitMode|title|commit):/mu.test(workflow),
  'Changesets action inputs must use the v2 names',
);
requirePolicy(
  /publish-script:[^\S\r\n]+yarn run release\r?\n(?:[^\S\r\n]*#[^\r\n]*\r?\n)*[^\S\r\n]+push-with-git-cli:[^\S\r\n]+true/u.test(
    workflow,
  ),
  'the custom publisher must push its annotated tags with Git so recovery preserves their target commits',
);
requirePolicy(
  !workflow.includes('secrets.') && !workflow.includes('MIDNIGHTCI_PACKAGES_WRITE'),
  'the release workflow must not depend on PATs or repository secrets',
);
requirePolicy(
  !workflow.includes('steps.releases.outputs.hasChangesets') &&
    !workflow.includes('echo "hasChangesets='),
  'empty changesets must not select the version-PR path or block stable reconciliation',
);
requirePolicy(!workflow.includes('UNPUBLISHED_WORKSPACES'), 'release validation must not shuttle plan JSON through env');
requirePolicy(!workflow.includes('mapfile'), 'release validation must stay inside the release planner');
requirePolicy(!workflow.includes('github.event.before'), 'release eligibility must not depend on one push range');
requirePolicy(
  workflow.includes("steps.package_changes.outputs.hasReleaseWork == 'true'"),
  'stable publishing must require incomplete release work',
);
requirePolicy(
  rootPackage.scripts.release === 'node scripts/release-packages.mjs',
  'stable publishing must use the idempotent package reconciler',
);
requirePolicy(
  rootPackage.scripts['version-release'] ===
    'yarn run version && node scripts/release-changelogs.mjs && yarn install --mode=update-lockfile --no-immutable',
  'version PR creation must normalize changelogs before regenerating the lockfile',
);
requirePolicy(
  publishingRunbook.includes('Approve workflows') &&
    publishingRunbook.includes('GITHUB_TOKEN') &&
    !publishingRunbook.includes('MIDNIGHTCI_PACKAGES_WRITE'),
  'the secretless version-PR approval step must be documented',
);

if (workflow.includes('SHIELDED_NPMJS_TOKEN')) {
  const recovery = job('token-recovery');
  const withoutRecovery = workflow.replace(recovery, '');

  requirePolicy(workflow.includes('workflow_dispatch:'), 'token recovery must be manually dispatched');
  requirePolicy(workflow.includes('publish-with-token'), 'token recovery must require explicit confirmation');
  requirePolicy(
    recovery.includes("github.event_name == 'workflow_dispatch'") &&
      recovery.includes("github.ref == 'refs/heads/main'") &&
      recovery.includes("inputs.confirm == 'publish-with-token'"),
    'token recovery must enforce the main-branch dispatch confirmation',
  );
  requirePolicy(
    recovery.includes('NPM_TOKEN: ${{ secrets.SHIELDED_NPMJS_TOKEN }}'),
    'token recovery must scope the npm token to its own job',
  );
  requirePolicy(!credentialPattern.test(withoutRecovery), 'npm credentials must only appear in token recovery');
  requirePolicy(recovery.includes('npm@12.0.2'), 'token recovery must install the reviewed npm version');
}

console.log('release workflow policy checks passed');

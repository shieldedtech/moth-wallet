// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const publishingRunbook = readFileSync(new URL('../NPM_PUBLISHING.md', import.meta.url), 'utf8');
const credentialPattern = /(?:SHIELDED_NPMJS_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)/;

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
    "- name: Verify version PR credential\n        if: ${{ steps.releases.outputs.hasReleases == 'true' }}",
  ) &&
    workflow.includes('VERSION_PR_TOKEN: ${{ secrets.MIDNIGHTCI_PACKAGES_WRITE }}') &&
    workflow.includes('MIDNIGHTCI_PACKAGES_WRITE is unavailable'),
  'a real package release must fail clearly when its version-PR credential is unavailable',
);
requirePolicy(
  workflow.includes(
    "- name: Create or update version PR\n        if: ${{ steps.releases.outputs.hasReleases == 'true' }}",
  ),
  'the version PR action must run only for changesets that release packages',
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
  /repository-level\s+`MIDNIGHTCI_PACKAGES_WRITE`/u.test(publishingRunbook) &&
    publishingRunbook.includes('public repository'),
  'the public-repository version-PR credential requirement must be documented',
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
